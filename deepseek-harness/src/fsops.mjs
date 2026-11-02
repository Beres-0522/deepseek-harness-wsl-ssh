import { stat, readdir } from "node:fs/promises";
import { basename, join, resolve as resolveLocal } from "node:path";
import { SshError, shquote } from "./ssh.mjs";

const MAX_LIST = 5000;

function p(sftp, method) {
  return (...args) =>
    new Promise((res, rej) =>
      sftp[method](...args, (err, ...out) => (err ? rej(err) : res(...out))),
    );
}

async function mkdirpRemote(sftp, dir) {
  if (dir === "/" || dir === ".") return;
  const lstatP = p(sftp, "lstat");
  const mkdirP = p(sftp, "mkdir");
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += `/${part}`;
    let type = null;
    try {
      const s = await lstatP(cur);
      type = s.isDirectory() ? "d" : "f";
    } catch {
      type = null;
    }
    if (type === "d") continue;
    if (type === "f") {
      throw new SshError(`Cannot mkdir: "${cur}" exists and is not a directory`);
    }
    try {
      await mkdirP(cur);
    } catch {
      /* created concurrently or already exists; final state verified by caller */
    }
  }
}

async function listDirRecursiveSftp(sftp, root, base, out) {
  if (out.length >= MAX_LIST) return;
  const readdirP = p(sftp, "readdir");
  const entries = await readdirP(root).catch(() => []);
  for (const ent of entries) {
    if (out.length >= MAX_LIST) return;
    const rel = base ? `${base}/${ent.filename}` : ent.filename;
    const abs = `${root}/${ent.filename}`;
    const isDir = typeof ent.attrs?.isDirectory === "function" && ent.attrs.isDirectory();
    if (isDir) {
      out.push({ path: rel, type: "dir" });
      await listDirRecursiveSftp(sftp, abs, rel, out);
    } else {
      out.push({ path: rel, type: "file", size: ent.attrs?.size ?? null });
    }
  }
}

export class RemoteFs {
  constructor(pool) {
    this.pool = pool;
  }

  async stat(connection, path) {
    const sftp = await this.pool.getSftp(connection);
    try {
      const s = await p(sftp, "stat")(path);
      return {
        path,
        type: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
        size: s.size,
        mtime: new Date(s.mtime * 1000).toISOString(),
        mode: `0${(s.mode & 0o7777).toString(8)}`,
        owner: `${s.uid}:${s.gid}`,
      };
    } catch (err) {
      throw new SshError(`stat ${path}: ${err.message}`);
    }
  }

  /** Returns "d" | "f" | "l" for existing paths, null when missing. */
  async exists(connection, path) {
    const sftp = await this.pool.getSftp(connection);
    try {
      const s = await p(sftp, "lstat")(path);
      if (s.isDirectory()) return "d";
      if (typeof s.isSymbolicLink === "function" && s.isSymbolicLink()) return "l";
      return "f";
    } catch (err) {
      if (err?.code === 2 || /no such file/i.test(err?.message || "")) return null;
      throw err;
    }
  }

  async listDir(connection, path) {
    const sftp = await this.pool.getSftp(connection);
    let entries;
    try {
      entries = await p(sftp, "readdir")(path);
    } catch (err) {
      throw new SshError(`list ${path}: ${err.message}`);
    }
    const out = entries.slice(0, MAX_LIST).map((e) => ({
      name: e.filename,
      type:
        typeof e.attrs?.isDirectory === "function" && e.attrs.isDirectory()
          ? "dir"
          : typeof e.attrs?.isSymbolicLink === "function" && e.attrs.isSymbolicLink()
            ? "symlink"
            : "file",
      size: e.attrs?.size ?? null,
      mtime: e.attrs?.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null,
    }));
    out.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    return { path, entries: out, truncated: entries.length > MAX_LIST };
  }

