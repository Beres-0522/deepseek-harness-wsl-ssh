/**
 * Host half of the SSH workspace UI bundle.
 *
 * The browser panel talks to this half over a private RPC channel
 * (`/dsh-ssh/<endpoint>`), which `connection.rpc.handle` mounts behind the same
 * Host/Origin fence and browser authentication as `/api`.
 *
 * Every operation delegates to the MCP tools the agent already uses
 * (`mcp__deepseek-harness__*`) via the shared tool registry, so the UI drives
 * the SAME MCP server process the agent's file tools resolve against.
 */
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as pjoin } from "node:path";
import { createOps } from "./ops.js";

export const inject = ["tools", "connection", "webServer", "workspaceRegistry"];

// ---------------------------------------------------------------------------
// Sidebar workspace cards
//
// The harness workspace list binds sessions to LOCAL directories. To make a
// remote workspace visible there, every remote workspace gets a durable card:
//  - WSL targets map to the real \\wsl.localhost\<distro> UNC share (sessions
//    genuinely operate on the WSL files), detected via `wsl.exe --list`.
//  - Plain SSH targets get a staging folder (with a README) as the session
//    cwd; remote file work still flows through the MCP tools.
// Cards are matched by exact title `<WSL|SSH> · <alias>` and are idempotent.
// ---------------------------------------------------------------------------

let wslCache = { at: 0, distros: [] };

