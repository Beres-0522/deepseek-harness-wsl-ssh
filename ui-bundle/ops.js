/**
 * SSH workspace operations facade.
 *
 * Every operation is a thin wrapper over the MCP tools the agent already uses
 * (`mcp__deepseek-harness__*`), so the UI drives the SAME MCP server process —
 * connections, workspaces and `current_workspace` stay consistent between what
 * the user picks in the panel and what the agent's file tools resolve.
 *
 * createOps(callTool) is transport-agnostic: `callTool(tool, args)` must return
 * the unwrapped JSON payload of an MCP tool result, or throw an Error whose
 * message is safe to show to the user.
 */

const SERVER = "deepseek-harness";
const BROWSE_TIMEOUT = 20;

/** Single-quote shell escaping (matches the MCP server's own shquote). */
export function shquote(s) {
  if (!/^[A-Za-z0-9_\-.,:@%+/=]+$/.test(s)) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }
  return s;
}

/** Best-effort unwrap of a harness ToolExecutionResult into the MCP JSON payload. */
function unwrap(result) {
  if (result == null) throw new Error("Empty tool result");
  // Structured payloads first.
  if (typeof result === "object" && !Array.isArray(result)) {
    const blocks = result.content ?? result.outputContent;
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
        .map((b) => b.text)
        .join("\n");
      if (result.isError) throw new Error(text || "Tool reported an error");
      return parseMaybeJson(text, result);
    }
    if (typeof result.output === "string") {
      if (result.isError) throw new Error(result.output);
      return parseMaybeJson(result.output, result);
    }
    if (result.structuredContent != null) return result.structuredContent;
    // Some pipelines return the payload directly.
    if (
      result.content === undefined &&
      (result.connections != null || result.current_workspace !== undefined ||
        result.current != null || result.workspaces != null)
    ) {
      return result;
    }
  }
  return result;
}

function parseMaybeJson(text, fallback) {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function createOps(callTool) {
  // callTool(rawToolName, args, signal) composes the public registry name.
  const call = (tool, args = {}) => callTool(tool, args);

  return {
    /** ssh_status — connections (masked) + workspaces + current_workspace. */
    async status() {
      return unwrap(await call("ssh_status"));
    },

    /** workspace_current — current workspace detail + live pool states. */
    async workspaceInfo() {
      return unwrap(await call("workspace_current"));
    },

    /** ssh_connect — full connection input passes through. */
    async connect(input) {
      return unwrap(await call("ssh_connect", input));
    },

    async disconnect(name) {
      return unwrap(await call("ssh_disconnect", { name }));
    },

    async removeConnection(name) {
      return unwrap(await call("ssh_remove", { name }));
    },

    /**
     * Browse any absolute directory on a connection BEFORE a workspace exists,
     * via run_cmd with the `connection` parameter (no workspace needed).
     * Returns { path, entries: [{ name, dir }] }.
     */
    async browse(connection, dir) {
      const q = shquote(dir);
      const command =
        `cd ${q} 2>/dev/null || { echo __BH_ERR__; exit 0; }\n` +
        `printf '__BH_PWD__%s\\n' "$PWD"\n` +
        `ls -1Ap`;
      const r = unwrap(await call("run_cmd", {
        connection,
        command,
        timeout_seconds: BROWSE_TIMEOUT,
      }));
      const out = `${r.stdout ?? ""}`;
      if (out.includes("__BH_ERR__")) {
        throw new Error(`Cannot browse "${dir}": not a directory or permission denied`);
      }
      const pwdLine = out.split("\n").find((l) => l.startsWith("__BH_PWD__"));
      const path = pwdLine ? pwdLine.slice("__BH_PWD__".length).trim() : dir;
      const listing = out
        .split("\n")
        .filter((l) => l && !l.startsWith("__BH_PWD__"))
        .map((line) => ({
          name: line.endsWith("/") ? line.slice(0, -1) : line,
          dir: line.endsWith("/"),
        }));
      return { path, entries: listing };
    },

    /** workspace_open — validates the directory and returns a top-level listing. */
    async openWorkspace({ name, connection, remote_path, set_current = true }) {
      return unwrap(await call("workspace_open", { name, connection, remote_path, set_current }));
    },

    async closeWorkspace(name) {
      return unwrap(await call("workspace_close", { name }));
    },
  };
}