  async readFile(
    connection,
    path,
    { encoding = "text", maxBytes = 262144, lineOffset = null, lineLimit = null } = {},
  ) {
    const sftp = await this.pool.getSftp(connection);
    let s;
    try {
      s = await p(sftp, "stat")(path);
    } catch (err) {
      throw new SshError(`read ${path}: ${err.message}`);
    }
    if (s.isDirectory()) throw new SshError(`${path} is a directory`);
    const cap = Math.min(Math.max(maxBytes, 1024), 4 * 1024 * 1024);
    const size = s.size;
    const stream = sftp.createReadStream(path, { start: 0, end: Math.min(size, cap) - 1 });
    const chunks = [];
    await new Promise((res, rej) => {
      stream.on("data", (d) => chunks.push(d));
      stream.on("end", res);
      stream.on("error", rej);
    });
    const buf = Buffer.concat(chunks);
    if (encoding === "base64") {
      return {
        path,
        encoding: "base64",
        data: buf.toString("base64"),
        size,
        truncated: size > buf.length,
      };
    }
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    // drop trailing empty element from final newline for line math
    if (lines.length && lines[lines.length - 1] === "" && !size) lines.pop();
    const totalLines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const off = Math.max(Number(lineOffset ?? 1), 1);
    const lim = lineLimit == null ? lines.length : Math.max(Number(lineLimit), 0);
    const slice = lines.slice(off - 1, off - 1 + lim);
    const content = slice.join("\n");
    return {
      path,
      encoding: "text",
      content,
      size,
      total_lines: totalLines,
      returned_lines: { offset: off, count: slice.length },
      truncated: size > cap || (lineLimit != null && off - 1 + lim < totalLines),
    };
  }

  async writeFile(connection, path, data, { createDirs = true } = {}) {
    const sftp = await this.pool.getSftp(connection);
    if (createDirs) {
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      await mkdirpRemote(sftp, dir);
    }
    await new Promise((res, rej) => {
      const ws = sftp.createWriteStream(path);
      ws.on("close", res);
      ws.on("error", rej);
      ws.end(data);
    });
    return { path, bytes: data.length };
  }