function execWslList() {
  return new Promise((resolve, reject) => {
    execFile("wsl.exe", ["--list", "--quiet"], { encoding: "buffer", timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function wslDistros() {
  if (Date.now() - wslCache.at < 60000) return wslCache.distros;
  try {
    const buf = await execWslList();
    const distros = buf
      .toString("utf16le")
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    wslCache = { at: Date.now(), distros };
  } catch {
    wslCache = { at: Date.now(), distros: [] };
  }
  return wslCache.distros;
}

/** Return the \\wsl.localhost UNC path for a remote dir, or null if absent. */
async function wslUncFor(remotePath) {
  if (typeof remotePath !== "string" || !remotePath.startsWith("/")) return null;
  const tail = remotePath.replaceAll("/", "\\");
  for (const distro of await wslDistros()) {
    const unc = `\\\\wsl.localhost\\${distro}${tail}`;
    try {
      const info = await stat(unc);
      if (info.isDirectory()) return unc;
    } catch {
      // try next distro
    }
  }
  return null;
}

function safeDirName(s) {
  return (String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64)) || "ws";
}

function cardTitle(proto, alias) {
  return `${proto} · ${alias}`;
}

function stagingReadme({ connection, remotePath, host }) {
  return [
    "# 远程工作区卡片 / Remote workspace card",
    "",
    `- 连接: ${connection}${host ? ` (${host})` : ""}`,
    `- 远程目录: ${remotePath}`,
    "",
    "这个文件夹是会话工作目录的占位（staging）。远程文件与命令请通过 agent 的",
    "`mcp__deepseek-harness__*` 工具操作；当前作用的工作区由「SSH 工作区」面板控制。",
    "",
    "This folder is the session cwd placeholder. Remote files/commands go through",
    "the agent's `mcp__deepseek-harness__*` tools; the active workspace is chosen",
    "in the SSH Workspace panel.",
    "",
  ].join("\n");
}

async function ensureCard(ctx, alias, ws, conn) {
  const unc = await wslUncFor(ws.remote_path);
  const proto = unc ? "WSL" : "SSH";
  const title = cardTitle(proto, alias);
  const listed = ctx.workspaceRegistry.list().find((w) => w.title === title);
  if (listed) return { title, id: listed.id, path: listed.path, created: false, proto };

  let path = unc;
  if (!path) {
    path = pjoin(homedir(), ".dsh-remote-workspaces", `${safeDirName(ws.connection)}__${safeDirName(alias)}`);
    await mkdir(path, { recursive: true });
    await writeFile(
      pjoin(path, "README.md"),
      stagingReadme({ connection: ws.connection, remotePath: ws.remote_path, host: conn ? `${conn.username}@${conn.host}:${conn.port ?? 22}` : "" }),
      "utf8",
    );
  }
  try {
    const byPath = await ctx.workspaceRegistry.resolveByPath(path);
    if (byPath) return { title: byPath.title ?? title, id: byPath.id, path, created: false, proto };
  } catch {
    // resolveByPath is best-effort; create may still succeed.
  }
  const created = await ctx.workspaceRegistry.create(path, title);
  return { title, id: created.id, path, created: true, proto };
}

async function syncCardsFromStatus(ctx, status) {
  const results = [];
  const workspaces = status && status.workspaces ? status.workspaces : {};
  for (const [alias, ws] of Object.entries(workspaces)) {
    if (!ws || typeof ws.remote_path !== "string") continue;
    try {
      results.push(await ensureCard(ctx, alias, ws, status.connections ? status.connections[ws.connection] : undefined));
    } catch (error) {
      results.push({ title: alias, error: String(error?.message || error) });
    }
  }
  return results;
}

const SERVER = "deepseek-harness";
const CHANNEL = "/dsh-ssh";

/** Unwrap a harness ToolExecutionResult into the MCP tool's JSON payload. */
function unwrapToolResult(result) {
  if (result == null) throw new Error("empty tool result");
  if (result.isError) {
    const text = textOf(result.content) || result.error?.message || "tool call failed";
    throw new Error(result.error?.message || text);
  }
  const value = result.value ?? result;
  if (value && Array.isArray(value.content)) {
    const text = textOf(value.content);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
  return value;
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** Whitelist and normalize the ssh_connect payload coming from the browser. */
function connectArgs(p) {
  const out = {
    name: str(p.name),
    host: str(p.host),
    username: str(p.username),
    auth: ["password", "key", "agent"].includes(p.auth) ? p.auth : "password",
  };
  if (!out.name || !out.host || !out.username) {
    throw new Error("name, host and username are required");
  }
  if (Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535) out.port = p.port;
  for (const key of ["password", "private_key_path", "private_key", "passphrase"]) {
    if (typeof p[key] === "string" && p[key] !== "") out[key] = p[key];
  }
  if (p.host_key_check === "off") out.host_key_check = "off";
  if (p.update_host_key === true) out.update_host_key = true;
  if (Number.isInteger(p.connect_timeout_seconds)) {
    out.connect_timeout_seconds = Math.min(120, Math.max(5, p.connect_timeout_seconds));
  }
  return out;
}

function requireAbsoluteDir(v, field) {
  const s = str(v);
  if (!s.startsWith("/") || s === "/") throw new Error(`${field} must be an absolute remote directory`);
  return s;
}

function requireName(v, field) {
  const s = str(v);
  if (!s) throw new Error(`${field} is required`);
  return s;
}

export function apply(ctx) {
  let seq = 0;
  const callTool = async (tool, args, signal) => {
    // ops.js passes the raw MCP tool name; the public registry name is
    // `mcp__<serverName>__<rawName>`.
    const result = await ctx.tools.execute({
      name: `mcp__${SERVER}__${tool}`,
      arguments: args,
      callId: `dsh-ssh-ui-${Date.now().toString(36)}-${(seq += 1)}`,
      signal: signal ?? new AbortController().signal,
    });
    return unwrapToolResult(result);
  };

  const ops = createOps((name, args, signal) => callTool(name, args, signal));

  const routes = {
    status: async (p, signal) => {
      const st = await ops.status(signal);
      // Keep the sidebar workspace cards in sync (best-effort, per-item).
      try {
        st.cards = await syncCardsFromStatus(ctx, st);
      } catch (error) {
        st.cardsError = String(error?.message || error);
      }
      return st;
    },
    cards: async (p, signal) => {
      const st = await ops.status(signal);
      return { cards: await syncCardsFromStatus(ctx, st) };
    },
    info: (p, signal) => ops.workspaceInfo(signal),
    connect: (p, signal) => ops.connect(connectArgs(p), signal),
    disconnect: (p, signal) => ops.disconnect(requireName(p.name, "name"), signal),
    remove: (p, signal) => ops.removeConnection(requireName(p.name, "name"), signal),
    browse: (p, signal) => {
      const connection = requireName(p.connection, "connection");
      const dir = str(p.dir);
      if (dir !== "." && dir !== "~" && !dir.startsWith("/")) {
        throw new Error('dir must be "." or an absolute remote path');
      }
      return ops.browse(connection, dir || ".", signal);
    },
    open: (p, signal) =>
      ops.openWorkspace(
        {
          name: requireName(p.name, "name"),
          connection: requireName(p.connection, "connection"),
          remote_path: requireAbsoluteDir(p.remote_path, "remote_path"),
          set_current: p.set_current !== false,
        },
        signal,
      ),
    close: (p, signal) => ops.closeWorkspace(requireName(p.name, "name"), signal),
  };

  const handler = async (endpoint, payload, signal) => {
    const route = routes[endpoint];
    if (!route) {
      return { ok: false, error: { code: "unknown-endpoint", message: `Unknown endpoint ${JSON.stringify(endpoint)}`, details: { issues: [] } } };
    }
    try {
      return { ok: true, value: await route(payload ?? {}, signal) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "dsh-ssh-ui/operation-failed",
          message: `${endpoint}: ${String(error?.message || error)}`,
          details: { issues: [] },
        },
      };
    }
  };

  // Mount the RPC channel directly on the web server. Authentication uses the
  // same Host/Origin + browser-session fence as `/api` (requestRejection =
  // connection.admit), and the wire envelope matches the client's
  // connection.rpc.call format ({type:"client-request"} → {type:"server-response"}).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/dsh-ssh",
        handler: async (req, res) => {
          const rejection = ctx.connection.requestRejection(req);
          if (rejection) {
            res.writeHead(rejection);
            res.end(rejection === 401 ? "unauthorized" : "forbidden");
            return;
          }
          let endpoint = "";
          try {
            endpoint = new URL(req.url, "http://dsh.local").pathname.slice("/dsh-ssh/".length);
          } catch {
            endpoint = "";
          }
          if (req.method !== "POST" || !/^[A-Za-z0-9_-]+$/.test(endpoint)) {
            res.writeHead(404);
            res.end("not found");
            return;
          }
          let rpcId = "ui";
          let payload = {};
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = Buffer.concat(chunks).toString("utf8");
            if (body) {
              const envelope = JSON.parse(body);
              if (typeof envelope.rpcId === "string") rpcId = envelope.rpcId;
              if (envelope.payload && typeof envelope.payload === "object") payload = envelope.payload;
            }
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "body is not JSON" }));
            return;
          }
          // The tool pipeline and the MCP SDK require a real AbortSignal.
          const ac = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) ac.abort();
          });
          const result = await handler(endpoint, payload, ac.signal);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "server-response", rpcId, result }));
        },
      }),
    "dsh-ssh-ui: rpc route",
  );
}
