/**
 * Client half: a "SSH Workspace" sidebar entry + central panel rendered inside
 * the app shell. All operations go through the plugin's Host RPC channel,
 * which executes the shared MCP tools, so what the user picks here is exactly
 * what the agent's file tools resolve.
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-ssh-ui",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const NS = "sshWorkspace";
    const PANEL_ID = "ssh-workspace";
    const CHANNEL = "/dsh-ssh";

    const zh = {
      panel: "SSH 工作区",
      title: "SSH 远程工作区",
      subtitle: "连接远程主机，选择 agent 的工作目录。",
      statusIdle: "当前没有工作区",
      sectionConnections: "连接",
      sectionWorkspaces: "工作区",
      sectionBrowser: "浏览",
      newConnection: "新建连接",
      connect: "连接",
      connecting: "连接中…",
      disconnect: "断开",
      remove: "删除",
      browse: "浏览",
      fieldName: "别名",
      fieldHost: "主机",
      fieldPort: "端口",
      fieldUsername: "用户名",
      fieldAuth: "认证方式",
      authPassword: "密码",
      authKey: "私钥",
      authAgent: "ssh-agent",
      fieldPassword: "密码",
      fieldKeyPath: "私钥文件路径",
      fieldKeyInline: "内联私钥（PEM）",
      fieldPassphrase: "私钥口令",
      fieldHostKey: "主机指纹校验",
      hostKeyTofu: "TOFU（推荐）",
      hostKeyOff: "关闭",
      fieldTimeout: "超时（秒）",
      up: "上级",
      refresh: "刷新",
      openAsWorkspace: "设为工作区",
      workspaceAlias: "工作区别名",
      set: "设为当前",
      forget: "取消",
      nothingYet: "暂无内容。",
      busy: "处理中…",
      current: "当前",
      live: "已连接",
      idle: "空闲",
      entriesCount: "项",
      emptyDir: "空目录",
      goHome: "主目录",
      goRoot: "根目录",
      confirmRemove: "删除连接会同时删除其工作区并忘记凭据，确定吗？",
    };
    const en = {
      panel: "SSH Workspace",
      title: "SSH Remote Workspace",
      subtitle: "Connect a remote host and choose the directory the agent works in.",
      statusIdle: "No current workspace",
      sectionConnections: "Connections",
      sectionWorkspaces: "Workspaces",
      sectionBrowser: "Browse",
      newConnection: "New connection",
      connect: "Connect",
      connecting: "Connecting…",
      disconnect: "Disconnect",
      remove: "Remove",
      browse: "Browse",
      fieldName: "Alias",
      fieldHost: "Host",
      fieldPort: "Port",
      fieldUsername: "Username",
      fieldAuth: "Auth method",
      authPassword: "Password",
      authKey: "Private key",
      authAgent: "ssh-agent",
      fieldPassword: "Password",
      fieldKeyPath: "Key file path",
      fieldKeyInline: "Inline private key (PEM)",
      fieldPassphrase: "Key passphrase",
      fieldHostKey: "Host key check",
      hostKeyTofu: "TOFU (recommended)",
      hostKeyOff: "Off",
      fieldTimeout: "Timeout (s)",
      up: "Up",
      refresh: "Refresh",
      openAsWorkspace: "Open as workspace",
      workspaceAlias: "Workspace alias",
      set: "Set current",
      forget: "Forget",
      nothingYet: "Nothing here yet.",
      busy: "Working…",
      current: "Current",
      live: "live",
      idle: "idle",
      entriesCount: "entries",
      emptyDir: "Empty directory",
      goHome: "Home",
      goRoot: "Root",
      confirmRemove: "Removing a connection also deletes its workspaces and forgets credentials. Continue?",
    };

    const inject = ["slots", "locale", "connection", "layout"];

    /** Join a browser path segment onto the current remote directory. */
    function joinPath(dir, name) {
      if (dir === "." || dir === "~") return `~/${name}`;
      return dir.replace(/\/+$/, "") + "/" + name;
    }
    function parentPath(dir) {
      if (dir === "." || dir === "~") return dir;
      const idx = dir.replace(/\/+$/, "").lastIndexOf("/");
      return idx <= 0 ? "/" : dir.slice(0, idx);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-ssh-ui: dictionaries");
      const t = ctx.locale.bind(NS);
      const call = (endpoint, payload, signal) => ctx.connection.rpc.call(CHANNEL, endpoint, payload ?? {}, signal);

      // Sidebar badge: the panel-list row title carries the current remote
      // workspace. Slot labels re-resolve only when the slot version changes,
      // so a badge change re-installs the entry (dispose + fresh inject).
      let badge = "";
      let panelEntry = null;
      const installPanelEntry = () => {
        if (typeof panelEntry === "function") panelEntry();
        panelEntry = ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 5,
              label: () => (badge ? `${t("panel")} · ${badge}` : t("panel")),
              locale: NS,
            },
            PanelIcon,
          ),
        );
      };
      const setBadge = (name) => {
        const next = typeof name === "string" ? name : "";
        if (next === badge) return;
        badge = next;
        installPanelEntry();
      };

      ctx.effect(() => {
        installPanelEntry();
        const tick = async () => {
          try {
            const res = await call("status");
            const value = res && res.ok === true ? res.value : res;
            setBadge(value && typeof value.current_workspace === "string" ? value.current_workspace : "");
          } catch {
            // Sidebar badge is best-effort; the panel surfaces real errors.
          }
        };
        const timer = setInterval(tick, 15000);
        tick();
        return () => {
          clearInterval(timer);
          if (typeof panelEntry === "function") panelEntry();
          panelEntry = null;
        };
      }, "dsh-ssh-ui: panellist entry + badge poll");

      const face = { t, call, setBadge };
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, inject: () => face }, PanelPage),
      );
    }

    function PanelIcon({ size, active }) {
      return h(
        "svg",
        {
          width: size ?? 18,
          height: size ?? 18,
          viewBox: "0 0 64 64",
          "aria-hidden": true,
          style: { display: "block", opacity: active ? 1 : 0.82 },
        },
        h("rect", { x: 6, y: 12, width: 52, height: 40, rx: 7, fill: "none", stroke: "currentColor", "stroke-width": 5 }),
        h("path", { d: "M18 26l9 7-9 7", fill: "none", stroke: "currentColor", "stroke-width": 5, "stroke-linecap": "round", "stroke-linejoin": "round" }),
        h("rect", { x: 32, y: 33, width: 14, height: 6, rx: 3, fill: "currentColor" }),
      );
    }

    const css = `
.dshssh-root { display:flex; flex-direction:column; gap:20px; max-width:860px; padding:24px 28px 48px; color:var(--dsw-alias-label-primary); font-size:13px; height:100%; min-height:0; overflow-y:auto; overflow-x:hidden; box-sizing:border-box; }
.dshssh-head { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; }
.dshssh-title { font-size:18px; font-weight:600; }
.dshssh-sub { color:var(--dsw-alias-label-secondary); margin-top:4px; }
.dshssh-chip { border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:3px 10px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dshssh-chip.ok { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.dshssh-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:10px; }
.dshssh-section { padding:14px 16px; }
.dshssh-section h3 { margin:0 0 10px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); }
.dshssh-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; }
.dshssh-row:hover { background:var(--dsw-alias-bg-layer-2); }
.dshssh-grow { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshssh-mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
.dshssh-dot { width:8px; height:8px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); flex:none; }
.dshssh-dot.live { background:var(--dsw-alias-state-success-primary); }
.dshssh-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:7px; padding:4px 10px; font-size:12px; cursor:pointer; flex:none; }
.dshssh-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dshssh-btn:disabled { opacity:.5; cursor:default; }
.dshssh-btn.primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
.dshssh-btn.danger { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dshssh-err { border:1px solid var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); border-radius:8px; padding:8px 12px; white-space:pre-wrap; word-break:break-all; }
.dshssh-form { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; }
.dshssh-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.dshssh-field span { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dshssh-field input, .dshssh-field select { background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:6px; color:var(--dsw-alias-label-primary); padding:6px 8px; font-size:12px; min-width:0; }
.dshssh-field input:focus, .dshssh-field select:focus { outline:1px solid var(--dsw-alias-brand-primary); }
.dshssh-actions { display:flex; gap:8px; align-items:center; margin-top:12px; }
.dshssh-path { display:flex; gap:6px; align-items:center; margin-bottom:8px; }
.dshssh-path input { flex:1; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:6px; color:var(--dsw-alias-label-primary); padding:5px 8px; font-family:ui-monospace,Consolas,monospace; font-size:12px; min-width:0; }
.dshssh-entry { display:flex; align-items:center; gap:8px; padding:5px 10px; border-radius:6px; cursor:pointer; }
.dshssh-entry:hover { background:var(--dsw-alias-bg-layer-2); }
.dshssh-entry.file { cursor:default; color:var(--dsw-alias-label-secondary); }
.dshssh-entry .dshssh-grow { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
.dshssh-note { color:var(--dsw-alias-label-secondary); }
`;

    function PanelPage({ t, call, setBadge }) {
      const [status, setStatus] = useState(null);
      const [info, setInfo] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState("");
      const [showForm, setShowForm] = useState(false);
      const [form, setForm] = useState({
        name: "", host: "", port: "22", username: "root", auth: "password",
        password: "", private_key_path: "", private_key: "", passphrase: "",
        host_key_check: "tofu", connect_timeout_seconds: "20",
      });
      const [browse, setBrowse] = useState(null);
      const [alias, setAlias] = useState("");

      const callSafe = useCallback(async (endpoint, payload, signal) => {
        const res = await call(endpoint, payload, signal);
        if (res && res.ok === false) throw new Error(res.error?.message || "operation failed");
        return res && res.ok === true ? res.value : res;
      }, [call]);

      const run = useCallback((key, fn) => {
        setBusy(key);
        setError("");
        return Promise.resolve()
          .then(fn)
          .catch((e) => setError(String(e?.message || e)))
          .finally(() => setBusy(""));
      }, []);

      const refresh = useCallback(() => run("refresh", async () => {
        const [st, wf] = await Promise.all([callSafe("status"), callSafe("info")]);
        setStatus(st);
        setInfo(wf);
        if (typeof setBadge === "function") setBadge(wf && wf.current_workspace);
      }), [callSafe, run, setBadge]);

      useEffect(() => { refresh(); }, [refresh]);

      const setF = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

      const doConnect = () => run("connect", async () => {
        const payload = {
          name: form.name, host: form.host, username: form.username, auth: form.auth,
          host_key_check: form.host_key_check,
        };
        const port = Number.parseInt(form.port, 10);
        if (Number.isInteger(port)) payload.port = port;
        const to = Number.parseInt(form.connect_timeout_seconds, 10);
        if (Number.isInteger(to)) payload.connect_timeout_seconds = to;
        if (form.auth === "password" && form.password) payload.password = form.password;
        if (form.auth === "key") {
          if (form.private_key_path) payload.private_key_path = form.private_key_path;
          if (form.private_key) payload.private_key = form.private_key;
          if (form.passphrase) payload.passphrase = form.passphrase;
        }
        await callSafe("connect", payload);
        const alias = form.name;
        setForm((f) => ({ ...f, name: "", password: "", private_key: "", passphrase: "" }));
        setShowForm(false);
        await refresh();
        const b = await callSafe("browse", { connection: alias, dir: "." });
        setBrowse({ ...b, connection: alias });
        setAlias("");
      });

      const doDisconnect = (name) => run(name, async () => { await callSafe("disconnect", { name }); await refresh(); });
      const doRemove = (name) => {
        if (!window.confirm(t("confirmRemove"))) return;
        run(name, async () => {
          await callSafe("remove", { name });
          if (browse && browse.connection === name) setBrowse(null);
          await refresh();
        });
      };
      const doBrowse = (connection, dir) => run(`browse:${connection}`, async () => {
        const b = await callSafe("browse", { connection, dir });
        // The host response carries only { path, entries }; remember which
        // connection this browser session is bound to.
        setBrowse({ ...b, connection });
        setAlias("");
      });
      const doOpen = (name, connection, remote_path) => run("open", async () => {
        await callSafe("open", { name, connection, remote_path, set_current: true });
        await refresh();
      });
      const doClose = (name) => run(`close:${name}`, async () => { await callSafe("close", { name }); await refresh(); });

      const connections = (status && status.connections) || {};
      const connNames = Object.keys(connections);
      const workspaces = (info && info.workspaces) || (status && status.workspaces) || {};
      const wsNames = Object.keys(workspaces);
      const currentWs = info && info.current ? info.current : null;

      const btn = (key, label, onClick, extra) =>
        h("button", { className: "dshssh-btn", disabled: busy !== "", onClick, ...extra }, busy === key ? t("busy") : label);

      const field = (label, key, inputProps) =>
        h("label", { className: "dshssh-field" },
          h("span", null, label),
          h("input", { value: form[key], onChange: setF(key), ...inputProps }));

      return h("div", { className: "dshssh-root" },
        h("style", null, css),
        h("div", { className: "dshssh-head" },
          h("div", null,
            h("div", { className: "dshssh-title" }, t("title")),
            h("div", { className: "dshssh-sub" }, t("subtitle"))),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            h("div", { className: "dshssh-chip" + (currentWs ? " ok" : "") },
              currentWs ? `${t("current")}: ${currentWs.name} → ${currentWs.connection}:${currentWs.remote_path}` : t("statusIdle")),
            btn("refresh", t("refresh"), refresh))),
        error ? h("div", { className: "dshssh-err" }, error) : null,

        h("div", { className: "dshssh-card dshssh-section" },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            h("h3", null, t("sectionConnections")),
            btn("new", showForm ? "−" : "+ " + t("newConnection"), () => setShowForm((v) => !v))),
          connNames.length === 0 && !showForm ? h("div", { className: "dshssh-note" }, t("nothingYet")) : null,
          connNames.map((name) => {
            const c = connections[name];
            const live = c && c.live && c.live.state === "ready";
            return h("div", { className: "dshssh-row", key: name },
              h("div", { className: "dshssh-dot" + (live ? " live" : ""), title: live ? t("live") : t("idle") }),
              h("div", { className: "dshssh-grow" },
                h("span", { className: "dshssh-mono" }, `${c.username}@${c.host}:${c.port ?? 22}`),
                h("span", { className: "dshssh-note" }, `  ·  ${name}`)),
              btn(`browse:${name}`, t("browse"), () => doBrowse(name, ".")),
              btn(`dis:${name}`, t("disconnect"), () => doDisconnect(name)),
              btn(`rm:${name}`, t("remove"), () => doRemove(name), { className: "dshssh-btn danger" }));
          }),
          showForm ? h("div", { style: { marginTop: 12 } },
            h("div", { className: "dshssh-form" },
              field(t("fieldName"), "name", { placeholder: "myvm" }),
              field(t("fieldHost"), "host", { placeholder: "10.0.0.8" }),
              field(t("fieldPort"), "port", { inputMode: "numeric" }),
              field(t("fieldUsername"), "username"),
              h("label", { className: "dshssh-field" },
                h("span", null, t("fieldAuth")),
                h("select", { value: form.auth, onChange: setF("auth") },
                  h("option", { value: "password" }, t("authPassword")),
                  h("option", { value: "key" }, t("authKey")),
                  h("option", { value: "agent" }, t("authAgent")))),
              form.auth === "password" ? field(t("fieldPassword"), "password", { type: "password" }) : null,
              form.auth === "key" ? field(t("fieldKeyPath"), "private_key_path") : null,
              form.auth === "key" ? field(t("fieldKeyInline"), "private_key") : null,
              form.auth === "key" ? field(t("fieldPassphrase"), "passphrase", { type: "password" }) : null,
              h("label", { className: "dshssh-field" },
                h("span", null, t("fieldHostKey")),
                h("select", { value: form.host_key_check, onChange: setF("host_key_check") },
                  h("option", { value: "tofu" }, t("hostKeyTofu")),
                  h("option", { value: "off" }, t("hostKeyOff")))),
              field(t("fieldTimeout"), "connect_timeout_seconds", { inputMode: "numeric" })),
            h("div", { className: "dshssh-actions" },
              btn("connect", busy === "connect" ? t("connecting") : t("connect"), doConnect, { className: "dshssh-btn primary" }))) : null),

        h("div", { className: "dshssh-card dshssh-section" },
          h("h3", null, t("sectionWorkspaces")),
          wsNames.length === 0 ? h("div", { className: "dshssh-note" }, t("nothingYet")) : null,
          wsNames.map((name) => {
            const ws = workspaces[name];
            const isCurrent = currentWs && currentWs.name === name;
            return h("div", { className: "dshssh-row", key: name },
              h("div", { className: "dshssh-dot" + (isCurrent ? " live" : "") }),
              h("div", { className: "dshssh-grow" },
                h("span", null, name),
                h("span", { className: "dshssh-note dshssh-mono" }, `  ${ws.connection}:${ws.remote_path}`)),
              isCurrent ? h("div", { className: "dshssh-chip ok" }, t("current")) : null,
              !isCurrent ? btn(`open:${name}`, t("set"), () => doOpen(name, ws.connection, ws.remote_path)) : null,
              btn(`close:${name}`, t("forget"), () => doClose(name)));
          })),

        browse ? h("div", { className: "dshssh-card dshssh-section" },
          h("h3", null, `${t("sectionBrowser")} · ${browse.connection}`),
          h("div", { className: "dshssh-path" },
            h("input", {
              value: browse.path,
              readOnly: true,
              onFocus: (e) => e.target.select(),
            }),
            btn("up", t("up"), () => doBrowse(browse.connection, parentPath(browse.path))),
            btn("home", t("goHome"), () => doBrowse(browse.connection, ".")),
            btn("root", t("goRoot"), () => doBrowse(browse.connection, "/")),
            btn(`re:${browse.path}`, t("refresh"), () => doBrowse(browse.connection, browse.path))),
          (browse.entries || []).length === 0
            ? h("div", { className: "dshssh-note" }, t("emptyDir"))
            : h("div", null, browse.entries.map((e) =>
              h("div", {
                className: "dshssh-entry" + (e.dir ? "" : " file"),
                key: e.name,
                onClick: e.dir ? () => doBrowse(browse.connection, joinPath(browse.path, e.name)) : undefined,
              },
                h("span", { style: { flex: "none", width: 14, textAlign: "center" } }, e.dir ? "▸" : "·"),
                h("span", { className: "dshssh-grow" }, e.name)))),
          h("div", { className: "dshssh-actions" },
            h("div", { className: "dshssh-field", style: { flex: 1 } },
              h("span", null, t("workspaceAlias")),
              h("input", { value: alias, onChange: (e) => setAlias(e.target.value), placeholder: browse.path.split("/").filter(Boolean).pop() || "root" })),
            btn("open", t("openAsWorkspace"), () =>
              doOpen(alias || (browse.path.split("/").filter(Boolean).pop() || "root"), browse.connection, browse.path),
              { className: "dshssh-btn primary" }))) : null);
    }

    return { inject, apply };
  },
});