  async glob(connection, root, pattern, limit = 1000) {
    const { globToRegExp, globHasDoubleStar, globDepth } = await import("./glob.mjs");
    const match = globToRegExp(pattern);
    const capped = Math.min(Math.max(limit, 1), 10000);
    let cmd = `find ${shquote(root)}`;
    if (!globHasDoubleStar(pattern)) {
      const d = globDepth(pattern) + 2; // headroom for symlinked dirs
      cmd += ` -maxdepth ${d}`;
    }
    cmd += ` \\( -type f -o -type l \\) -print 2>/dev/null | head -c 8388608`;
    const stdout = await this.pool.execOk(connection, cmd, 120_000);
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const out = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const rel = line.startsWith(prefix) ? line.slice(prefix.length) : line;
      if (match(rel)) {
        out.push(rel);
        if (out.length >= capped) break;
      }
    }
    return { root, pattern, matches: out, truncated: out.length >= capped };
  }

  async grep(
    connection,
    root,
    pattern,
    { glob = null, ignoreCase = false, maxResults = 200, path = root } = {},
  ) {
    const capped = Math.min(Math.max(maxResults, 1), 5000);
    const flags = ["-rIn", "--binary-files=without-match", "--exclude-dir=.git"];
    if (ignoreCase) flags.push("-i");
    if (glob) for (const g of String(glob).split(",")) flags.push(`--include=${shquote(g.trim())}`);
    const cmd = `grep ${flags.join(" ")} -e ${shquote(pattern)} ${shquote(path)} 2>/dev/null | head -n ${capped + 1} | head -c 8388608`;
    const r = await this.pool.exec(connection, cmd, 120_000);
    const out = [];
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const i = line.indexOf(":");
      if (i < 0) continue;
      const rest = line.slice(i + 1);
      const j = rest.indexOf(":");
      if (j < 0) continue;
      out.push({ file: line.slice(0, i), line: Number(rest.slice(0, j)), text: rest.slice(j + 1) });
      if (out.length >= capped) break;
    }
    if (!out.length && r.exit_code >= 2 && r.stderr.trim()) {
      throw new SshError(`grep failed: ${r.stderr.trim().slice(0, 500)}`);
    }
    return {
      pattern,
      path,
      matches: out,
      truncated: r.stdout.length >= 8388608 || out.length >= capped,
    };
  }

  async mkdir(connection, path) {
    const sftp = await this.pool.getSftp(connection);
    await mkdirpRemote(sftp, path);
    return { path, created: true };
  }

  /** Remove via `rm -rf`/`rm -f` with guard checks against dangerous targets. */
  async remove(connection, path, { recursive = false } = {}) {
    const st = await this.exists(connection, path);
    if (!st) return { path, removed: false };
    const normalized = path.replace(/\/+$/, "") || "/";
    if (normalized === "/" || normalized === "" || normalized === ".") {
      throw new SshError(`Refusing to remove "${path}": dangerous target`);
    }
    if (st === "d" && !recursive) {
      throw new SshError(`"${path}" is a directory; pass recursive=true to remove it`);
    }
    const flag = st === "d" ? "-rf" : "-f";
    const r = await this.pool.exec(connection, `rm ${flag} -- ${shquote(normalized)}`, 300_000);
    if (r.exit_code !== 0) {
      throw new SshError(`rm failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    }
    return { path, removed: true };
  }

  async move(connection, source, destination) {
    const cmd = `mv -f -- ${shquote(source)} ${shquote(destination)}`;
    const r = await this.pool.exec(connection, cmd, 300_000);
    if (r.exit_code !== 0) {
      throw new SshError(`mv failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    }
    return { source, destination, moved: true };
  }

  async upload(connection, localPath, remotePath) {
    const abs = resolveLocal(localPath);
    const sftp = await this.pool.getSftp(connection);
    const st = await stat(abs);
    const count = await this._put(sftp, abs, remotePath, st.isDirectory());
    return { local_path: abs, remote_path: remotePath, items: count };
  }

  async _put(sftp, abs, remotePath, isDir) {
    if (!isDir) {
      const dir = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";
      await mkdirpRemote(sftp, dir);
      await new Promise((res, rej) =>
        sftp.fastPut(abs, remotePath, (err) => (err ? rej(err) : res())),
      );
      return 1;
    }
    await mkdirpRemote(sftp, remotePath);
    let n = 0;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const ent of entries) {
      n += await this._put(
        sftp,
        join(abs, ent.name),
        `${remotePath.replace(/\/$/, "")}/${ent.name}`,
        ent.isDirectory(),
      );
    }
    return n;
  }

  async download(connection, remotePath, localPath) {
    const sftp = await this.pool.getSftp(connection);
    const type = await this.exists(connection, remotePath);
    if (!type) throw new SshError(`Remote path not found: ${remotePath}`);
    const { mkdir: mkdirLocal } = await import("node:fs/promises");
    if (type === "d") {
      await mkdirLocal(localPath, { recursive: true });
      const items = [];
      await listDirRecursiveSftp(sftp, remotePath.replace(/\/$/, ""), "", items);
      const files = items.filter((i) => i.type === "file");
      const prefix = remotePath.replace(/\/$/, "");
      for (const f of files) {
        const target = join(localPath, f.path);
        await mkdirLocal(target.slice(0, target.lastIndexOf("/")), { recursive: true });
        await new Promise((res, rej) =>
          sftp.fastGet(`${prefix}/${f.path}`, target, (err) => (err ? rej(err) : res())),
        );
      }
      return { remote_path: remotePath, local_path: localPath, items: files.length };
    }
    await mkdirLocal(localPath.slice(0, localPath.lastIndexOf("/")) || ".", { recursive: true });
    await new Promise((res, rej) =>
      sftp.fastGet(remotePath, localPath, (err) => (err ? rej(err) : res())),
    );
    return { remote_path: remotePath, local_path: localPath, items: 1 };
  }
}

export { basename };
