import chalk from "chalk";
import { Router } from "express";
import type { Request, Response } from "express";
import { MODULE_NAME } from "./consts";
import {
  registerGetTaskStatus,
  registerGetTaskSummaryReady,
  registerMemorizeConversation,
  registerRetrieveDefaultCategories,
  registerLocalHealth,
  getConnectionProfilesSummary,
  listModelsForProfile,
  getLocalBridgeSessionId,
  getPluginConfig,
  setPluginConfig,
} from "./memu-endpoint";

interface PluginInfo {
  id: string;
  name: string;
  description: string;
}

interface Plugin {
  init: (router: Router) => Promise<void>;
  exit: () => Promise<void>;
  info: PluginInfo;
}

function registerMetaEndpoints(router: Router) {
  router.get("/ping", (_req: Request, res: Response) => {
    const cfg = getPluginConfig();
    const dbProviderRaw = ((cfg as any).dbProvider || (cfg as any).metadataStoreProvider || 'inmemory').toString().toLowerCase();
    const dbProvider = dbProviderRaw === 'postgres' ? 'postgres' : 'inmemory';
    const ephemeralDb = dbProvider !== 'postgres';
    return res.json({
      ok: true,
      module: MODULE_NAME,
      mode: cfg.mode,
      bridgeSessionId: getLocalBridgeSessionId(),
      dbProvider,
      ephemeralDb,
    });
  });

  router.get("/troubleshooting", (_req: Request, res: Response) => {
    const base = '/api/plugins/memu';
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>memU Troubleshooting</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:20px;line-height:1.4;max-width:980px}
    code,pre{background:#f2f2f2;border-radius:10px}
    code{padding:2px 6px}
    pre{padding:12px;overflow:auto}
    a{word-break:break-all}
    ul{padding-left:18px}
    .row{display:flex;gap:16px;flex-wrap:wrap}
    .card{border:1px solid #e6e6e6;border-radius:14px;padding:14px;flex:1;min-width:280px}
    .muted{opacity:.75}
    .ok{color:#0a7a2f}
    .bad{color:#a40000}
    button{padding:7px 10px;border-radius:10px;border:1px solid #ccc;background:#fff;cursor:pointer}
    button:hover{background:#f8f8f8}
    input{padding:7px 10px;border-radius:10px;border:1px solid #ccc;width:min(520px,100%)}
    label{display:block;margin:8px 0 4px}
    .small{font-size:12px}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#f2f2f2}
    .list{display:flex;flex-direction:column;gap:8px}
    .prof{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .prof strong{margin-right:6px}
  </style>
</head>
<body>
  <h2>memU plugin troubleshooting</h2>
  <p class="muted">This page is safe to bookmark. It reads the same endpoints the extension uses, and adds a few quick “try it now” buttons.</p>

  <div class="row">
    <div class="card">
      <h3>Status</h3>
      <ul>
        <li><a href="${base}/ping">${base}/ping</a></li>
        <li><a href="${base}/health">${base}/health</a> <span class="muted small">(local mode explains Python/memU problems here)</span></li>
        <li><a href="${base}/bridge/logs.txt">${base}/bridge/logs.txt</a> <span class="muted small">(local bridge logs)</span></li>
      </ul>
      <div id="modeLine" class="small muted">Loading mode…</div>
    </div>

    <div class="card">
      <h3>Config</h3>
      <ul>
        <li><a href="${base}/config">${base}/config</a></li>
        <li><a href="${base}/profiles">${base}/profiles</a></li>
      </ul>
      <button id="btnLoadConfig">Show /config JSON</button>
      <pre id="configOut" class="small" style="display:none"></pre>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h3>Profiles and models</h3>
    <p class="muted small">Pick a profile to generate the <code>/models</code> URL automatically. This avoids copy/paste of <code>profileId=...</code>.</p>
    <div id="profilesOut" class="list small muted">Loading profiles…</div>
    <pre id="modelsOut" class="small" style="display:none"></pre>
  </div>

  <div class="card" style="margin-top:16px">
    <h3>Tasks (debug)</h3>
    <p class="muted small">These are POST endpoints. Use this when a summary/task seems “stuck”. In local mode you only need <code>taskId</code>. In cloud mode you also need <code>apiKey</code>.</p>

    <label for="taskId">taskId</label>
    <input id="taskId" placeholder="Paste taskId here" />

    <label for="apiKey">apiKey (cloud mode only)</label>
    <input id="apiKey" placeholder="(optional) paste memU cloud apiKey here" />

    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <button id="btnTaskStatus">POST ${base}/getTaskStatus</button>
      <button id="btnSummaryReady">POST ${base}/getTaskSummaryReady</button>
    </div>

    <pre id="taskOut" class="small" style="display:none"></pre>
  </div>

  <p class="muted small" style="margin-top:16px">
    Tip: If you installed memU with <code>pip install -e .</code>, make sure the plugin runs the same Python (set <code>pythonCmd</code> in <code>memu-plugin.config.json</code> if needed).
  </p>

  <script>
  (function(){
	    const base = "/api/plugins/memu";

    function $(id){ return document.getElementById(id); }
    function show(el){ if (el) el.style.display = ""; }
    function hide(el){ if (el) el.style.display = "none"; }
    function setText(el, t){ if (el) el.textContent = t; }
    function setJson(pre, obj){
      if (!pre) return;
      pre.textContent = JSON.stringify(obj, null, 2);
      show(pre);
    }

    async function fetchJson(url, opts){
      const r = await fetch(url, opts);
      const text = await r.text();
      let data;
      try { data = text ? JSON.parse(text) : null; }
      catch { data = { raw: text }; }
      if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status:r.status, data });
      return data;
    }

    async function loadMode(){
      try{
        const ping = await fetchJson(base + "/ping");
        const cfg = await fetchJson(base + "/config");
        const mode = (cfg && cfg.mode) ? cfg.mode : (ping && ping.mode) ? ping.mode : "unknown";
        const line = $("modeLine");
        line.classList.remove("bad"); line.classList.add("muted");
        setText(line, "Mode: " + mode + (cfg && cfg.pythonCmd ? (" · pythonCmd: " + cfg.pythonCmd) : ""));
      }catch(e){
        const line = $("modeLine");
        if (line){
          line.classList.add("bad");
          setText(line, "Could not load mode (/ping or /config failed).");
        }
      }
    }

    async function onLoadConfig(){
      const out = $("configOut");
      try{
        const cfg = await fetchJson(base + "/config");
        setJson(out, cfg);
      }catch(e){
        setJson(out, e.data || { error: String(e) });
      }
    }

    function makeProfileRow(p){
      const row = document.createElement("div");
      row.className = "prof";

      const name = document.createElement("strong");
      name.textContent = p?.name || p?.id || "(profile)";
      row.appendChild(name);

      const pill = document.createElement("span");
      pill.className = "pill small";
      pill.textContent = "id: " + (p?.id || "");
      row.appendChild(pill);

      const aChat = document.createElement("a");
      aChat.href = base + "/models?profileId=" + encodeURIComponent(p.id) + "&kind=chat";
      aChat.textContent = "Chat models";
      aChat.style.marginLeft = "8px";
      aChat.target = "_blank";
      row.appendChild(aChat);

      const aEmb = document.createElement("a");
      aEmb.href = base + "/models?profileId=" + encodeURIComponent(p.id) + "&kind=embedding";
      aEmb.textContent = "Embedding models";
      aEmb.style.marginLeft = "8px";
      aEmb.target = "_blank";
      row.appendChild(aEmb);

      const btn = document.createElement("button");
      btn.textContent = "Preview JSON";
      btn.addEventListener("click", async () => {
        const out = $("modelsOut");
        hide(out);
        try{
          const data = await fetchJson(base + "/models?profileId=" + encodeURIComponent(p.id) + "&kind=all");
          setJson(out, data);
        }catch(e){
          setJson(out, e.data || { error: String(e) });
        }
      });
      row.appendChild(btn);

      return row;
    }

    async function loadProfiles(){
      const box = $("profilesOut");
      const out = $("modelsOut");
      hide(out);
      try{
        const profiles = await fetchJson(base + "/profiles");
        box.innerHTML = "";
        if (!Array.isArray(profiles) || profiles.length === 0){
          box.textContent = "No profiles found. (This usually means the plugin couldn’t locate SillyTavern’s settings.json.)";
          return;
        }
        profiles.forEach(p => box.appendChild(makeProfileRow(p)));
      }catch(e){
        box.textContent = "Failed to load /profiles.";
        setJson(out, e.data || { error: String(e) });
      }
    }

    async function postTask(path){
      const out = $("taskOut");
      hide(out);
      const taskId = String($("taskId")?.value || "").trim();
      const apiKey = String($("apiKey")?.value || "").trim();
      const body = { taskId };
      if (apiKey) body.apiKey = apiKey;
      try{
        const data = await fetchJson(base + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        setJson(out, data);
      }catch(e){
        setJson(out, e.data || { error: String(e) });
      }
    }

    $("btnLoadConfig")?.addEventListener("click", onLoadConfig);
    $("btnTaskStatus")?.addEventListener("click", () => postTask("/getTaskStatus"));
    $("btnSummaryReady")?.addEventListener("click", () => postTask("/getTaskSummaryReady"));

    loadMode();
    loadProfiles();
  })();
  </script>
</body>
</html>`;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  });

  router.get("/config", (_req: Request, res: Response) => {
    return res.json(getPluginConfig());
  });

  router.post("/config", (req: Request, res: Response) => {
    const bodyObj = req.body;
    if (bodyObj && typeof bodyObj === "object") {
      const cfg = setPluginConfig(bodyObj);
      return res.json({ ok: true, config: cfg });
    }

    // Fallback: manual body parsing
    let raw = "";
    req.on("data", (chunk: any) => (raw += chunk));
    req.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        const cfg = setPluginConfig(parsed);
        return res.json({ ok: true, config: cfg });
      } catch {
        return res.status(400).json({ error: "Invalid JSON" });
      }
    });
  });

  router.get("/profiles", (_req: Request, res: Response) => {
    return res.json(getConnectionProfilesSummary());
  });

  router.get("/models", async (req: Request, res: Response) => {
    const profileId = typeof (req.query as any).profileId === "string" ? String((req.query as any).profileId) : "";
    if (!profileId.trim()) return res.status(400).json({ ok: false, models: [], message: "profileId is required" });
		const kindRaw = typeof (req.query as any).kind === "string" ? String((req.query as any).kind).trim() : "";
		const kind = (kindRaw === "embedding" || kindRaw === "chat" || kindRaw === "all") ? (kindRaw as any) : undefined;
		const force = String((req.query as any).force || "") === "1" || String((req.query as any).force || "").toLowerCase() === "true";
		const out = await listModelsForProfile(profileId.trim(), { kind, force });
    return res.json(out);
  });
}

export async function init(router: Router): Promise<void> {
  registerGetTaskStatus(router);
  registerGetTaskSummaryReady(router);
  registerRetrieveDefaultCategories(router);
  registerMemorizeConversation(router);
  registerLocalHealth(router);

  registerMetaEndpoints(router);

  console.log(chalk.green(MODULE_NAME), "Plugin initialized");
}

export async function exit(): Promise<void> {
  console.log(chalk.yellow(MODULE_NAME), "Plugin exited");
}

export const info: PluginInfo = {
  id: "memu",
  name: "Memu SillyTavern Plugin",
  description: "Ability to use Memu api in SillyTavern",
};

const plugin: Plugin = {
  init,
  exit,
  info,
};

export default plugin;
