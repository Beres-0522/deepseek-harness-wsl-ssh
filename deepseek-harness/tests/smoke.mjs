// MCP stdio smoke-test client for the deepseek-harness server.
// Also serves as a minimal reference implementation of an MCP stdio client.
// Usage: node tests/smoke.mjs [port] [password]
// Prereqs: local sshd listening on [port] with root password auth,
//          and an empty writable directory /srv/harness-proj.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.argv[2] || "2222";
const PASS = process.argv[3] || "testpass123";
const HOME = mkdtempSync(join(tmpdir(), "dsh-test-"));
process.env.HOME = HOME; // isolate config.json

const proc = spawn("node", [new URL("../server.bundle.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
let nextId = 1;
const pending = new Map();

proc.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`timeout: ${method}`));
      }
    }, 90_000);
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function textOf(res) {
  if (res.error) throw new Error(`RPC error: ${JSON.stringify(res.error)}`);
  const c = res.result?.content?.[0];
  return c?.text ?? "";
}

function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : " :: " + extra}`);
  if (!cond) process.exitCode = 1;
}

async function call(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  const text = textOf(res);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { isError: !!res.result?.isError, text, parsed };
}

// ---- run ----
await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
notify("notifications/initialized", {});

const tools = await request("tools/list", {});
const names = tools.result.tools.map((t) => t.name);
check("tools/list returns 20 tools", names.length === 20, names.join(","));

const c1 = await call("ssh_connect", {
  name: "testvm",
  host: "127.0.0.1",
  port: Number(PORT),
  username: "root",
  auth: "password",
  password: PASS,
});
check("ssh_connect", !c1.isError && c1.parsed?.state === "connected", c1.text.slice(0, 300));

const c2 = await call("workspace_open", {
  name: "proj",
  connection: "testvm",
  remote_path: "/srv/harness-proj",
});
check("workspace_open", !c2.isError && c2.parsed?.workspace === "proj", c2.text.slice(0, 300));

const c3 = await call("write_file", {
  path: "src/hello.py",
  content: "def greet(name):\n    return f'hello {name}'\n",
});
check("write_file", !c3.isError && c3.parsed?.bytes > 0, c3.text.slice(0, 200));

const c4 = await call("read_file", { path: "src/hello.py" });
check(
  "read_file",
  !c4.isError && c4.parsed?.content?.includes("hello {name}") && c4.parsed?.total_lines === 2,
  c4.text.slice(0, 200),
);

const c5 = await call("edit_file", {
  path: "src/hello.py",
  old_string: "hello {name}",
  new_string: "HELLO {name}",
});
check("edit_file", !c5.isError && c5.parsed?.replaced === 1, c5.text.slice(0, 200));

const c6 = await call("edit_file", {
  path: "src/hello.py",
  old_string: "not-exist-anchor",
  new_string: "x",
});
check("edit_file rejects missing anchor", c6.isError, c6.text.slice(0, 120));

const c7 = await call("run_cmd", {
  command: `python3 -c "exec(open('src/hello.py').read()); print(greet('world'))"`,
});
check(
  "run_cmd sees edited file",
  !c7.isError && c7.parsed?.exit_code === 0 && c7.parsed?.stdout.includes("HELLO"),
  c7.text.slice(0, 200),
);

const c8 = await call("glob", { pattern: "src/**/*.py" });
check("glob", !c8.isError && c8.parsed?.matches?.[0] === "src/hello.py", c8.text.slice(0, 200));

await call("write_file", { path: "src/math.py", content: "x = 41 + 1\n" });
const c9 = await call("grep", { pattern: "41", path: "src", ignore_case: false });
check(
  "grep",
  !c9.isError && c9.parsed?.matches?.length === 1 && c9.parsed.matches[0].file.endsWith("math.py"),
  c9.text.slice(0, 250),
);

const c10 = await call("list_dir", { path: "src" });
check(
  "list_dir",
  !c10.isError && c10.parsed?.entries?.length === 2 && c10.parsed.entries[0].type === "file",
  c10.text.slice(0, 250),
);

// escape guard
const c11 = await call("read_file", { path: "../etc/passwd" });
check("path escape blocked", c11.isError, c11.text.slice(0, 150));

// remove guards
const c12 = await call("remove", { path: ".", recursive: true });
check("remove workspace root blocked", c12.isError, c12.text.slice(0, 150));

// transfer
const localDir = mkdtempSync(join(tmpdir(), "dsh-local-"));
writeFileSync(join(localDir, "up.txt"), "upload me");
const c13 = await call("upload", { local_path: join(localDir, "up.txt"), remote_path: "up.txt" });
check("upload", !c13.isError && c13.parsed?.items === 1, c13.text.slice(0, 200));
const c14 = await call("download", { remote_path: "src/hello.py" });
check(
  "download",
  !c14.isError &&
    existsSync("/workspace/hello.py") &&
    readFileSync("/workspace/hello.py", "utf8").includes("HELLO"),
  c14.text.slice(0, 200),
);

// status masking
const c15 = await call("ssh_status", {});
const statusText = c15.text;
check(
  "ssh_status masks secrets",
  !c15.isError && statusText.includes("testpass123") === false && statusText.includes("********"),
  "",
);

// second connection: bad password should fail cleanly
const c16 = await call("ssh_connect", {
  name: "bad",
  host: "127.0.0.1",
  port: Number(PORT),
  username: "root",
  auth: "password",
  password: "wrong-password",
});
check("bad password rejected", c16.isError, c16.text.slice(0, 150));

// cleanup remote + disconnect
await call("remove", { path: ".", recursive: true }).catch(() => {});
const c17 = await call("ssh_disconnect", { name: "testvm" });
check("ssh_disconnect", !c17.isError, c17.text.slice(0, 120));

const cfgPath = join(HOME, ".deepseek-harness", "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
check(
  "config persisted with workspace binding",
  cfg.connections.testvm?.auth === "password" && cfg.current_workspace === "proj",
  "",
);

proc.kill();
rmSync(HOME, { recursive: true, force: true });
console.log(`\nhome used: ${HOME} (removed)`);
process.exit(process.exitCode || 0);
