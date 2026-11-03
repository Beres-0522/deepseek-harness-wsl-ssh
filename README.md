# deepseek-harness-wsl-ssh

**DeepSeek Harness** — a Trae/MCP plugin that turns any remote Linux VM into a
coding-agent workspace over SSH: connect (password / private key / ssh-agent),
open a remote directory as the workspace, then run commands, read/write/edit
files, glob/grep, and upload/download — all through one persistent SSH connection.

## Quick start (any MCP client / harness)

Requirements: Node.js >= 20. No `npm install` needed — the server is prebuilt.

```jsonc
{
  "mcpServers": {
    "deepseek-harness": {
      "command": "node",
      "args": ["/path/to/deepseek-harness/server.bundle.mjs"]
    }
  }
}
```

`deepseek-harness-0.1.0.zip` at the repo root is the same plugin packaged for
Trae-style plugin directories (`.trae-plugin/plugin.json` + `.mcp.json` + skills).

## Typical session

1. `ssh_connect` — `{ name, host, port, username, auth: "password"|"key"|"agent", password? | private_key_path? }`
   Host keys are trusted on first use (TOFU); credentials are stored locally in
   `~/.deepseek-harness/config.json` (mode 0600, always masked in tool output).
2. `workspace_open` — bind an absolute remote directory (e.g. `/srv/app`) as the
   default root for all file tools and `run_cmd`.
3. Explore → edit → verify: `list_dir` / `glob` / `grep` / `read_file` →
   `write_file` / `edit_file` (exact string replace, requires prior read) →
   `run_cmd` (build/tests, exit code + stdout/stderr, timeout, env).
4. `upload` / `download` — recursive SFTP transfer between local and remote.

Full tool reference and agent operating guide: [INSTRUCTIONS.md](INSTRUCTIONS.md)
and [skills/deepseek-harness/SKILL.md](deepseek-harness/skills/deepseek-harness/SKILL.md).

## Repository layout

```
deepseek-harness/            plugin source (Trae plugin layout)
├── .mcp.json                MCP server declaration
├── server.bundle.mjs?       prebuilt server (run `npm run build` to regenerate)
├── src/                     ssh.mjs · fsops.mjs · config.mjs · glob.mjs · server.mjs
└── skills/                  agent usage guide + SSH troubleshooting references
tests/smoke.mjs              end-to-end smoke test (also a minimal MCP stdio client example)
```

## Rebuild & test

```bash
cd deepseek-harness && npm install && npm run build   # -> server.bundle.mjs
node tests/smoke.mjs <ssh-port> <password>            # full E2E against a local sshd
```

## Security notes

- Credentials never leave the machine running the MCP server; `ssh_status` masks them.
- Relative paths are sandboxed inside the workspace root; removing `/` or the
  workspace root is refused; host-key changes require explicit `update_host_key=true`.
