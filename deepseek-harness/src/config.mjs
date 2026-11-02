import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".deepseek-harness");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const SECRET_FIELDS = new Set([
  "password",
  "private_key",
  "passphrase",
]);

const SECRET_PLACEHOLDER = "********";

function emptyConfig() {
  return {
    version: 1,
    connections: {},
    workspaces: {},
    host_keys: {},
    current_workspace: null,
  };
}

export class ConfigStore {
  constructor(path = CONFIG_PATH) {
    this.path = path;
    this.data = emptyConfig();
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return this;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      this.data = { ...emptyConfig(), ...parsed };
    } catch {
      this.data = emptyConfig();
    }
    this._loaded = true;
    return this;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = join(
      tmpdir(),
      `.deepseek-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  // ---- connections ----

  getConnection(name) {
    return this.data.connections[name] || null;
  }

  requireConnection(name) {
    const cfg = this.getConnection(name);
    if (!cfg) {
      throw new Error(
        `Unknown SSH connection "${name}". Available: ${Object.keys(this.data.connections).join(", ") || "(none)"}. Use ssh_connect first.`,
      );
    }
    return cfg;
  }

  putConnection(name, cfg) {
    this.data.connections[name] = cfg;
  }

  deleteConnection(name) {
    delete this.data.connections[name];
    for (const [wname, ws] of Object.entries(this.data.workspaces)) {
      if (ws.connection === name) delete this.data.workspaces[wname];
    }
    if (
      this.data.current_workspace &&
      !this.data.workspaces[this.data.current_workspace]
    ) {
      this.data.current_workspace = null;
    }
  }

  // ---- workspaces ----

  getWorkspace(name) {
    return this.data.workspaces[name] || null;
  }

  requireWorkspace(name = this.data.current_workspace) {
    if (!name) {
      const known = Object.keys(this.data.workspaces).join(", ") || "(none)";
      throw new Error(
        `No workspace specified and no current workspace set. Known workspaces: ${known}. Use workspace_open first.`,
      );
    }
    const ws = this.getWorkspace(name);
    if (!ws) {
      const known = Object.keys(this.data.workspaces).join(", ") || "(none)";
      throw new Error(`Unknown workspace "${name}". Known: ${known}.`);
    }
    return { name, ...ws };
  }

  putWorkspace(name, ws) {
    this.data.workspaces[name] = ws;
  }

  deleteWorkspace(name) {
    delete this.data.workspaces[name];
    if (this.data.current_workspace === name) this.data.current_workspace = null;
  }

  setCurrentWorkspace(name) {
    this.data.current_workspace = name;
  }

  // ---- host keys (TOFU) ----

  hostKeySlot(cfg) {
    return `${cfg.username}@${cfg.host}:${cfg.port || 22}`;
  }

  getHostKey(cfg) {
    return this.data.host_keys[this.hostKeySlot(cfg)] || null;
  }

  setHostKey(cfg, fingerprint) {
    this.data.host_keys[this.hostKeySlot(cfg)] = fingerprint;
  }

  // ---- masking for status output ----

  maskedConnection(cfg) {
    const out = {};
    for (const [k, v] of Object.entries(cfg)) {
      out[k] = SECRET_FIELDS.has(k)
        ? typeof v === "string" && v.length
          ? SECRET_PLACEHOLDER
          : v
        : v;
    }
    return out;
  }
}
