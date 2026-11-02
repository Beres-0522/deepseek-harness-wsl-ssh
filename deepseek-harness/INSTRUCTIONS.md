# DeepSeek Harness

SSH 远程工作区插件：把任意 Linux 虚拟机/服务器变成 coding agent 的工作区。

## 能力

- **远程连接**：密码 / 私钥文件 / 内联私钥 / ssh-agent，TOFU 主机指纹校验，断线自动重连
- **远程工作区**：`workspace_open` 将远程目录绑定为本会话默认工作区，所有文件工具以它为根
- **Shell 执行**：`run_cmd` 返回 exit code + stdout/stderr，支持 cwd、环境变量、超时
- **文件操作**：`read_file` / `write_file` / `edit_file`（精确替换，需先 read）/ `list_dir` / `stat_file` / `mkdir` / `remove` / `move`
- **搜索**：`glob`（支持 `**`）、`grep`（递归、跳过 .git 与二进制）
- **双向传输**：`upload` / `download`（SFTP，目录递归）

## 使用入口

MCP server：`node server.bundle.mjs`（stdio），工具注册见 `.mcp.json`。
Agent 操作方法见 `skills/deepseek-harness/SKILL.md`。

凭据仅保存在本机 `~/.deepseek-harness/config.json`（0600），`ssh_status` 输出会脱敏。
