---
name: deepseek-harness
description: Operate a remote Linux host over SSH as a coding-agent workspace. Use when the user asks to connect to a VM/server via SSH, open a remote directory as a workspace, run commands on a remote machine, or read/edit/search/upload/download files on a remote Linux host. Covers connection management (password / private key / ssh-agent), workspace binding, the explore-edit-verify loop, and local↔remote transfers.
description_zh: 通过 SSH 把远程 Linux 主机当作编码代理的工作区来操作。当用户要求连接虚拟机/服务器、把远程目录作为工作区、在远程机器上执行命令或读写/搜索/上传/下载远程文件时使用。涵盖连接管理（密码/私钥/ssh-agent）、工作区绑定、探索-修改-验证循环与本地↔远程传输。
description_en: Operate a remote Linux host over SSH as a coding-agent workspace: connect (password/key/agent), open a remote directory as workspace, run commands, read/edit/search files, and upload/download between local and remote.
version: "0.1.0"
---

# DeepSeek Harness — remote SSH workspace

This plugin turns a remote Linux VM into your working environment. All file and
command tools operate on the remote host over one persistent SSH connection;
secrets stay in `~/.deepseek-harness/config.json` (mode 0600, local only).

## Tool map

| Stage | Tools |
| --- | --- |
| Connect | `ssh_connect`, `ssh_status`, `ssh_disconnect`, `ssh_remove` |
| Workspace | `workspace_open`, `workspace_current`, `workspace_close` |
| Shell | `run_cmd` (exit code + stdout/stderr, timeout, env) |
| Files | `list_dir`, `read_file`, `write_file`, `edit_file`, `stat_file`, `mkdir`, `remove`, `move` |
| Search | `glob` (filenames, `**` supported), `grep` (contents, skips `.git` and binaries) |
| Transfer | `upload` (local→remote), `download` (remote→local, both recursive) |

## Operating loop

1. **Connect** — `ssh_connect` with the user's host/credentials. If authentication
   fails, report the exact server error and ask for corrected credentials; never
   retry with guessed passwords. Host keys are trusted on first use; a changed
   fingerprint must be confirmed by the user before passing `update_host_key=true`.
2. **Open the workspace** — `workspace_open` with an absolute remote directory
   (e.g. `/srv/myapp`). This becomes the default root for every file tool and for
   `run_cmd`. Confirm the top-level listing back to the user.
3. **Explore before acting** — `list_dir` + `glob` for structure, `grep` for
   symbols/strings, `read_file` for content. Prefer these over `run_cmd`
   (`find`/`cat`) — they are structured and capped.
4. **Edit** — `write_file` for new/whole files; `edit_file` for surgical changes
   (requires a prior `read_file` of that file so anchors are fresh).
5. **Verify** — `run_cmd` for build/tests/linters (`npm test`, `pytest`, `go build ./...`).
   Read the exit code, not just stdout. Iterate until green.
6. **Transfer when needed** — `download` results to the local machine or `upload`
   local assets. `download` defaults to `/workspace/<basename>` locally.

## Rules

- Relative paths always resolve inside the workspace root; escaping with `..` is
  blocked. Absolute remote paths are allowed for system files.
- Destructive ops (`remove` with `recursive=true`) require a stated reason and a
  target that is clearly inside the workspace. The root itself is protected.
- Long jobs: set `timeout_seconds` on `run_cmd` (max 1800) instead of letting them
  time out silently.
- Binary files: read/write with `encoding="base64"`.
- If a command reports `SSH connect ... failed: Host key fingerprint changed`,
  stop and ask the user; only proceed with `update_host_key=true` after they confirm.

## Credentials

- `password` — password auth; ask the user if not provided.
- `key` — `private_key_path` (local file, preferred) or inline `private_key`.
- `agent` — ssh-agent via `SSH_AUTH_SOCK` or default `~/.ssh` keys.

For troubleshooting and non-interactive setups (cloud VMs, jump hosts), read
`references/ssh-setup.md`. For a worked end-to-end example session, read
`references/example-session.md`.
