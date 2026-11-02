# SSH setup & troubleshooting

## Authentication matrix

| Method | `ssh_connect` args | Notes |
| --- | --- | --- |
| Password | `auth: "password"`, `password` | Needs `PasswordAuthentication yes` on the server |
| Key file | `auth: "key"`, `private_key_path` | Preferred; key stays on the local disk |
| Inline key | `auth: "key"`, `private_key` | Paste PEM text; stored in local config |
| ssh-agent | `auth: "agent"` | Uses `SSH_AUTH_SOCK` and `~/.ssh/id_*` automatically |

Key permissions must be 600 (`ssh-keygen -t ed25519`, then
`ssh-copy-id user@host` to install the public key on the VM).

## Common failures

| Error | Cause | Fix |
| --- | --- | --- |
| `All configured authentication methods failed` | Wrong credentials / root login disabled | Check user+password; cloud VMs often need `PermitRootLogin yes` or a non-root sudo user |
| `Host key fingerprint changed!` | Server reinstall or MITM | Confirm with the user, then `update_host_key: true` |
| `ECONNREFUSED` | sshd not running / wrong port | `sudo systemctl start sshd`; check the VM's firewall/security group for port 22 |
| `ETIMEDOUT` | Network/firewall | Verify the host is reachable from this machine (`ping`/cloud firewall rules) |
| `Cannot read private key ...` | Bad path or permissions | Use an absolute path; `chmod 600 <key>` |
| `Encrypted private key detected` | Key needs passphrase | Pass `passphrase` |

## Non-interactive VMs (CI images)

Ensure sshd is installed and running on the VM:

```bash
sudo apt-get install -y openssh-server   # Debian/Ubuntu
sudo systemctl enable --now ssh
sudo mkdir -p /home/ubuntu/.ssh && echo '<pubkey>' | sudo tee -a /home/ubuntu/.ssh/authorized_keys
```

## Behavior details

- One persistent connection per alias with SSH keepalives; dropped sockets are
  re-established transparently on the next tool call.
- Every `run_cmd` is a fresh exec channel (no state carries over). Use
  `run_cmd` with `nohup ... &` or a service manager for long-lived processes.
- Secrets live only in `~/.deepseek-harness/config.json` (0600). `ssh_status`
  always masks them.
