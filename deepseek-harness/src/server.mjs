import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { posix } from "node:path";
import { basename } from "node:path";
import { ConfigStore } from "./config.mjs";
import { ConnectionPool, shquote } from "./ssh.mjs";
import { RemoteFs } from "./fsops.mjs";

const RUN_STDOUT_CAP = 262_144;
const OUT_CAP = 262_144;

function capText(s, cap = OUT_CAP) {
  if (typeof s !== "string") return s;
  return s.length > cap ? `${s.slice(0, cap)}\n...[truncated ${s.length - cap} chars]` : s;
}

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  return {
    content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
    isError: true,
  };
}

function resolveWsPath(root, p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("path must be a non-empty string");
  if (p.startsWith("/")) return posix.normalize(p);
  const abs = posix.normalize(posix.join(root, p));
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new Error(`Relative path "${p}" escapes workspace root "${root}"`);
  }
  return abs;
}

export async function createDeepSeekHarnessServer(store = new ConfigStore()) {
  const server = new McpServer(
    { name: "deepseek-harness", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const pool = new ConnectionPool(store);
  const fs = new RemoteFs(pool);
  const readFiles = new Set(); // `${connection}\u0000${absPath}` touched by read_file

  await store.load();

  /** Resolve the (connection, absolute remote path) for a path argument. */
  function target(args, pathKey = "path") {
    const ws = store.requireWorkspace(args.workspace);
    const abs = resolveWsPath(ws.remote_path, args[pathKey]);
    return { connection: ws.connection, ws, abs };
  }

  function reg(name, description, schema, handler) {
    server.registerTool(
      name,
      { description, inputSchema: schema },
      async (args) => {
        try {
          return ok(await handler(args ?? {}));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // ------------------------------------------------------------------
  // Connection management
  // ------------------------------------------------------------------

  reg(
    "ssh_connect",
    "Register, test and save an SSH connection to a remote Linux host. " +
      'auth: "password" (password auth), "key" (private key via private_key_path or private_key), ' +
      '"agent" (ssh-agent / default keys). Host keys are trusted on first use (TOFU); a changed ' +
      "host key is rejected unless update_host_key=true. Credentials are stored locally in " +
      "~/.deepseek-harness/config.json with 0600 permissions.",
    z.object({
      name: z.string().min(1).describe("Short alias for this connection, e.g. \"myvm\""),
      host: z.string().min(1).describe("Hostname or IP"),
      port: z.number().int().min(1).max(65535).default(22),
      username: z.string().min(1),
      auth: z.enum(["password", "key", "agent"]).describe("Authentication method"),
      password: z.string().optional().describe("Password (auth=password only)"),
      private_key_path: z
        .string()
        .optional()
        .describe("Path to a local private key file (auth=key)"),
      private_key: z.string().optional().describe("Inline PEM private key (auth=key)"),
      passphrase: z.string().optional().describe("Passphrase for the private key, if any"),
      host_key_check: z
        .enum(["tofu", "off"])
        .default("tofu")
        .describe("tofu = trust on first use (recommended); off = accept any host key"),
      update_host_key: z
        .boolean()
        .default(false)
        .describe("Accept and store a new host key when the fingerprint changed"),
      connect_timeout_seconds: z.number().int().min(5).max(120).default(20),
    }),
    async (a) => {
      const cfg = {
        host: a.host,
        port: a.port,
        username: a.username,
        auth: a.auth,
        host_key_check: a.host_key_check,
        connect_timeout_seconds: a.connect_timeout_seconds,
      };
      if (a.password != null) cfg.password = a.password;
      if (a.private_key_path) cfg.private_key_path = a.private_key_path;
      if (a.private_key) cfg.private_key = a.private_key;
      if (a.passphrase) cfg.passphrase = a.passphrase;

      if (a.update_host_key) delete store.data.host_keys[store.hostKeySlot(cfg)];
      store.putConnection(a.name, cfg);
      await pool.disconnect(a.name);
      const entry = await pool.ensure(a.name);
      await store.save();
      const fingerprint = store.getHostKey(cfg);
      return {
        connection: a.name,
        host: `${a.username}@${a.host}:${a.port}`,
        auth: a.auth,
        state: entry.state,
        host_key_fingerprint_sha256: fingerprint || "(host key check disabled)",
        saved_to: store.path,
        note: "Use workspace_open to open a remote directory as a workspace.",
      };
    },
  );

  reg(
    "ssh_disconnect",
    "Close an active SSH connection (settings are kept in the local config).",
    z.object({ name: z.string().min(1).describe("Connection alias") }),
    async (a) => {
      await pool.disconnect(a.name);
      return { connection: a.name, state: "closed" };
    },
  );

  reg(
    "ssh_remove",
    "Remove an SSH connection and any workspaces using it (forgets stored credentials).",
    z.object({ name: z.string().min(1) }),
    async (a) => {
      if (!store.getConnection(a.name)) throw new Error(`Unknown connection "${a.name}"`);
      await pool.disconnect(a.name);
      store.deleteConnection(a.name);
      await store.save();
      return { connection: a.name, removed: true };
    },
  );

  reg(
    "ssh_status",
    "List saved SSH connections (secrets masked), their live state, all workspaces and the current workspace.",
    z.object({}),
    async () => ({
      config_path: store.path,
      current_workspace: store.data.current_workspace,
      connections: Object.fromEntries(
        Object.entries(store.data.connections).map(([name, cfg]) => [
          name,
          {
            ...store.maskedConnection(cfg),
            live: pool.status()[name] || { state: "idle" },
          },
        ]),
      ),
      workspaces: store.data.workspaces,
    }),
  );

  // ------------------------------------------------------------------
  // Workspace management
  // ------------------------------------------------------------------

  reg(
    "workspace_open",
    "Open a remote directory on an SSH connection as a named workspace. File tools (read_file, write_file, edit_file, list_dir, glob, grep, run_cmd, ...) operate on this directory with relative paths. Optionally makes it the current workspace.",
    z.object({
      name: z.string().min(1).describe("Workspace alias, e.g. \"app\""),
      connection: z.string().min(1).describe("SSH connection alias (see ssh_status)"),
      remote_path: z
        .string()
        .min(1)
        .describe("Absolute directory on the remote host, e.g. /srv/myapp"),
      set_current: z.boolean().default(true).describe("Make this the current workspace"),
    }),
    async (a) => {
      if (!store.getConnection(a.connection)) {
        throw new Error(`Unknown connection "${a.connection}". Use ssh_connect first.`);
      }
      if (!a.remote_path.startsWith("/")) {
        throw new Error(`remote_path must be absolute (got "${a.remote_path}")`);
      }
      const type = await fs.exists(a.connection, a.remote_path);
      if (!type) throw new Error(`Remote path not found: ${a.remote_path}`);
      if (type !== "d") throw new Error(`Remote path is not a directory: ${a.remote_path}`);
      store.putWorkspace(a.name, { connection: a.connection, remote_path: a.remote_path });
      if (a.set_current) store.setCurrentWorkspace(a.name);
      await store.save();
      const listing = await fs.listDir(a.connection, a.remote_path);
      return {
        workspace: a.name,
        connection: a.connection,
        remote_path: a.remote_path,
        current_workspace: store.data.current_workspace,
        top_level: listing.entries.map((e) => `${e.type === "dir" ? "d" : "-"} ${e.name}`),
      };
    },
  );

  reg(
    "workspace_current",
    "Show the current workspace (connection, remote root) and all known workspaces.",
    z.object({}),
    async () => {
      const cur = store.data.current_workspace;
      const detail = cur ? store.requireWorkspace(cur) : null;
      return {
        current: detail,
        workspaces: store.data.workspaces,
        connections_live: pool.status(),
      };
    },
  );

  reg(
    "workspace_close",
    "Forget a workspace mapping (files on the remote host are untouched).",
    z.object({ name: z.string().min(1) }),
    async (a) => {
      if (!store.getWorkspace(a.name)) throw new Error(`Unknown workspace "${a.name}"`);
      store.deleteWorkspace(a.name);
      await store.save();
      return { workspace: a.name, closed: true };
    },
  );

  // ------------------------------------------------------------------
  // Command execution
  // ------------------------------------------------------------------

  reg(
    "run_cmd",
    "Run a shell command on the remote host. Defaults to the current workspace as working directory. " +
      "stdout/stderr are capped; use timeout_seconds for long builds. Exit code and both streams are returned.",
    z.object({
      command: z.string().min(1).describe("Shell command to run (runs under the remote login shell)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory, relative to workspace root or absolute"),
      connection: z
        .string()
        .optional()
        .describe("Run on this connection instead of the workspace's connection"),
      workspace: z.string().optional().describe("Workspace to use (defaults to current)"),
      timeout_seconds: z.number().int().min(1).max(1800).default(120),
      env: z.record(z.string(), z.string()).optional().describe("Extra environment variables"),
    }),
    async (a) => {
      let conn;
      let cwdAbs = null;
      if (a.connection && a.workspace) {
        throw new Error("Pass either connection or workspace, not both");
      }
      if (a.connection) {
        conn = a.connection;
        cwdAbs = a.cwd ? resolveWsPath("/", a.cwd) : null;
      } else {
        const ws = store.requireWorkspace(a.workspace);
        conn = ws.connection;
        cwdAbs = a.cwd ? resolveWsPath(ws.remote_path, a.cwd) : ws.remote_path;
      }
      let prefix = "";
      if (cwdAbs) prefix += `cd ${shquote(cwdAbs)} || exit 127\n`;
      if (a.env) {
        for (const [k, v] of Object.entries(a.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
            throw new Error(`Invalid env var name: ${k}`);
          }
          prefix += `export ${k}=${shquote(v)}\n`;
        }
      }
      const r = await pool.exec(conn, `${prefix}${a.command}`, a.timeout_seconds * 1000);
      return {
        connection: conn,
        cwd: cwdAbs,
        exit_code: r.exit_code,
        timed_out: r.timed_out,
        stdout: capText(r.stdout, RUN_STDOUT_CAP),
        stderr: capText(r.stderr, RUN_STDOUT_CAP),
        duration_note: r.timed_out ? `killed after ${a.timeout_seconds}s` : null,
      };
    },
  );

  // ------------------------------------------------------------------
  // File tools (operate on the current/selected workspace)
  // ------------------------------------------------------------------

  reg(
    "list_dir",
    "List a directory in the workspace. Relative paths resolve against the workspace root; absolute remote paths are allowed.",
    z.object({
      path: z.string().default(".").describe("Directory to list (default: workspace root)"),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a);
      const res = await fs.listDir(t.connection, t.abs);
      return { workspace: t.ws.name, ...res };
    },
  );

  reg(
    "read_file",
    "Read a file from the workspace. Text mode returns content with optional line slicing; base64 mode returns raw bytes for binary files. edit_file requires this tool to have been called on the file first.",
    z.object({
      path: z.string().min(1),
      encoding: z.enum(["text", "base64"]).default("text"),
      line_offset: z.number().int().min(1).optional().describe("First line to return (1-based)"),
      line_limit: z.number().int().min(0).optional().describe("Number of lines to return"),
      max_bytes: z
        .number()
        .int()
        .min(1024)
        .max(4 * 1024 * 1024)
        .default(262144),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a);
      const res = await fs.readFile(t.connection, t.abs, {
        encoding: a.encoding,
        maxBytes: a.max_bytes,
        lineOffset: a.line_offset,
        lineLimit: a.line_limit,
      });
      readFiles.add(`${t.connection}\u0000${t.abs}`);
      return { workspace: t.ws.name, ...res };
    },
  );

  reg(
    "write_file",
    "Create or overwrite a file in the workspace (text or base64). Parent directories are created as needed.",
    z.object({
      path: z.string().min(1),
      content: z.string().min(0).describe("File content (text or base64 per encoding)"),
      encoding: z.enum(["text", "base64"]).default("text"),
      create_dirs: z.boolean().default(true),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a);
      const data =
        a.encoding === "base64" ? Buffer.from(a.content, "base64") : Buffer.from(a.content, "utf8");
      const res = await fs.writeFile(t.connection, t.abs, data, { createDirs: a.create_dirs });
      return { workspace: t.ws.name, ...res };
    },
  );

  reg(
    "edit_file",
    "Exact string replacement in a workspace file. old_string must match exactly and be unique unless replace_all=true. The file must be read with read_file first.",
    z.object({
      path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().default(false),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a);
      if (!readFiles.has(`${t.connection}\u0000${t.abs}`)) {
        throw new Error(
          `edit_file requires read_file on "${a.path}" first (avoid editing stale content).`,
        );
      }
      const res = await fs.readFile(t.connection, t.abs, { maxBytes: 4 * 1024 * 1024 });
      const content = res.content;
      const count = content.split(a.old_string).length - 1;
      if (count === 0) {
        throw new Error(`old_string not found in ${a.path} (file may have changed; re-read it)`);
      }
      if (count > 1 && !a.replace_all) {
        throw new Error(
          `old_string appears ${count} times in ${a.path}; make it unique or set replace_all=true`,
        );
      }
      const next = content.split(a.old_string).join(a.new_string);
      await fs.writeFile(t.connection, t.abs, Buffer.from(next, "utf8"), { createDirs: false });
      return {
        workspace: t.ws.name,
        path: t.abs,
        replaced: a.replace_all ? count : 1,
        occurrences: count,
        new_size: Buffer.byteLength(next),
      };
    },
  );

  reg(
    "glob",
    "Find files in the workspace by glob pattern (supports **, *, ?, [abc], {a,b}). Faster and cheaper than running find via run_cmd.",
    z.object({
      pattern: z.string().min(1).describe('e.g. "src/**/*.ts" or "*.md"'),
      path: z.string().default(".").describe("Search root (default: workspace root)"),
      limit: z.number().int().min(1).max(10000).default(1000),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a);
      const root = t.abs;
      const res = await fs.glob(t.connection, root, a.pattern, a.limit);
      return { workspace: t.ws.name, ...res };
    },
  );

  reg(
    "grep",
    "Search file contents in the workspace with grep (recursive, skips binaries and .git). Returns file/line/text matches.",
    z.object({
      pattern: z.string().min(1).describe("Extended regex pattern"),
      path: z.string().default(".").describe("Search root (default: workspace root)"),
      glob: z
        .string()
        .optional()
        .describe('Limit to files matching this glob, e.g. "*.py" or "*.{ts,tsx}"'),
      ignore_case: z.boolean().default(false),
      max_results: z.number().int().min(1).max(5000).default(200),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a);
      const res = await fs.grep(t.connection, t.ws.remote_path, a.pattern, {
        glob: a.glob,
        ignoreCase: a.ignore_case,
        maxResults: a.max_results,
        path: t.abs,
      });
      return { workspace: t.ws.name, ...res };
    },
  );

  reg(
    "stat_file",
    "Return type, size, mtime and permissions of a workspace path.",
    z.object({ path: z.string().min(1), workspace: z.string().optional() }),
    async (a) => {
      const t = target(a);
      return { workspace: t.ws.name, ...(await fs.stat(t.connection, t.abs)) };
    },
  );

  reg(
    "mkdir",
    "Create a directory (and parents) in the workspace.",
    z.object({ path: z.string().min(1), workspace: z.string().optional() }),
    async (a) => {
      const t = target(a);
      return { workspace: t.ws.name, ...(await fs.mkdir(t.connection, t.abs)) };
    },
  );

  reg(
    "remove",
    "Delete a file, or a directory with recursive=true. Refuses to remove / or the workspace root itself.",
    z.object({
      path: z.string().min(1),
      recursive: z.boolean().default(false),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a);
      const norm = t.abs.replace(/\/+$/, "") || "/";
      if (norm === t.ws.remote_path.replace(/\/+$/, "")) {
        throw new Error("Refusing to remove the workspace root; use workspace_close instead");
      }
      return { workspace: t.ws.name, ...(await fs.remove(t.connection, t.abs, { recursive: a.recursive })) };
    },
  );

  reg(
    "move",
    "Move or rename a file/directory inside the remote host (uses mv).",
    z.object({
      source: z.string().min(1),
      destination: z.string().min(1),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const ws = store.requireWorkspace(a.workspace);
      const src = resolveWsPath(ws.remote_path, a.source);
      const dst = resolveWsPath(ws.remote_path, a.destination);
      return { workspace: ws.name, ...(await fs.move(ws.connection, src, dst)) };
    },
  );

  // ------------------------------------------------------------------
  // Transfer between the local machine and the remote workspace
  // ------------------------------------------------------------------

  reg(
    "upload",
    "Upload a local file or directory (recursively) into the remote workspace via SFTP.",
    z.object({
      local_path: z.string().min(1).describe("Local path (e.g. under /workspace)"),
      remote_path: z
        .string()
        .optional()
        .describe("Remote destination (default: workspace root / basename of local path)"),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const ws = store.requireWorkspace(a.workspace);
      const dest = a.remote_path
        ? resolveWsPath(ws.remote_path, a.remote_path)
        : `${ws.remote_path.replace(/\/$/, "")}/${basename(a.local_path)}`;
      return { workspace: ws.name, ...(await fs.upload(ws.connection, a.local_path, dest)) };
    },
  );

  reg(
    "download",
    "Download a remote workspace file or directory (recursively) to the local machine via SFTP.",
    z.object({
      remote_path: z.string().min(1),
      local_path: z
        .string()
        .optional()
        .describe("Local destination (default: /workspace/<basename>)"),
      workspace: z.string().optional(),
    }),
    async (a) => {
      const t = target(a, "remote_path");
      const local = a.local_path || `/workspace/${basename(t.abs)}`;
      return { workspace: t.ws.name, ...(await fs.download(t.connection, t.abs, local)) };
    },
  );

  return server;
}
