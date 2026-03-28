import chalk from "chalk";
import { Router } from "express";
import type { Request, Response } from "express";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { MODULE_NAME } from "./consts";

const _warnOnceAt = new Map<string, number>();
function warnOnce(key: string, msg: string, ttlMs: number = 30_000): void {
  const now = Date.now();
  const prev = _warnOnceAt.get(key) || 0;
  if ((now - prev) < ttlMs) return;
  _warnOnceAt.set(key, now);
  try { console.warn(chalk.yellow(MODULE_NAME), msg); } catch {}
}

type MemuStep =
  | 'preprocess'
  | 'memory_extract'
  | 'category_update'
  | 'reflection'
  | 'ranking'
  | 'embeddings';

interface MemuPluginConfig {
  version: number;
  // In local mode, "default" means: the currently selected SillyTavern connection profile.
  defaultProfileId: string;
  stepProfileId: Partial<Record<MemuStep, string>>;
  updatedAt: string;

  // External memU server (mcp-memu-server) folder.
  serverPath?: string;
  // Start local server automatically when needed.
  autoStartServer?: boolean;

  // Embeddings model fields (dropdown overrides manual).
  embeddingModel?: string;
  embeddingModelSelected?: string;
  embeddingModelManual?: string;
}

const CONFIG_FILENAME = "memu-plugin.config.json";

const DEFAULT_CONFIG: MemuPluginConfig = {
  version: 4,
  // In local mode, "default" means: the currently selected SillyTavern connection profile.
  defaultProfileId: "default",
  stepProfileId: {},
  // External memU server folder (mcp-memu-server). In local mode we derive:
  //   baseUrl: http://127.0.0.1:8099  (or env MEMU_SERVER_URL)
  //   command: <serverPath>/run.py (spawned via python, no shell)
  serverPath: (() => {
    const home = String(process.env.HOME || process.env.USERPROFILE || '').trim();
    return home ? path.join(home, 'apps', 'mcp-memu-server') : undefined;
  })(),
  autoStartServer: true,
  updatedAt: new Date().toISOString(),
};

// -----------------------------
// SillyTavern root + config path
// -----------------------------

let _stRootCached: string | null = null;

function getStRoot(): string {
  if (_stRootCached) return _stRootCached;
  const env = String(process.env.ST_ROOT || process.env.SILLYTAVERN_ROOT || '').trim();
  _stRootCached = env ? path.resolve(env) : process.cwd();
  return _stRootCached;
}

function getConfigPath(): string {
  return path.join(getStRoot(), CONFIG_FILENAME);
}

