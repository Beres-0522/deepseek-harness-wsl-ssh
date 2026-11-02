import { Client } from "ssh2";
import { readFileSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

export class SshError extends Error {
  constructor(message) {
    super(message);
    this.name = "SshError";
  }
}

function shquote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export class ConnectionPool {
  constructor(store) {
    this.store = store;
    this.entries = new Map();
  }

  _entry(name) {
    let e = this.entries.get(name);
    if (!e) {
      e = {
        name,
        client: null,
        state: "closed",
        lastError: null,
        connectedAt: null,
        connecting: null,
      };
      this.entries.set(name, e);
    }
    return e;
  }

  status() {
    const out = {};
    for (const [name, e] of this.entries) {
      out[name] = {
        state: e.state,
        connected_at: e.connectedAt ? new Date(e.connectedAt).toISOString() : null,
        last_error: e.lastError,
      };
    }
    return out;
  }

  isLive(name) {
    const e = this.entries.get(name);
    return !!(e && e.client && e.state === "connected");
  }

  async disconnect(name) {
    const e = this.entries.get(name);
    if (!e) return;
    if (e.connecting) {
      try {
        await e.connecting;
      } catch {
        /* ignore */
      }
    }
    if (e.client) {
      try {
        e.client.end();
      } catch {
        /* ignore */
      }
    }
    e.client = null;
    e.sftp = null;
    e.state = "closed";
    e.connecting = null;
  }

  async _connectOnce(name, cfg) {
    const e = this._entry(name);
    if (e.connecting) return e.connecting;
    e.connecting = this._doConnect(name, cfg).finally(() => {
      e.connecting = null;
    });
    return e.connecting;
  }

  _doConnect(name, cfg) {
    const e = this._entry(name);
    if (e.client) {
      try {
        e.client.end();
      } catch {
        /* ignore */
      }
      e.client = null;
      e.sftp = null;
    }
    const client = new Client();
    e.client = client;
    e.state = "connecting";
    e.lastError = null;

    const auth = this._authOptions(cfg);
    const check = cfg.host_key_check === "off" ? "off" : "tofu";
    const stored = check === "off" ? null : this.store.getHostKey(cfg);
    let seenFingerprint = null;
    let mismatch = false;

    const timeoutMs = Math.min(
      Math.max(Number(cfg.connect_timeout_seconds || 20), 5),
      120,
    ) * 1000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        e.state = "error";
        e.lastError = err?.message || String(err);
        const extra =
          mismatch && stored
            ? ` Host key fingerprint changed! Expected ${stored}, got ${seenFingerprint}. If this is intentional, call ssh_connect again with update_host_key=true.`
            : "";
        client.end();
        reject(new SshError(`SSH connect to ${name} (${cfg.username}@${cfg.host}:${cfg.port || 22}) failed: ${err?.message || err}${extra}`));
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        e.state = "connected";
        e.connectedAt = Date.now();
        e.lastError = null;
        if (check !== "off" && seenFingerprint) this.store.setHostKey(cfg, seenFingerprint);
        resolve(e);
      };

      client.on("ready", ok);
      client.on("error", fail);
      client.on("close", () => {
        if (e.state === "connected") e.state = "closed";
        if (!settled) fail(new SshError("Connection closed during handshake"));
      });

      const conf = {
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        readyTimeout: timeoutMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        ...auth,
      };
      if (check !== "off") {
        conf.hostHash = "sha256";
        conf.hostVerifier = (hex) => {
          seenFingerprint = hex;
          if (!stored) return true; // TOFU: trust on first use
          if (stored === hex) return true;
          mismatch = true;
          return false;
        };
      }
      try {
        client.connect(conf);
      } catch (err) {
        fail(err);
      }
    });
  }

  _authOptions(cfg) {
    switch (cfg.auth) {
      case "password": {
        if (!cfg.password) throw new SshError('auth="password" requires a password');
        return { password: cfg.password };
      }
      case "key": {
        const opts = {};
        let pem = cfg.private_key;
        if (!pem && cfg.private_key_path) {
          try {
            pem = readFileSync(cfg.private_key_path);
          } catch (err) {
            throw new SshError(`Cannot read private key "${cfg.private_key_path}": ${err.message}`);
          }
        }
        if (!pem) throw new SshError('auth="key" requires private_key or private_key_path');
        opts.privateKey = pem;
        if (cfg.passphrase) opts.passphrase = cfg.passphrase;
        return opts;
      }
      case "agent":
      case "auto": {
        // ssh2 tries the ssh-agent (SSH_AUTH_SOCK) and default keys automatically.
        return {};
      }
      default:
        throw new SshError(`Unsupported auth type: ${cfg.auth}`);
    }
  }

  /** Get a live connection entry; reconnects when needed. */
  async ensure(name) {
    const cfg = this.store.requireConnection(name);
    const e = this._entry(name);
    if (e.client && e.state === "connected") return e;
    try {
      await this._connectOnce(name, cfg);
    } catch (err) {
      // one immediate retry for transient handshake failures
      await new Promise((r) => setTimeout(r, 300));
      await this._connectOnce(name, cfg).catch((err2) => {
        throw err2;
      });
    }
    return e;
  }

  /** Run a command; returns { exit_code, signal, timed_out, stdout, stderr }. */
  async exec(name, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const capped = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
    try {
      return await this._execOnce(name, command, capped);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/not connected|ECONNRESET|EPIPE|Socket closed|connection lost/i.test(msg)) {
        await this.disconnect(name);
        await this.ensure(name);
        return await this._execOnce(name, command, capped);
      }
      throw err;
    }
  }

  async _execOnce(name, command, timeoutMs) {
    const e = await this.ensure(name);
    return await new Promise((resolve, reject) => {
      e.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        const out = [];
        const errc = [];
        let exit_code = null;
        let signal = null;
        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.signal?.("KILL");
          } catch {
            /* ignore */
          }
          try {
            stream.close();
          } catch {
            /* ignore */
          }
        }, timeoutMs);
        const finish = (payload) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve(payload);
        };
        stream.on("data", (d) => out.push(d));
        stream.stderr.on("data", (d) => errc.push(d));
        stream.on("exit", (code, sig) => {
          exit_code = typeof code === "number" ? code : null;
          signal = sig || null;
        });
        stream.on("close", () => {
          finish({
            exit_code,
            signal,
            timed_out: timedOut,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(errc).toString("utf8"),
          });
        });
        stream.on("error", (err2) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err2);
          }
        });
      });
    });
  }

  /** Run a simple command that must exit 0; returns trimmed stdout. */
  async execOk(name, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const r = await this.exec(name, command, timeoutMs);
    if (r.exit_code !== 0) {
      const tail = (r.stderr || r.stdout || "").trim();
      throw new SshError(
        `Remote command failed (exit ${r.exit_code}): ${command}\n${tail.slice(0, 2000)}${r.timed_out ? " (timed out)" : ""}`,
      );
    }
    return r.stdout;
  }

  async getSftp(name) {
    const e = await this.ensure(name);
    if (e.sftp) return e.sftp;
    e.sftp = await new Promise((resolve, reject) => {
      e.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    e.sftp.on?.("close", () => {
      if (e.sftp) e.sftp = null;
    });
    e.sftp.on?.("error", () => {
      e.sftp = null;
    });
    return e.sftp;
  }

}

export { shquote };