function ensureConfigFileExists(): void {
  const cfgPath = getConfigPath();
  try {
    if (fs.existsSync(cfgPath)) return;
    fs.writeFileSync(cfgPath, JSON.stringify({ ...DEFAULT_CONFIG, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    // ignore (non-fatal)
  }
}

function readJsonIfExists(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}




type JsonCacheEntry = { at: number; mtimeMs: number; value: any | null; missing: boolean };
const _jsonCache = new Map<string, JsonCacheEntry>();

function readJsonCached(filePath: string, ttlMs: number = 2000): any | null {
  const now = Date.now();
  const prev = _jsonCache.get(filePath);
  if (prev && (now - prev.at) < ttlMs) return prev.value;

  try {
    const st = fs.statSync(filePath);
    const mtimeMs = st.mtimeMs;
    if (prev && !prev.missing && prev.mtimeMs === mtimeMs) {
      prev.at = now;
      return prev.value;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const value = raw && raw.trim() ? JSON.parse(raw) : null;
    _jsonCache.set(filePath, { at: now, mtimeMs, value, missing: false });
    return value;
  } catch {
    _jsonCache.set(filePath, { at: now, mtimeMs: 0, value: null, missing: true });
    return null;
  }
}
function sanitizeIncomingConfig(obj: any): MemuPluginConfig {
  const cfg: MemuPluginConfig = {
    ...DEFAULT_CONFIG,
    ...(obj && typeof obj === "object" ? obj : {}),
  };
  cfg.version = 4;
  cfg.defaultProfileId =
    typeof cfg.defaultProfileId === "string" && cfg.defaultProfileId.trim()
      ? cfg.defaultProfileId.trim()
      : "default";

  const out: Partial<Record<MemuStep, string>> = {};
  const allowed: MemuStep[] = [
    "preprocess",
    "memory_extract",
    "category_update",
    "reflection",
    "ranking",
    "embeddings",
  ];
  const incoming =
    cfg.stepProfileId && typeof cfg.stepProfileId === "object"
      ? (cfg.stepProfileId as any)
      : {};
  for (const k of allowed) {
    const v = incoming[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  cfg.stepProfileId = out;

  // Normalize/derive embedding model fields (dropdown overrides manual).
  const selected = typeof (cfg as any).embeddingModelSelected === "string" ? String((cfg as any).embeddingModelSelected).trim() : "";
  const manual = typeof (cfg as any).embeddingModelManual === "string" ? String((cfg as any).embeddingModelManual).trim() : "";
  const legacy = typeof (cfg as any).embeddingModel === "string" ? String((cfg as any).embeddingModel).trim() : "";
  const effective = selected || manual || legacy;
  (cfg as any).embeddingModelSelected = selected || undefined;
  (cfg as any).embeddingModelManual = manual || undefined;
  (cfg as any).embeddingModel = effective || undefined;
  // External server settings (local mode): only serverPath is user-configurable.
  const serverPathRaw = String((cfg as any).serverPath || '').trim();
  const home2 = String(process.env.HOME || process.env.USERPROFILE || '').trim();
  const defaultPath = home2 ? path.join(home2, 'apps', 'mcp-memu-server') : '';
  (cfg as any).serverPath = (serverPathRaw || defaultPath || '').trim() || undefined;
  (cfg as any).autoStartServer = ((cfg as any).autoStartServer !== false);

  cfg.updatedAt = new Date().toISOString();
  return cfg;
}


let _cachedPluginConfig: { cfg: MemuPluginConfig; at: number } | null = null;
const PLUGIN_CONFIG_CACHE_TTL_MS = 2000;
function readPluginConfig(): MemuPluginConfig {
  const now = Date.now();
  if (_cachedPluginConfig && (now - _cachedPluginConfig.at) < PLUGIN_CONFIG_CACHE_TTL_MS) {
    return _cachedPluginConfig.cfg;
  }

  ensureConfigFileExists();
  const obj = readJsonIfExists(getConfigPath());
  const cfg = obj ? sanitizeIncomingConfig(obj) : { ...DEFAULT_CONFIG };
  _cachedPluginConfig = { cfg, at: now };
  return cfg;
}
export function getPluginConfig(): MemuPluginConfig {
  return readPluginConfig();
}

export function setPluginConfig(obj: any): MemuPluginConfig {
  const cfg = sanitizeIncomingConfig(obj);
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.warn(chalk.yellow(MODULE_NAME), 'Failed to write config:', e);
  }
  _cachedPluginConfig = { cfg, at: Date.now() };
  return cfg;
}


// -----------------------------
// Local: ST connection profiles
// -----------------------------

type AnyObject = Record<string, any>;

let _profilesCache: { at: number; profiles: AnyObject[] } | null = null;
const PROFILES_CACHE_TTL_MS = 2000;

function listSTUserDirs(): string[] {
  const root = getStRoot();
  const dataDir = path.join(root, "data");
  const dirs: string[] = [];

  const def = path.join(dataDir, "default-user");
  if (fs.existsSync(path.join(def, "settings.json"))) dirs.push(def);

  try {
    if (fs.existsSync(dataDir)) {
      const entries = fs.readdirSync(dataDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const d = path.join(dataDir, ent.name);
        if (dirs.includes(d)) continue;
        if (fs.existsSync(path.join(d, "settings.json"))) dirs.push(d);
      }
    }
  } catch {
    // ignore
  }

  // As a last resort, allow running from inside a user dir
  if (!dirs.length) {
    const maybeUserDir = path.join(root, "data", "default-user");
    if (fs.existsSync(path.join(maybeUserDir, "settings.json"))) dirs.push(maybeUserDir);
  }

  return dirs;
}

function deepCollectProfiles(node: any, out: AnyObject[], depth: number = 0): void {
  if (!node || depth > 14) return;
  if (Array.isArray(node)) {
    for (const v of node) deepCollectProfiles(v, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as AnyObject;
  // Heuristic: connection profile objects usually have id + name + some provider-ish fields.
  if (typeof obj.id === "string" && typeof obj.name === "string") {
    const hasProviderish =
      "api" in obj ||
      "provider" in obj ||
      "apiType" in obj ||
      "api_type" in obj ||
      "baseUrl" in obj ||
      "base_url" in obj ||
      "apiUrl" in obj ||
      "api_url" in obj ||
      "api-url" in obj ||
      "url" in obj ||
      "endpoint" in obj ||
      "model" in obj ||
      "chat_model" in obj ||
      "chatModel" in obj;

    if (hasProviderish) out.push(obj);
  }

  for (const k of Object.keys(obj)) {
    deepCollectProfiles(obj[k], out, depth + 1);
  }
}

function loadAllProfilesFromSettings(): AnyObject[] {
  const now = Date.now();
  if (_profilesCache && (now - _profilesCache.at) < PROFILES_CACHE_TTL_MS) return _profilesCache.profiles;

  const out: AnyObject[] = [];
  const userDirs = listSTUserDirs();
  for (const dir of userDirs) {
    const settings = readJsonCached(path.join(dir, "settings.json"));
    if (!settings) continue;

    // Fast path: ST stores connection profiles here in 1.15+
    const cm = (settings as any)?.extension_settings?.connectionManager;
    if (cm && Array.isArray(cm.profiles)) {
      for (const prof of cm.profiles) {
        if (!prof || typeof prof !== 'object') continue;
        (prof as any).__st_user_dir = dir;
        out.push(prof as any);
      }
      continue;
    }

    // Fallback: heuristic deep scan
    const found: AnyObject[] = [];
    deepCollectProfiles(settings, found);
    for (const prof of found) {
      (prof as any).__st_user_dir = dir;
      out.push(prof);
    }
  }

  // Deduplicate by id (keep the first occurrence)
  const seen = new Set<string>();
  const profiles = out.filter((p) => {
    const id = String((p as any).id);
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  _profilesCache = { at: Date.now(), profiles };
  return profiles;
}

function _deepFindSelectedId(node: any, ids: Set<string>, depth: number = 0): string | null {
  if (!node || depth > 14) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = _deepFindSelectedId(v, ids, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  for (const [k, v] of Object.entries(node as any)) {
    const key = String(k || '').toLowerCase();
    const looksSelected = key.includes('selected') || key.includes('active') || key.includes('current');
    if (!looksSelected) continue;

    if (typeof v === 'string' && ids.has(v)) return v;
    if (v && typeof v === 'object') {
      const maybeId = (v as any).id || (v as any).profileId || (v as any).profile_id;
      if (typeof maybeId === 'string' && ids.has(maybeId)) return maybeId;
    }
  }

  for (const v of Object.values(node as any)) {
    const hit = _deepFindSelectedId(v, ids, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function expectedProfileModeFromSettings(settings: AnyObject | null): 'cc' | 'tc' | null {
  const mainApi = String((settings as any)?.main_api || '').trim().toLowerCase();
  if (!mainApi) return null;
  if (mainApi === 'openai') return 'cc';
  return 'tc';
}

function findSelectedProfileIdForUserDir(userDir: string, profiles: AnyObject[]): string | null {
  try {
    const settings = readJsonCached(path.join(userDir, 'settings.json'));
    if (!settings) return null;
    const userProfiles = profiles.filter((p) => (p as any).__st_user_dir === userDir);
    const ids = new Set(userProfiles.map((p) => String((p as any).id)));
    if (!ids.size) return null;
    const byId = new Map(userProfiles.map((p) => [String((p as any).id), p]));
    const expectedMode = expectedProfileModeFromSettings(settings as AnyObject);
    const matchesMode = (id: string): boolean => {
      if (!expectedMode) return true;
      const prof = byId.get(String(id));
      const mode = String((prof as any)?.mode || '').trim().toLowerCase();
      return mode === expectedMode;
    };

    const cmSel = (settings as any)?.extension_settings?.connectionManager?.selectedProfile;
    if (typeof cmSel === 'string' && ids.has(cmSel) && matchesMode(cmSel)) return cmSel;

    const deepSel = _deepFindSelectedId(settings, ids, 0);
    if (deepSel && matchesMode(deepSel)) return deepSel;

    if (expectedMode) {
      const modeCandidates = userProfiles.filter((p) => String((p as any)?.mode || '').trim().toLowerCase() === expectedMode);
      if (modeCandidates.length) return String((modeCandidates[0] as any).id || '');
    }

    if (typeof cmSel === 'string' && ids.has(cmSel)) return cmSel;

    return deepSel || null;
  } catch (e: any) {
    warnOnce('selectedProfile', "selectedProfile: failed to read settings.json");
    return null;
  }
}

function normalizeProfile(p: AnyObject): {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  model: string | null;
  secretId?: string | null;
  tokenInline?: string | null;
} {
  const id = String(p.id);
  const name = String(p.name);
  const provider =
    String(
      p.api ??
        p.provider ??
        p.apiType ??
        p.api_type ??
        p.source ??
        p.backend ??
        ""
    ).toLowerCase() || "unknown";

  const baseUrl: string | null =
    (typeof p.baseUrl === "string" && p.baseUrl) ||
    (typeof p.base_url === "string" && p.base_url) ||
    (typeof p.apiUrl === "string" && p.apiUrl) ||
    (typeof p.api_url === "string" && p.api_url) ||
    (typeof (p as any)["api-url"] === "string" && (p as any)["api-url"]) ||
    (typeof p.url === "string" && p.url) ||
    (typeof p.endpoint === "string" && p.endpoint) ||
    null;

  const model: string | null =
    (typeof p.model === "string" && p.model) ||
    (typeof p.chatModel === "string" && p.chatModel) ||
    (typeof p.chat_model === "string" && p.chat_model) ||
    null;

  const tokenInline: string | null =

    (typeof (p as any).api_key === "string" && (p as any).api_key) ||
    null;

  const secretId: string | null =
    (typeof (p as any)["secret-id"] === "string" && (p as any)["secret-id"]) ||
    (typeof (p as any).secretId === "string" && (p as any).secretId) ||
    (typeof (p as any).secret_id === "string" && (p as any).secret_id) ||
    null;

  return { id, name, provider, baseUrl, model, secretId, tokenInline };
}

function findProfileById(profiles: AnyObject[], id: string): AnyObject | null {
  for (const p of profiles) {
    if (String(p.id) === id) return p;
  }
  return null;
}

function loadSecrets(userDir?: string): AnyObject | null {
  const dirs = userDir ? [userDir] : listSTUserDirs();
  for (const dir of dirs) {
    const s = readJsonCached(path.join(dir, "secrets.json"));
    if (s) return s;
  }
  return null;
}

function _extractKeyValue(entry: any, wantedId?: string | null, strictId: boolean = false): string | null {
  if (!entry) return null;
  if (typeof entry === 'string' && entry.trim()) return entry.trim();

  // Newer ST secrets.json format: api_key_<provider> is an array of {id,value,label,active}
  if (Array.isArray(entry)) {
    const arr = entry as any[];
    if (wantedId) {
      const hit = arr.find((x) => x && typeof x === 'object' && String(x.id) === String(wantedId) && typeof x.value === 'string');
      if (hit && typeof hit.value === 'string' && hit.value.trim()) return hit.value.trim();
    }
    if (wantedId && strictId) return null;
    const active = arr.find((x) => x && typeof x === 'object' && (x.active === true || x.active === 1) && typeof x.value === 'string');
    if (active && typeof active.value === 'string' && active.value.trim()) return active.value.trim();
    const first = arr.find((x) => x && typeof x === 'object' && typeof x.value === 'string' && x.value.trim());
    if (first && typeof first.value === 'string') return first.value.trim();
    return null;
  }

  if (typeof entry === 'object' && typeof entry.value === 'string' && entry.value.trim()) {
    return entry.value.trim();
  }

  return null;
}


function pickKeyForProvider(provider: string, secrets: AnyObject | null, secretId?: string | null): string | null {
  if (!secrets || typeof secrets !== "object") return null;

  // If a specific secret-id was chosen in the Connection Profile, honor it regardless of provider bucket.
  if (secretId) {
    for (const k of Object.keys(secrets)) {
      const v = _extractKeyValue((secrets as any)[k], secretId, true);
      if (v) return v;
    }
  }

  // Direct mapping for common providers (best-effort; ST key names can vary by version).
  const mapping: Record<string, string[]> = {
    openai: ["api_key_openai"],
    openrouter: ["api_key_openrouter"],
    custom: ["api_key_custom"],
    groq: ["api_key_groq"],
    mistral: ["api_key_mistral"],
    anthropic: ["api_key_anthropic"],
    google: ["api_key_google", "api_key_gemini"],
    deepseek: ["api_key_deepseek"],
    cohere: ["api_key_cohere"],
    together: ["api_key_together", "api_key_togetherai"],
    xai: ["api_key_xai", "api_key_grok"],
    grok: ["api_key_grok", "api_key_xai"],
    nanogpt: ["api_key_nanogpt"],
    horde: ["api_key_horde"],
  };

  const keys = mapping[provider] || mapping[provider.replace(/[^a-z0-9_]/g, "")] || [];
  for (const k of keys) {
    const v = _extractKeyValue((secrets as any)[k], secretId);
    if (v) return v;
  }

  // Fallback: try to locate a secrets key that contains the provider name.
  const providerKey = provider.replace(/[^a-z0-9]/g, "");
  if (providerKey) {
    for (const k of Object.keys(secrets)) {
      if (!/^api_key_/i.test(k)) continue;
      if (!k.toLowerCase().includes(providerKey)) continue;
      const v = _extractKeyValue((secrets as any)[k], secretId);
      if (v) return v;
    }
  }

  // Last resort: if there is exactly one api_key_* entry, use it.
  const keyFields = Object.keys(secrets).filter((k) => /^api_key_/i.test(k));
  if (keyFields.length === 1) {
    const v = _extractKeyValue((secrets as any)[keyFields[0]], secretId);
    if (v) return v;
  }

  return null;
}

// Exported for meta endpoints (/profiles, /models)
export function getConnectionProfilesSummary(): {
  ok: boolean;
  profiles: Array<{
    id: string;
    name: string;
    provider?: string;
    memuChatCapable?: boolean;
    memuEmbeddingListCapable?: boolean;
    selected?: boolean;
    resolvedProfileId?: string;
  }>;
  selectedProfileId?: string | null;
  message?: string;
} {
  const profiles = loadAllProfilesFromSettings();
  const merged: Array<{
    id: string;
    name: string;
    provider?: string;
    memuChatCapable?: boolean;
    memuEmbeddingListCapable?: boolean;
    selected?: boolean;
    resolvedProfileId?: string;
  }> = [];
  const selectedByUserDir = new Set<string>();
  for (const d of listSTUserDirs()) {
    const sid = findSelectedProfileIdForUserDir(d, profiles);
    if (sid) selectedByUserDir.add(String(sid));
  }
  const selectedProfileId = selectedByUserDir.size ? Array.from(selectedByUserDir)[0] : null;
  const openaiLike = new Set([
    'openai', 'openai-compatible', 'openai_compatible', 'openrouter', 'nanogpt', 'groq', 'together', 'togetherai',
    'mistral', 'deepseek', 'xai', 'perplexity', 'custom', 'vllm', 'lmstudio', 'ollama',
  ]);

  for (const p of profiles) {
    try {
      const n = normalizeProfile(p);
      const secrets = loadSecrets((p as any).__st_user_dir);
      const key = n.tokenInline || (secrets ? pickKeyForProvider(n.provider, secrets, n.secretId) : null);
      const hasSignal = Boolean((n.baseUrl && n.baseUrl.trim()) || (n.model && n.model.trim()) || (key && String(key).trim()));
      if (!hasSignal) continue;
      const chatCapable = Boolean((n.baseUrl && n.baseUrl.trim()) && (n.model && n.model.trim()) && (key && String(key).trim()));
      const embListCapable = Boolean((n.baseUrl && n.baseUrl.trim()) && (key && String(key).trim()) && (openaiLike.has(String(n.provider || '').toLowerCase()) || /nano-gpt\.com/i.test(String(n.baseUrl || ''))));

      const id = String((p as any).id || '').trim();
      let name = String((p as any).name || (p as any).label || (p as any).title || '').trim();
      const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
      const looksPlaceholder = /placeholder/i.test(name) || name.toLowerCase() === 'default';
      if (!name || looksUuid || looksPlaceholder) name = '';
      if (!name) {
        const model = String((n.model || '')).trim();
        const prov = String((n.provider || '')).trim();
        const host = n.baseUrl ? String(n.baseUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
        name = [prov || 'provider', model || '', host ? '@' + host : ''].filter(Boolean).join(' ');
      }
      if (!name) name = id;
      if (!id || !name) continue;
      if (!merged.some((x) => x.id === id)) merged.push({
        id,
        name,
        provider: String(n.provider || '').trim() || undefined,
        memuChatCapable: chatCapable,
        memuEmbeddingListCapable: embListCapable,
        selected: selectedByUserDir.has(id),
      });
    } catch {
      // ignore bad entries
    }
  }

  const selectedSummary = selectedProfileId ? merged.find((x) => x.id === selectedProfileId) : undefined;
  const defaultAlias = {
    id: 'default',
    name: selectedSummary?.provider
      ? `default (SillyTavern selected: ${selectedSummary.provider})`
      : 'default (SillyTavern selected)',
    provider: selectedSummary?.provider,
    memuChatCapable: selectedSummary?.memuChatCapable,
    memuEmbeddingListCapable: selectedSummary?.memuEmbeddingListCapable,
    selected: true,
    resolvedProfileId: selectedSummary?.id,
  };

  const withAliases = [defaultAlias, ...merged].filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);
  if (merged.length) return { ok: true, profiles: withAliases, selectedProfileId };
  return { ok: false, profiles: withAliases, selectedProfileId, message: 'No usable connection profiles found (need base_url/model/key in any data/*/settings.json).' };
}

function _stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function buildOpenAIModelsUrl(baseUrl: string): string {
  const b = _stripTrailingSlash(baseUrl.trim());
  // If the profile already points at .../v1, use .../v1/models
  if (/\/v1$/i.test(b)) return b + '/models';
  // If it already contains /v1/ somewhere, assume it's full base and add /models
  if (/\/v1\//i.test(b)) return b + (b.endsWith('/models') ? '' : '/models');
  // Otherwise, append /v1/models
  return b + '/v1/models';
}

function buildNanoGptEmbeddingModelsUrl(baseUrl: string): string {
  // NanoGPT docs: GET /api/v1/embedding-models for embedding models list.
  // Profiles often store https://nano-gpt.com/api/v1/ (or /api/v1)
  const b = _stripTrailingSlash(baseUrl.trim());
  return b.endsWith('/embedding-models') ? b : b + '/embedding-models';
}

function httpGetJson(url: string, headers: Record<string, string>, timeoutMs: number = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? require('http') : require('https');
      const req = lib.request(
        {
          method: 'GET',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + (u.search || ''),
          headers,
        },
        (res: any) => {
          let buf = '';
          res.on('data', (d: any) => (buf += d.toString('utf8')));
          res.on('end', () => {
            const code = res.statusCode || 0;
            if (code < 200 || code >= 300) {
              return reject(new Error(`HTTP ${code} from ${url}`));
            }
            try {
              resolve(buf ? JSON.parse(buf) : {});
            } catch (e) {
              reject(new Error('Failed to parse JSON from models endpoint'));
            }
          });
        }
      );
      req.on('error', (e: any) => reject(e));
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(new Error('Timeout')); } catch {}
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

type ModelsKind = 'embedding' | 'chat' | 'all';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_CACHE: Map<string, { ts: number; value: { ok: boolean; models: string[]; message?: string } }> = new Map();

export async function listModelsForProfile(
  profileId: string,
  opts?: { kind?: ModelsKind; force?: boolean }
): Promise<{ ok: boolean; models: string[]; message?: string }> {
  const kind: ModelsKind = (opts?.kind || 'all') as ModelsKind;
  const cacheKey = `${kind}|${profileId}`;
  const now = Date.now();
  if (!opts?.force) {
    const hit = MODEL_CACHE.get(cacheKey);
    if (hit && now - hit.ts < MODEL_CACHE_TTL_MS) return hit.value;
  }

  const result = await listModelsForProfileUncached(profileId, kind);
  MODEL_CACHE.set(cacheKey, { ts: now, value: result });
  return result;
}

async function listModelsForProfileUncached(profileId: string, kind: ModelsKind): Promise<{ ok: boolean; models: string[]; message?: string }> {
  try {
    const cred = resolveProfileCredentials(profileId);
    if (!cred) return { ok: false, models: [], message: 'Profile not found.' };
    if (!cred.ok) return { ok: false, models: [], message: cred.message || 'Profile is missing base_url/model/api_key.' };

    const provider = String(cred.provider || '').toLowerCase();
    const baseUrl = cred.baseUrl;

    // NanoGPT separates chat models (/api/v1/models) and embedding models (/api/v1/embedding-models).
    let url = '';
    if (provider === 'nanogpt' || /nano-gpt\.com/i.test(baseUrl)) {
      if (kind === 'embedding') url = buildNanoGptEmbeddingModelsUrl(baseUrl);
      else url = buildOpenAIModelsUrl(baseUrl); // chat/all
    } else {
      url = buildOpenAIModelsUrl(baseUrl);
    }

    const json = await httpGetJson(url, {
      Authorization: `Bearer ${cred.key}`,
      'x-api-key': cred.key,
    });

    let ids: string[] = [];
    if (json && Array.isArray(json.data)) {
      ids = json.data.map((x: any) => (x && typeof x.id === 'string' ? x.id : null)).filter(Boolean);
    } else if (Array.isArray(json)) {
      ids = json.map((x: any) => (x && typeof x.id === 'string' ? x.id : null)).filter(Boolean);
    } else if (json && Array.isArray(json.models)) {
      ids = json.models.map((x: any) => (x && typeof x.id === 'string' ? x.id : null)).filter(Boolean);
    }

    const uniq = sorted_unique(ids);
    if (!uniq.length) {
      const msg = kind === 'embedding'
        ? 'No models found (embedding list unavailable from provider).'
        : 'No models found (provider did not return a /v1/models list).';
      return { ok: false, models: [], message: msg };
    }

    return { ok: true, models: uniq };
  } catch (e: any) {
    return { ok: false, models: [], message: e?.message || 'Failed to load models.' };
  }
}

function sorted_unique(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const s = String(id || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  out.sort();
  return out;
}

function resolveProfileCredentials(profileId: string): {
  ok: boolean;
  message?: string;
  provider: string;
  baseUrl: string;
  model: string;
  key: string;
} | null {
  const profiles = loadAllProfilesFromSettings();
  if (!profiles.length) return null;

  let chosen: AnyObject | null = null;
  if (profileId === "default") {
    // Prefer the currently selected connection profile in SillyTavern (best-effort).
    const userDirs = listSTUserDirs();
    let selected: string | null = null;
    for (const d of userDirs) {
      selected = findSelectedProfileIdForUserDir(d, profiles);
      if (selected) break;
    }
    if (selected) chosen = findProfileById(profiles, selected) || null;
    if (!chosen) chosen = profiles[0];
  } else {
    chosen = findProfileById(profiles, profileId) || null;
  }
  if (!chosen) return null;

  const p = normalizeProfile(chosen);
  const userDir = (chosen as any).__st_user_dir as string | undefined;
  const secrets = loadSecrets(userDir);

  const key = p.tokenInline || pickKeyForProvider(p.provider, secrets, p.secretId);
  if (!p.baseUrl || !p.model || !key) {
    const missing = [
      !p.baseUrl ? "base_url" : null,
      !p.model ? "model" : null,
      !key ? "api_key" : null,
    ].filter(Boolean);
    return {
      ok: false,
      message: `Missing ${missing.join(", ")} for profile '${p.name}' (${p.id}).`,
      provider: p.provider,
      baseUrl: p.baseUrl || "",
      model: p.model || "",
      key: key || "",
    };
  }

  return {
    ok: true,
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    key: key,
  };
}

function safeFsName(v: string): string {
  const cleaned = v.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return cleaned || "default";
}

function sanitizeScopedDbFilename(v: string): string {
  let s = String(v || "").trim();
  s = s.replace(/[^A-Za-z0-9._-]+/g, "_");
  s = s.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  if (!s) s = "unknown";
  return s.slice(0, 80);
}

let _loggedDefaultCategories = false;

function mapSTProviderToMemU(provider: string): { provider: string; client_backend: string; provider_hint?: string } {
  const p = String(provider || '').trim().toLowerCase();
  // Treat common ST providers as OpenAI-compatible in local mode.
  // (memU local backends are wired for OpenAI-style base_url + api_key.)
  const openaiCompat = new Set([
    'openai',
    'openai-compatible',
    'openai_compatible',
    'openrouter',
    'nanogpt',
    'groq',
    'together',
    'togetherai',
    'mistral',
    'deepseek',
    'xai',
    'perplexity',
    'custom',
    'vllm',
    'lmstudio',
    'ollama',
  ]);
  if (!p || openaiCompat.has(p)) return { provider: 'openai', client_backend: 'sdk' };
  // Fallback: keep behavior stable but retain a hint for debugging.
  return { provider: 'openai', client_backend: 'sdk', provider_hint: p };
}

function buildMemuPayloadForLocal(
  cfg: MemuPluginConfig,
  userId: string,
  characterId: string,
  conversation?: any,
  opts?: { characterName?: string; chatFileName?: string; conversationId?: string }
): any {

  const step = (s: MemuStep): string => cfg.stepProfileId?.[s] || cfg.defaultProfileId || "default";
  const steps: MemuStep[] = ["preprocess", "memory_extract", "category_update", "reflection", "ranking", "embeddings"];
  const labelsById = new Map<string, string[]>();
  for (const s of steps) {
    const id = step(s);
    const labels = labelsById.get(id) || [];
    labels.push(s);
    labelsById.set(id, labels);
  }
  const resolveRequired = (id: string): NonNullable<ReturnType<typeof resolveProfileCredentials>> => {
    const cred = resolveProfileCredentials(id);
    if (cred && cred.ok) return cred;
    const where = labelsById.get(id);
    const usedBy = where && where.length ? `steps=${where.join(",")}` : "step=unknown";
    const reason = cred?.message || `profile '${id}' not found`;
    throw new Error(`Model Mapping invalid (${usedBy}, profile='${id}'): ${reason}`);
  };

  // Build unique set of needed profile ids (default + step overrides)
  const needIds = new Set<string>();
  for (const s of steps) needIds.add(step(s));

  const idToName = (id: string) => (id === "default" ? "default" : `st_${safeFsName(id)}`);

  const llm_profiles: Record<string, any> = {};

  // Provide "default" only when needed by step mapping.
  const defId = cfg.defaultProfileId || "default";
  const defaultReferencedBySteps = labelsById.has(defId);
  let defCred: NonNullable<ReturnType<typeof resolveProfileCredentials>> | null = null;
  if (defaultReferencedBySteps) {
    defCred = resolveRequired(defId);
  } else {
    const maybeDef = resolveProfileCredentials(defId);
    if (maybeDef && maybeDef.ok) defCred = maybeDef;
  }
  if (defCred) {
    const defMapped = mapSTProviderToMemU(defCred.provider);
    llm_profiles["default"] = {
      provider: defMapped.provider,
      base_url: defCred.baseUrl,
      api_key: defCred.key,
      chat_model: defCred.model,
      client_backend: defMapped.client_backend,
      ...(defMapped.provider_hint ? { provider_hint: defMapped.provider_hint } : {}),
    };
  }

  // Populate step-specific profiles
  for (const id of needIds) {
    const name = idToName(id);
    if (llm_profiles[name]) continue;
    const cred = resolveRequired(id);
    const mapped = mapSTProviderToMemU(cred.provider);
    llm_profiles[name] = {
      provider: mapped.provider,
      base_url: cred.baseUrl,
      api_key: cred.key,
      chat_model: cred.model,
      client_backend: mapped.client_backend,
      ...(mapped.provider_hint ? { provider_hint: mapped.provider_hint } : {}),
    };
  }

  // Embeddings: memU pipelines default to embed_llm_profile="embedding" in many steps.
  const embedId = step("embeddings");
  const embedCred = resolveRequired(embedId);
  const embedMapped = mapSTProviderToMemU(embedCred.provider);
  llm_profiles["embedding"] = {
    provider: embedMapped.provider,
    base_url: embedCred.baseUrl,
    api_key: embedCred.key,
    chat_model: embedCred.model,
    client_backend: embedMapped.client_backend,
    embed_model: (cfg as any).embeddingModel || "text-embedding-3-small",
    ...(embedMapped.provider_hint ? { provider_hint: embedMapped.provider_hint } : {}),
  };

  // Keep a usable "default" profile even when global default is not referenced by steps.
  // This avoids failing on integrations that expect a default key to exist.
  if (!llm_profiles["default"]) {
    const fallback = llm_profiles[idToName(step("preprocess"))] || llm_profiles["embedding"];
    if (fallback) llm_profiles["default"] = { ...fallback };
  }

  const memorize_config: any = {
    preprocess_llm_profile: idToName(step("preprocess")),
    memory_extract_llm_profile: idToName(step("memory_extract")),
    category_update_llm_profile: idToName(step("category_update")),
  };

  const retrieve_config: any = {
    sufficiency_check_llm_profile: idToName(step("reflection")),
    llm_ranking_llm_profile: idToName(step("ranking")),
  };

  const payload: any = {
    user: { user_id: userId, soul_id: characterId },
    llm_profiles,
    memorize_config,
    retrieve_config,
  };

  if (conversation) payload.conversation = conversation;
  if (typeof opts?.conversationId === 'string' && opts.conversationId.trim()) {
    payload.conversationId = opts.conversationId.trim();
  }

  // Minimal pointer (no filesystem probing): just store the expected SillyTavern chat file path.
  try {
    const chatFileName = String(opts?.chatFileName || '').trim();
    const characterName = String(opts?.characterName || '').trim();
    if (chatFileName) {
      const name = chatFileName.endsWith('.jsonl') ? chatFileName : `${chatFileName}.jsonl`;
      const charDir = safeFsName(characterName || characterId);
      // Assumption: single-user default install (default-user).
      payload.resource_url = path.join('data', 'default-user', 'chats', charDir, name);
    }
  } catch {
    // ignore; resource_url is optional
  }

  return payload;
}

// ---------------------------------
// Local MCP/HTTP server (FastAPI)
// ---------------------------------

let _localServerSessionId: string | null = null;
let _externalSpawnCooldownUntilUnixMs: number = 0;

// External server identity (read from /health). Used by the UI extension to detect restarts.
let _externalServerInstanceId: string | null = null;
let _externalServerEphemeralDb: boolean | null = null;



function getExternalServerBaseUrl(_cfg: MemuPluginConfig): string {
  const raw = String(process.env.MEMU_SERVER_URL || process.env.MCP_MEMU_SERVER_URL || '').trim();
  if (raw) return raw.replace(/\/$/, '');

  // If the user provided a serverPath, prefer reading host/port from that server's config.json.
  try {
    const root = String((_cfg as any).serverPath || '').trim();
    if (root) {
      const cfgPath = path.join(root, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const txt = fs.readFileSync(cfgPath, 'utf8');
        const parsed: any = txt ? JSON.parse(txt) : null;
        const listen: any = parsed && typeof parsed === 'object' ? (parsed as any).listen : null;
        const hostRaw = listen && typeof listen.host === 'string' ? String(listen.host) : '';
        const portRaw = listen && (typeof listen.port === 'number' || typeof listen.port === 'string') ? String(listen.port) : '';
        const port = portRaw && /^\d+$/.test(portRaw) ? parseInt(portRaw, 10) : 0;
        // If server binds to 0.0.0.0, the client should use loopback.
        const host = hostRaw === '0.0.0.0' ? '127.0.0.1' : (hostRaw || '127.0.0.1');
        if (port > 0) return `http://${host}:${port}`;
      }
    }
  } catch {
    // ignore and fall back
  }

  return 'http://127.0.0.1:8099';
}

function getExternalServerRunPy(cfg: MemuPluginConfig): string | null {
  const root = String((cfg as any).serverPath || '').trim();
  if (!root) return null;
  return path.join(root, 'run.py');
}

function _expandTilde(pth: string): string {
  const home = String(process.env.HOME || process.env.USERPROFILE || '').trim();
  if (!home) return pth;
  return pth.startsWith('~/') ? path.join(home, pth.slice(2)) : (pth === '~' ? home : pth);
}

function _readExternalServerConfig(root: string): any | null {
  try {
    const cfgPath = path.join(root, 'config.json');
    if (!fs.existsSync(cfgPath)) return null;
    const txt = fs.readFileSync(cfgPath, 'utf8');
    const parsed: any = txt ? JSON.parse(txt) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getExternalServerPython(cfg: MemuPluginConfig): string {
  const root = String((cfg as any).serverPath || '').trim();
  if (root) {
    const c = _readExternalServerConfig(root);
    const pyObj = c && typeof (c as any).python === 'object' ? (c as any).python : null;
    const exeRaw = pyObj && typeof pyObj.executable === 'string' ? String(pyObj.executable).trim() : '';
    const exe = exeRaw ? _expandTilde(exeRaw) : '';
    if (exe && fs.existsSync(exe)) return exe;

    const venvPy = path.join(root, '.venv', 'bin', 'python3');
    const venvPy2 = path.join(root, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPy)) return venvPy;
    if (fs.existsSync(venvPy2)) return venvPy2;
    const venvWin = path.join(root, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvWin)) return venvWin;
  }
  return 'python3';
}

function _getExternalLogFile(cfg: MemuPluginConfig): string | null {
  const root = String((cfg as any).serverPath || '').trim();
  if (!root) return null;
  const rootAbs = path.resolve(root);

  const c = _readExternalServerConfig(root);
  const logRaw = c && typeof (c as any).log_file === 'string' ? String((c as any).log_file).trim() : '';
  if (logRaw) {
    const expanded = _expandTilde(logRaw);
    if (path.isAbsolute(expanded)) return expanded;
    const candidate = path.resolve(root, expanded);
    if (candidate.startsWith(rootAbs + path.sep) || candidate === rootAbs) return candidate;
    return path.join(rootAbs, 'mcp-memu-server.log');
  }

  return path.join(rootAbs, 'mcp-memu-server.log');
}

function _readLogTail(logPath: string | null, maxLines: number): string[] {
  try {
    if (!logPath) return [];
    if (!fs.existsSync(logPath)) return [];
    const stat = fs.statSync(logPath);
    const size = stat && typeof stat.size === 'number' ? stat.size : 0;
    if (!size) return [];
    const readBytes = Math.min(size, 64 * 1024);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, size - readBytes);
    fs.closeSync(fd);
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.slice(-Math.max(1, maxLines));
  } catch {
    return [];
  }
}

function spawnExternalServer(pythonExe: string, runPyPath: string, cfg?: MemuPluginConfig): void {
  let logStream: fs.WriteStream | null = null;
  let logPath: string | null = null;

  try {
    logPath = cfg ? _getExternalLogFile(cfg) : null;
    if (logPath) {
      try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* ignore */ }
      try { logStream = fs.createWriteStream(logPath, { flags: 'a' }); } catch { logStream = null; }
      try { logStream?.write(`\n--- start ${new Date().toISOString()} ---\n`); } catch { /* ignore */ }
    }

    const child = spawn(pythonExe, [runPyPath], {
      cwd: path.dirname(runPyPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: true,
    });

    // Stream logs to file. Keep terminal output concise (state, not a firehose).
    if (child && (child as any).stdout) {
      try {
        (child as any).stdout.on('data', (chunk: any) => {
          try { logStream?.write(chunk); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
    }
    if (child && (child as any).stderr) {
      try {
        (child as any).stderr.on('data', (chunk: any) => {
          try { logStream?.write(chunk); } catch { /* ignore */ }
          // (stderr is still captured in the log file)
        });
      } catch { /* ignore */ }
    }

    child.on('error', (e: any) => {
      const msg = e?.message ? String(e.message) : String(e);
      try { console.error(chalk.red(MODULE_NAME), 'Spawn failed:', msg); } catch { /* ignore */ }
      try { logStream?.write(`\n[spawn error] ${msg}\n`); } catch { /* ignore */ }
    });

    child.unref();
    const childPid = (child && typeof (child as any).pid === 'number') ? (child as any).pid : null;

    try { console.log(chalk.gray(MODULE_NAME), `pid=${childPid || 'unknown'}`); } catch { /* ignore */ }
    try { logStream?.write(`[spawned pid=${childPid || 'unknown'}]\n`); } catch { /* ignore */ }
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    try { console.error(chalk.red(MODULE_NAME), 'Spawn failed:', msg); } catch { /* ignore */ }
    try { logStream?.write(`\n[spawn error] ${msg}\n`); } catch { /* ignore */ }
  }
}

async function waitForServerHealthy(baseUrl: string): Promise<void> {
  const f: any = (globalThis as any).fetch;
  if (!f) return; // will fail later with a clearer error

  for (let i = 0; i < 50; i++) {
    try {
      const r = await f(baseUrl + '/health');
      if (r && r.ok) return;
    } catch {
      // keep trying
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function isServerHealthy(baseUrl: string): Promise<boolean> {
  try {
    const f: any = (globalThis as any).fetch;
    if (!f) return false;
    const r = await f(baseUrl + '/health');
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

async function ensureLocalServer(
  cfg: MemuPluginConfig,
  opts: { forceStart?: boolean } = {},
): Promise<{ baseUrl: string; host: string; port: number }> {
  // External server (mcp-memu-server). No Python probing required here.
  const baseUrl = getExternalServerBaseUrl(cfg);
  const autoStartServer = cfg.autoStartServer !== false;
  const shouldStartIfDown = autoStartServer || opts.forceStart === true;
  const okNow = await isServerHealthy(baseUrl);

  if (!okNow) {
    if (shouldStartIfDown) {
      // Start-on-demand: if server isn't healthy, try to spawn it (no shell) and then wait briefly.
      const runPy = getExternalServerRunPy(cfg);
      if (runPy && fs.existsSync(runPy)) {
        const now = Date.now();
        if (now >= _externalSpawnCooldownUntilUnixMs) {
          _externalSpawnCooldownUntilUnixMs = now + 5000;
          const pythonExe = getExternalServerPython(cfg);
          spawnExternalServer(pythonExe, runPy, cfg);
        }
      }
      await waitForServerHealthy(baseUrl);
    }
    if (!(await isServerHealthy(baseUrl))) {
      if (shouldStartIfDown) {
        throw new Error("mcp-memu-server did not become healthy");
      }
      throw new Error("mcp-memu-server is not healthy (autoStartServer=false)");
    }
  }

  if (!_localServerSessionId) _localServerSessionId = 'external-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  let host = '127.0.0.1';
  let port = 0;
  try {
    const u = new URL(baseUrl);
    host = u.hostname || host;
    port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
  } catch {
    // ignore
  }

  return { baseUrl, host, port };
}

type ExternalServerShutdownInfo = {
  draining: boolean;
  stopping: boolean;
  requestedAtUnix: number | null;
  requestedBy: string | null;
  reason: string | null;
  maxWaitSec: number;
  timedOut: boolean;
  activeHttpRequests: number;
  activeWorkRequests: number;
};

async function _externalServerHealthInfo(baseUrl: string): Promise<{ healthy: boolean; serverInstanceId?: string | null; ephemeralDb?: boolean | null; shutdown?: ExternalServerShutdownInfo | null }> {
  try {
    const f: any = (globalThis as any).fetch;
    if (!f) return { healthy: false };
    const r = await f(baseUrl + '/health');
    if (!r || !r.ok) return { healthy: false };

    const txt = await r.text();
    let parsed: any = null;
    try { parsed = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }

    const serverInstanceId = parsed && typeof parsed.serverInstanceId === 'string' ? parsed.serverInstanceId : null;
    const ephemeralDb = parsed && typeof parsed.ephemeralDb === 'boolean' ? parsed.ephemeralDb : null;
    const shutdownRaw = parsed && typeof parsed.shutdown === 'object' ? parsed.shutdown : null;
    const shutdown: ExternalServerShutdownInfo | null = shutdownRaw ? {
      draining: shutdownRaw.draining === true,
      stopping: shutdownRaw.stopping === true,
      requestedAtUnix: Number.isFinite(Number(shutdownRaw.requestedAtUnix)) ? Number(shutdownRaw.requestedAtUnix) : null,
      requestedBy: typeof shutdownRaw.requestedBy === 'string' ? shutdownRaw.requestedBy : null,
      reason: typeof shutdownRaw.reason === 'string' ? shutdownRaw.reason : null,
      maxWaitSec: Number.isFinite(Number(shutdownRaw.maxWaitSec)) ? Number(shutdownRaw.maxWaitSec) : 0,
      timedOut: shutdownRaw.timedOut === true,
      activeHttpRequests: Number.isFinite(Number(shutdownRaw.activeHttpRequests)) ? Number(shutdownRaw.activeHttpRequests) : 0,
      activeWorkRequests: Number.isFinite(Number(shutdownRaw.activeWorkRequests)) ? Number(shutdownRaw.activeWorkRequests) : 0,
    } : null;

    _externalServerInstanceId = serverInstanceId;
    _externalServerEphemeralDb = ephemeralDb;

    return { healthy: true, serverInstanceId, ephemeralDb, shutdown };
  } catch {
    return { healthy: false };
  }
}

export async function externalServerStatus(): Promise<{ ok: boolean; running: boolean; healthy: boolean; pid?: number | null; baseUrl?: string; logPath?: string | null; logTail?: string[]; serverInstanceId?: string | null; ephemeralDb?: boolean | null; shutdown?: ExternalServerShutdownInfo | null }> {
  try {
    const cfg = readPluginConfig();

    const baseUrl = getExternalServerBaseUrl(cfg);
    const healthInfo = await _externalServerHealthInfo(baseUrl);
    const healthy = !!healthInfo.healthy;
    const logPath = _getExternalLogFile(cfg);
    const logTail = _readLogTail(logPath, 25);

    return {
      ok: true,
      running: healthy,
      healthy,
      pid: null,
      baseUrl,
      logPath,
      logTail,
      serverInstanceId: _externalServerInstanceId,
      ephemeralDb: _externalServerEphemeralDb,
      shutdown: healthInfo.shutdown || null,
    };
  } catch (e: any) {
    return { ok: false, running: false, healthy: false, pid: null };
  }
}

export async function externalServerPingInfo(): Promise<{ ok: boolean; serverInstanceId?: string | null; ephemeralDb?: boolean | null }> {
  try {
    const cfg = readPluginConfig();
    const baseUrl = getExternalServerBaseUrl(cfg);
    const healthInfo = await _externalServerHealthInfo(baseUrl);
    return {
      ok: true,
      serverInstanceId: healthInfo.serverInstanceId ?? _externalServerInstanceId,
      ephemeralDb: healthInfo.ephemeralDb ?? _externalServerEphemeralDb,
    };
  } catch {
    return {
      ok: true,
      serverInstanceId: _externalServerInstanceId,
      ephemeralDb: _externalServerEphemeralDb,
    };
  }
}

export async function externalServerStart(): Promise<{ ok: boolean; message?: string; status?: any }> {
  try {
    const cfg = readPluginConfig();
    await ensureLocalServer(cfg, { forceStart: true });
    return { ok: true, status: await externalServerStatus() };
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    return { ok: false, message: msg, status: await externalServerStatus() };
  }
}

export async function externalServerStop(): Promise<{ ok: boolean; message?: string; status?: any }> {
  try {
    const cfg = readPluginConfig();

    const baseUrl = getExternalServerBaseUrl(cfg);
    const healthBefore = await _externalServerHealthInfo(baseUrl);
    if (!healthBefore.healthy) {
      return { ok: true, message: 'Server process not running.', status: await externalServerStatus() };
    }

    await httpJson(baseUrl, '/admin/shutdown', 'POST', {
      requested_by: 'sillytavern-memu-plugin',
      reason: 'stop requested from SillyTavern extension',
      // 0 => wait until active work is done.
      max_wait_sec: 0,
    });

    // Wait briefly for full shutdown; keep drain state as a soft-success if
    // the server is still finishing in-flight work.
    let sawDraining = false;
    for (let i = 0; i < 80; i++) {
      const hi = await _externalServerHealthInfo(baseUrl);
      if (!hi.healthy) break;
      if (hi.shutdown && (hi.shutdown.draining || hi.shutdown.stopping)) {
        sawDraining = true;
      }
      await new Promise((r) => setTimeout(r, sawDraining ? 250 : 150));
    }

    const hi2 = await _externalServerHealthInfo(baseUrl);
    if (!hi2.healthy) {
      return { ok: true, message: 'Server stopped gracefully.', status: await externalServerStatus() };
    }
    if (sawDraining || (hi2.shutdown && (hi2.shutdown.draining || hi2.shutdown.stopping))) {
      return { ok: true, message: 'Graceful shutdown requested; server is draining.', status: await externalServerStatus() };
    }
    return { ok: false, message: 'Shutdown request did not change server state.', status: await externalServerStatus() };
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    return { ok: false, message: msg, status: await externalServerStatus() };
  }
}

export function registerServerControl(router: Router): void {
  router.get('/server/status', async (_req: Request, res: Response) => {
    return res.json(await externalServerStatus());
  });

  router.post('/server/start', async (_req: Request, res: Response) => {
    return res.json(await externalServerStart());
  });

  router.post('/server/stop', async (_req: Request, res: Response) => {
    return res.json(await externalServerStop());
  });
}


async function httpJson(baseUrl: string, urlPath: string, method: string, body?: any): Promise<any> {
  const f: any = (globalThis as any).fetch;
  if (!f) throw new Error('This SillyTavern Node runtime does not support fetch(). Upgrade Node to 18+.');

  const fullUrl = baseUrl + urlPath;
  const opts: any = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const r = await f(fullUrl, opts);
  const txt = await r.text();
  let parsed: any = null;
  try { parsed = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }
  if (!r.ok) {
    const msg = (parsed && (parsed.detail || parsed.error)) ? String(parsed.detail || parsed.error) : (txt || `HTTP ${r.status}`);
    throw new Error(msg);
  }
  return parsed;
}

// ---------------------------------
// Local task status emulation
// ---------------------------------

type LocalTaskStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILURE";

const localTasks = new Map<
  string,
  { status: LocalTaskStatus; createdAt: number; updatedAt: number; error?: string }
>();

const LOCAL_TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LOCAL_TASK_MAX = 200;

function pruneLocalTasks(now: number = Date.now()): void {
  // Drop old tasks first (keeps memory bounded even if something never polls).
  const cutoff = now - LOCAL_TASK_TTL_MS;
  for (const [id, t] of localTasks) {
    if ((t.updatedAt || t.createdAt) < cutoff) localTasks.delete(id);
  }

  // If still too many, drop oldest by createdAt (Map preserves insertion order,
  // but we want true oldest when tasks might be updated).
  if (localTasks.size <= LOCAL_TASK_MAX) return;
  const items = Array.from(localTasks.entries());
  items.sort((a, b) => (a[1].createdAt - b[1].createdAt));
  for (let i = 0; i < items.length && localTasks.size > LOCAL_TASK_MAX; i++) {
    localTasks.delete(items[i][0]);
  }
}

function makeTaskId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function setTask(taskId: string, patch: Partial<{ status: LocalTaskStatus; updatedAt: number; error?: string }>) {
  const prev = localTasks.get(taskId);
  if (!prev) return;
  localTasks.set(taskId, { ...prev, ...patch, updatedAt: Date.now() });
  pruneLocalTasks();
}

function applyTimeZoneHints(payload: any, timeZone: string, timeZoneOffsetMin: number | undefined): void {
  if (timeZone) payload.timeZone = timeZone;
  if (timeZoneOffsetMin !== undefined) payload.timeZoneOffsetMin = timeZoneOffsetMin;
}

export async function proxyMemorizeConversation(req: Request, res: Response): Promise<void> {
  const userId = String(req.body?.userId || "");
  const conversationId = String(req.body?.conversationId || req.body?.conversation_id || "");
  // KISS: soul scope is the character name.
  // If characterId is missing, fall back to characterName (and vice-versa).
  const characterId = String(req.body?.soulId || req.body?.soulName || "");
  const characterName = String(req.body?.soulName || req.body?.soulId || "");
  const userName = String(req.body?.userName || "").trim();
  const soulName = String(req.body?.soulName || characterName || characterId || "").trim();
  const chatFileName = String(req.body?.chatFileName || "");
  const conversation = req.body?.conversation;
  const forceRaw = req.query?.force ?? req.body?.force;
  const force = forceRaw === true || String(forceRaw || "").trim().toLowerCase() === "true";
  const timeZone = String(req.body?.timeZone || "").trim();
  const timeZoneOffsetMinRaw = req.body?.timeZoneOffsetMin;
  const timeZoneOffsetMin = Number.isFinite(Number(timeZoneOffsetMinRaw)) ? Number(timeZoneOffsetMinRaw) : undefined;

  if (!userId || !characterId || !Array.isArray(conversation)) {
    res.status(400).json({ error: "Missing userId/soulId(character name)/conversation" });
    return;
  }

  pruneLocalTasks();

  const taskId = makeTaskId();
  localTasks.set(taskId, { status: "PENDING", createdAt: Date.now(), updatedAt: Date.now() });

  // Fire and forget
  void (async () => {
    try {
      setTask(taskId, { status: "PROCESSING" });
      const cfg = readPluginConfig();
      const namedConversation = conversation.map((msg: any) => {
        if (!msg || typeof msg !== "object") return msg;
        if (msg.role === "user" && userName) return { ...msg, name: userName };
        if (msg.role === "assistant" && soulName) return { ...msg, name: soulName };
        return msg;
      });
      const srv = await ensureLocalServer(cfg);
      const payload = buildMemuPayloadForLocal(cfg, userId, characterId, namedConversation, {
        characterName,
        chatFileName,
        conversationId,
      });
      applyTimeZoneHints(payload as any, timeZone, timeZoneOffsetMin);
      await httpJson(srv.baseUrl, force ? '/memorize?force=true' : '/memorize', 'POST', payload);
      setTask(taskId, { status: 'SUCCESS' });
    } catch (e: any) {
      setTask(taskId, { status: "FAILURE", error: e?.message || String(e) });
    }
  })();

  res.json({ taskId });
}

export async function proxyGetTaskStatus(req: Request, res: Response): Promise<void> {
  const taskId = String(req.body?.taskId || "");
  const task = localTasks.get(taskId);
  if (!task) {
    // Keep backward compatibility (status field) but provide a hint for debugging.
    res.json({ status: "FAILURE", error: "Unknown taskId" });
    return;
  }
  // Include error (when present) to help diagnose local-mode failures.
  res.json({ status: task.status, ...(task.error ? { error: task.error } : {}) });
}

export async function proxyGetTaskSummaryReady(req: Request, res: Response): Promise<void> {
  const taskId = String(req.body?.taskId || "");
  const task = localTasks.get(taskId);
  res.json({ allReady: task?.status === "SUCCESS" });
}

export async function proxyRetrieveDefaultCategories(req: Request, res: Response): Promise<void> {
  const userId = String(req.body?.userId || "");
  const characterId = String(req.body?.soulId || req.body?.soulName || "");
  if (!userId || !characterId) {
    res.status(400).json({ error: "Missing userId/soulId(character name)" });
    return;
  }

  const cfg = readPluginConfig();
  let srv: any = null;

  const payloadBase = buildMemuPayloadForLocal(cfg, userId, characterId, undefined);

  let storedCats: any[] = [];
  try {
    srv = await ensureLocalServer(cfg);
    // POST /categories/search uses _get_service_from_payload() (API keys from ST profiles).
    const payload = payloadBase;
    payload.user = { user_id: userId, soul_id: characterId };
    const resp: any = await httpJson(srv.baseUrl, '/categories/search', 'POST', payload);
    storedCats = Array.isArray(resp?.categories) ? resp.categories : [];
  } catch (e: any) {
    console.error(chalk.red(MODULE_NAME), 'retrieveDefaultCategories: failed to load stored categories:', e?.message || String(e));
  }

  const out: any[] = [];
  const seen = new Set<string>();
  for (const c of storedCats) {
    const nm = String(c?.name || '').trim();
    const summary = String(c?.summary || '').trim();
    if (!nm || !summary) continue;
    const key = nm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, name: nm, summary });
  }

  if (!_loggedDefaultCategories) {
    console.log(chalk.gray(MODULE_NAME), 'retrieveDefaultCategories: stored=', out.length, 'backend=server');
    _loggedDefaultCategories = true;
  }

  res.json({ categories: out });
}

export async function proxyConversationRetrieve(req: Request, res: Response): Promise<void> {
  const userId = String(req.body?.userId || "");
  const soulId = String(req.body?.soulId || req.body?.soulName || "");
  const conversationId = String(req.body?.conversationId || req.body?.conversation_id || "");
  const method = String(req.body?.method || "").trim().toLowerCase();
  const query = String(req.body?.query || "");
  const queries = Array.isArray(req.body?.queries) ? req.body.queries : undefined;

  if (!userId || !soulId || !conversationId) {
    res.status(400).json({ error: "Missing userId/soulId(character name)/conversationId" });
    return;
  }
  if (method !== "rag" && method !== "llm") {
    res.status(400).json({ error: "Invalid method (expected rag or llm)" });
    return;
  }
  if (!query.trim() && (!queries || queries.length === 0)) {
    res.status(400).json({ error: "Missing query or queries" });
    return;
  }

  try {
    const cfg = readPluginConfig();
    const srv = await ensureLocalServer(cfg);
    const payload = buildMemuPayloadForLocal(cfg, userId, soulId, undefined, {
      conversationId,
    });

    payload.user = { user_id: userId, soul_id: soulId };
    payload.method = method;
    payload.query = query;
    if (queries && queries.length > 0) {
      payload.queries = queries;
    }
    if (Array.isArray(req.body?.history)) {
      payload.history = req.body.history;
    }
    if (req.body?.buildTurnPrompt || req.body?.build_turn_prompt) {
      payload.build_turn_prompt = true;
    }
    if (req.body?.soul_card) {
      payload.soul_card = req.body.soul_card;
    }

    const resp = await httpJson(
      srv.baseUrl,
      `/conversation/${encodeURIComponent(conversationId)}/retrieve`,
      "POST",
      payload,
    );
    res.json(resp);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}

export async function proxyConversationTurn(req: Request, res: Response): Promise<void> {
  const userId = String(req.body?.userId || "");
  const soulId = String(req.body?.soulId || req.body?.soulName || "");
  const conversationId = String(req.body?.conversationId || req.body?.conversation_id || "");
  const message = String(req.body?.message || req.body?.query || req.body?.text || "");
  const history = Array.isArray(req.body?.history) ? req.body.history : undefined;
  const runApimw = req.body?.runApimw ?? req.body?.run_apimw;
  const waitApimw = req.body?.waitApimw ?? req.body?.wait_apimw;
  const dryRun = req.body?.dryRun ?? req.body?.dry_run;
  const debug = req.body?.debug;

  if (!userId || !soulId || !conversationId) {
    res.status(400).json({ error: "Missing userId/soulId(character name)/conversationId" });
    return;
  }
  if (!message.trim()) {
    res.status(400).json({ error: "Missing message" });
    return;
  }

  try {
    const cfg = readPluginConfig();
    const srv = await ensureLocalServer(cfg);
    const payload = buildMemuPayloadForLocal(cfg, userId, soulId, undefined, {
      conversationId,
    });

    payload.user = { user_id: userId, soul_id: soulId };
    payload.message = message;
    if (history && history.length > 0) payload.history = history;
    if (runApimw !== undefined) payload.run_apimw = !!runApimw;
    if (waitApimw !== undefined) payload.wait_apimw = !!waitApimw;
    if (dryRun !== undefined) payload.dry_run = !!dryRun;
    if (debug !== undefined) payload.debug = !!debug;
    if (req.body?.soul_card) {
      payload.soul_card = req.body.soul_card;
    }

    const resp = await httpJson(
      srv.baseUrl,
      `/conversation/${encodeURIComponent(conversationId)}/turn`,
      "POST",
      payload,
    );
    res.json(resp);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}

export async function proxyConversationTurnUndo(req: Request, res: Response): Promise<void> {
  const userId = String(req.body?.userId || "");
  const soulId = String(req.body?.soulId || req.body?.soulName || "");
  const conversationId = String(req.body?.conversationId || req.body?.conversation_id || "");
  if (!userId || !soulId || !conversationId) {
    res.status(400).json({ error: "Missing userId/soulId/conversationId" });
    return;
  }

  try {
    const cfg = readPluginConfig();
    const srv = await ensureLocalServer(cfg);
    const payload = buildMemuPayloadForLocal(cfg, userId, soulId, undefined, { conversationId });
    payload.user = { user_id: userId, soul_id: soulId };
    const resp = await httpJson(
      srv.baseUrl,
      `/conversation/${encodeURIComponent(conversationId)}/turn/undo`,
      "POST",
      payload,
    );
    res.json(resp);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}

export async function proxyScopeStorageProbe(req: Request, res: Response): Promise<void> {
  const userId = String(req.body?.userId || "");
  const soulId = String(req.body?.soulId || req.body?.soulName || "");
  if (!userId || !soulId) {
    res.status(400).json({ error: "Missing userId/soulId(character name)" });
    return;
  }

  try {
    const cfg = readPluginConfig();
    const srv = await ensureLocalServer(cfg);
    const health: any = await httpJson(srv.baseUrl, "/health", "GET");

    const storage = (health && typeof health.storage === "object") ? health.storage : null;
    const providerRaw = String(storage?.provider || "").trim().toLowerCase();
    const provider = providerRaw || "sqlite";
    const ephemeralDb = health?.ephemeralDb === true;

    if (ephemeralDb) {
      res.json({
        ok: true,
        userId,
        soulId,
        provider,
        missing: false,
        empty: false,
        missingOrEmpty: false,
        reason: "ephemeral_db",
      });
      return;
    }

    if (providerRaw && providerRaw !== "sqlite" && providerRaw !== "sqlite3") {
      res.json({
        ok: true,
        userId,
        soulId,
        provider,
        missing: false,
        empty: false,
        missingOrEmpty: false,
        reason: "provider_not_sqlite",
      });
      return;
    }

    const sqliteDirRaw = typeof storage?.sqlite_dir === "string" ? String(storage.sqlite_dir).trim() : "";
    if (!sqliteDirRaw) {
      res.status(500).json({
        ok: false,
        userId,
        soulId,
        provider,
        reason: "sqlite_dir_missing",
      });
      return;
    }

    const sqliteDir = path.resolve(_expandTilde(sqliteDirRaw));
    const dbFile = `${sanitizeScopedDbFilename(soulId)}.db`;
    const dbPath = path.join(sqliteDir, dbFile);
    if (!fs.existsSync(dbPath)) {
      res.json({
        ok: true,
        userId,
        soulId,
        provider,
        dbPath,
        exists: false,
        fileSize: 0,
        scopedRowCount: 0,
        missing: true,
        empty: true,
        missingOrEmpty: true,
        reason: "sqlite_file_missing",
      });
      return;
    }

    let fileSize = 0;
    try {
      fileSize = Math.max(0, Number(fs.statSync(dbPath).size || 0));
    } catch {
      fileSize = 0;
    }
    if (fileSize <= 0) {
      res.json({
        ok: true,
        userId,
        soulId,
        provider,
        dbPath,
        exists: true,
        fileSize,
        scopedRowCount: 0,
        missing: false,
        empty: true,
        missingOrEmpty: true,
        reason: "sqlite_file_empty",
      });
      return;
    }

    const q = new URLSearchParams();
    q.set("user_id", userId);
    q.set("soul_id", soulId);
    const counts: any = await httpJson(srv.baseUrl, `/diag/sqlite/counts?${q.toString()}`, "GET");

    if (!counts || counts.ok !== true || !counts.tables || typeof counts.tables !== "object") {
      res.json({
        ok: true,
        userId,
        soulId,
        provider,
        dbPath,
        exists: true,
        fileSize,
        missing: false,
        empty: false,
        missingOrEmpty: false,
        reason: "counts_unavailable",
      });
      return;
    }

    let scopedRowCount = 0;
    for (const tableInfo of Object.values(counts.tables as Record<string, any>)) {
      const scoped = Number((tableInfo as any)?.scoped ?? 0);
      if (Number.isFinite(scoped) && scoped > 0) scopedRowCount += scoped;
    }

    const empty = scopedRowCount <= 0;
    res.json({
      ok: true,
      userId,
      soulId,
      provider,
      dbPath,
      exists: true,
      fileSize,
      scopedRowCount,
      missing: false,
      empty,
      missingOrEmpty: empty,
      reason: empty ? "scoped_rows_zero" : "scoped_rows_present",
    });
  } catch (e: any) {
    res.status(500).json({
      ok: false,
      userId,
      soulId,
      reason: e?.message || String(e),
    });
  }
}

export async function proxyLocalHealth(_req: Request, res: Response): Promise<void> {
  try {
    const cfg = readPluginConfig();
    const srv = await ensureLocalServer(cfg);
    const health = await httpJson(srv.baseUrl, '/health', 'GET');
    res.json({ ok: true, server: { baseUrl: srv.baseUrl, host: srv.host, port: srv.port }, health, st_root: getStRoot() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// ---------------------
// Route registrations
// ---------------------

export function registerMemorizeConversation(router: Router): void {
  router.post("/memorizeConversation", proxyMemorizeConversation);
}

export function registerGetTaskStatus(router: Router): void {
  router.post("/getTaskStatus", proxyGetTaskStatus);
}

export function registerGetTaskSummaryReady(router: Router): void {
  router.post("/getTaskSummaryReady", proxyGetTaskSummaryReady);
}

export function registerRetrieveDefaultCategories(router: Router): void {
  router.post("/retrieveDefaultCategories", proxyRetrieveDefaultCategories);
}

export function registerConversationRetrieve(router: Router): void {
  router.post("/conversationRetrieve", proxyConversationRetrieve);
}

export function registerConversationTurn(router: Router): void {
  router.post("/conversationTurn", proxyConversationTurn);
}

export function registerConversationTurnUndo(router: Router): void {
  router.post("/conversationTurnUndo", proxyConversationTurnUndo);
}

export async function proxyConversationCacheClear(req: Request, res: Response): Promise<void> {
  const userId = String(req.body?.userId || "");
  const soulId = String(req.body?.soulId || req.body?.soulName || "");
  const conversationId = String(req.body?.conversationId || req.body?.conversation_id || "");
  if (!userId || !soulId || !conversationId) {
    res.status(400).json({ error: "Missing userId/soulId/conversationId" });
    return;
  }
  try {
    const cfg = readPluginConfig();
    const srv = await ensureLocalServer(cfg);
    const payload = buildMemuPayloadForLocal(cfg, userId, soulId, undefined, { conversationId });
    payload.user = { user_id: userId, soul_id: soulId };
    const resp = await httpJson(
      srv.baseUrl,
      `/conversation/${encodeURIComponent(conversationId)}/cache/clear`,
      "POST",
      payload,
    );
    res.json(resp);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}

export function registerConversationCacheClear(router: Router): void {
  router.post("/conversationCacheClear", proxyConversationCacheClear);
}

export function registerScopeStorageProbe(router: Router): void {
  router.post("/scopeStorageProbe", proxyScopeStorageProbe);
}

export function registerLocalHealth(router: Router): void {
  router.get('/health', proxyLocalHealth);
}
