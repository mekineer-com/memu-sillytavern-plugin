import bodyParser from "body-parser";
import chalk from "chalk";
import { Router } from "express";
import type { Request, Response } from "express";
import { MemuClient } from "memu-js";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { MEMU_BASE_URL, MEMU_DEFAULT_MAX_RETRIES, MEMU_DEFAULT_TIMEOUT, MODULE_NAME } from "./consts";

/**
 * NOTE:
 *  - Cloud mode: proxy to memU SaaS (memu-js)
 *  - Local mode: launch local Python memU per operation (simple + robust)
 *
 * Local mode goal:
 *  - Reuse SillyTavern connection profiles (base_url + model)
 *  - Reuse SillyTavern secrets.json keys (best-effort; ST doesn't bind keys to profiles)
 *  - Persist per (userId, agentId) via sqlite DB under <ST_ROOT>/data/memu-local/
 */

type MemuMode = "cloud" | "local";

type MemuStep =
  | "preprocess"
  | "memory_extract"
  | "category_update"
  | "reflection"
  | "ranking"
  | "embeddings";

interface MemuPluginConfig {
  version: number;
  mode: MemuMode;
  defaultProfileId: string;
  stepProfileId: Partial<Record<MemuStep, string>>;
  updatedAt: string;
  pythonCmd?: string; // optional override (otherwise auto)
  /** Effective embedding model (legacy single-field). */
  embeddingModel?: string;
  /** Dropdown-selected embedding model (preferred over manual). */
  embeddingModelSelected?: string;
  /** Optional manual embedding model (used when dropdown is blank). */
  embeddingModelManual?: string;
}

const CONFIG_FILENAME = "memu-plugin.config.json";
const CONFIG_PATH = path.join(process.cwd(), CONFIG_FILENAME);

const DEFAULT_CONFIG: MemuPluginConfig = {
  version: 1,
  mode: "cloud",
  defaultProfileId: "default",
  stepProfileId: {},
  updatedAt: new Date().toISOString(),
};

function readJsonIfExists(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sanitizeIncomingConfig(obj: any): MemuPluginConfig {
  const cfg: MemuPluginConfig = {
    ...DEFAULT_CONFIG,
    ...(obj && typeof obj === "object" ? obj : {}),
  };

  cfg.version = 1;
  cfg.mode = cfg.mode === "local" ? "local" : "cloud";
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
  cfg.updatedAt = new Date().toISOString();

  if (typeof (cfg as any).pythonCmd === "string" && (cfg as any).pythonCmd.trim()) {
    cfg.pythonCmd = (cfg as any).pythonCmd.trim();
  } else {
    delete cfg.pythonCmd;
  }

  if (typeof (cfg as any).embeddingModel === 'string' && (cfg as any).embeddingModel.trim()) {
    (cfg as any).embeddingModel = (cfg as any).embeddingModel.trim();
  } else {
    delete (cfg as any).embeddingModel;
  }

  return cfg;
}

function readPluginConfig(): MemuPluginConfig {
  const obj = readJsonIfExists(CONFIG_PATH);
  if (!obj) return { ...DEFAULT_CONFIG };
  return sanitizeIncomingConfig(obj);
}
export function getPluginConfig(): MemuPluginConfig {
  return readPluginConfig();
}

export function setPluginConfig(obj: any): MemuPluginConfig {
  const cfg = sanitizeIncomingConfig(obj);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    // non-fatal
    console.warn(chalk.yellow(MODULE_NAME), 'Failed to write config:', e);
  }
  return cfg;
}

function isLocalMode(): boolean {
  return readPluginConfig().mode === "local";
}

function getPythonCmd(cfg: MemuPluginConfig): string {
  if (cfg.pythonCmd) return cfg.pythonCmd;
  return process.platform === "win32" ? "python" : "python3";
}

// -----------------------------
// Local: ST connection profiles
// -----------------------------

type AnyObject = Record<string, any>;

function listSTUserDirs(): string[] {
  const root = process.cwd();
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
  const out: AnyObject[] = [];
  const userDirs = listSTUserDirs();
  for (const dir of userDirs) {
    const settings = readJsonIfExists(path.join(dir, "settings.json"));
    if (!settings) continue;
    const found: AnyObject[] = [];
    deepCollectProfiles(settings, found);
    for (const prof of found) {
      // Attach where we found it so we can load the matching secrets.json.
      (prof as any).__st_user_dir = dir;
      out.push(prof);
    }
  }

  // Deduplicate by id (keep the first occurrence, preferring default-user by order above)
  const seen = new Set<string>();
  return out.filter((p) => {
    const id = String((p as any).id);
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalizeProfile(p: AnyObject): {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  model: string | null;
  secretId?: string | null;
  apiKeyInline?: string | null;
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

  const apiKeyInline: string | null =
    (typeof (p as any).apiKey === "string" && (p as any).apiKey) ||
    (typeof (p as any).api_key === "string" && (p as any).api_key) ||
    null;

  const secretId: string | null =
    (typeof (p as any)["secret-id"] === "string" && (p as any)["secret-id"]) ||
    (typeof (p as any).secretId === "string" && (p as any).secretId) ||
    (typeof (p as any).secret_id === "string" && (p as any).secret_id) ||
    null;

  return { id, name, provider, baseUrl, model, secretId, apiKeyInline };
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
    const s = readJsonIfExists(path.join(dir, "secrets.json"));
    if (s) return s;
  }
  return null;
}

function _extractApiKeyValue(entry: any, wantedId?: string | null): string | null {
  if (!entry) return null;
  if (typeof entry === 'string' && entry.trim()) return entry.trim();

  // Newer ST secrets.json format: api_key_<provider> is an array of {id,value,label,active}
  if (Array.isArray(entry)) {
    const arr = entry as any[];
    if (wantedId) {
      const hit = arr.find((x) => x && typeof x === 'object' && String(x.id) === String(wantedId) && typeof x.value === 'string');
      if (hit && typeof hit.value === 'string' && hit.value.trim()) return hit.value.trim();
    }
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

function _extractApiKeyValueById(entry: any, wantedId?: string | null): string | null {
  if (!wantedId) return null;
  if (!entry) return null;

  if (Array.isArray(entry)) {
    const arr = entry as any[];
    const hit = arr.find((x) => x && typeof x === 'object' && String(x.id) === String(wantedId) && typeof x.value === 'string');
    if (hit && typeof hit.value === 'string' && hit.value.trim()) return hit.value.trim();
    return null;
  }

  if (typeof entry === 'object') {
    const id = (entry as any).id;
    const value = (entry as any).value;
    if (id !== undefined && String(id) === String(wantedId) && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function pickApiKeyForProvider(provider: string, secrets: AnyObject | null, secretId?: string | null): string | null {
  if (!secrets || typeof secrets !== "object") return null;

  // If a specific secret-id was chosen in the Connection Profile, honor it regardless of provider bucket.
  if (secretId) {
    for (const k of Object.keys(secrets)) {
      const v = _extractApiKeyValueById((secrets as any)[k], secretId);
      if (v) return v;
    }
  }

  // Direct mapping for common providers (best-effort; ST key names can vary by version).
  const mapping: Record<string, string[]> = {
    openai: ["api_key_openai", "openaiApiKey", "apiKeyOpenAI"],
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
    const v = _extractApiKeyValue((secrets as any)[k], secretId);
    if (v) return v;
  }

  // Fallback: try to locate a secrets key that contains the provider name.
  const providerKey = provider.replace(/[^a-z0-9]/g, "");
  if (providerKey) {
    for (const k of Object.keys(secrets)) {
      if (!/^api_key_/i.test(k)) continue;
      if (!k.toLowerCase().includes(providerKey)) continue;
      const v = _extractApiKeyValue((secrets as any)[k], secretId);
      if (v) return v;
    }
  }

  // Last resort: if there is exactly one api_key_* entry, use it.
  const apiKeys = Object.keys(secrets).filter((k) => /^api_key_/i.test(k));
  if (apiKeys.length === 1) {
    const v = _extractApiKeyValue((secrets as any)[apiKeys[0]], secretId);
    if (v) return v;
  }

  return null;
}



// Exported for meta endpoints (/profiles, /models)
export function getConnectionProfilesSummary(): { ok: boolean; profiles: Array<{ id: string; name: string }>; message?: string } {
  const profiles = loadAllProfilesFromSettings();
  const merged: Array<{ id: string; name: string }> = [];

  for (const p of profiles) {
    try {
      const n = normalizeProfile(p);
      const secrets = loadSecrets((p as any).__st_user_dir);
      const apiKey = n.apiKeyInline || (secrets ? pickApiKeyForProvider(n.provider, secrets, n.secretId) : null);
      const hasSignal = Boolean((n.baseUrl && n.baseUrl.trim()) || (n.model && n.model.trim()) || (apiKey && String(apiKey).trim()));
      if (!hasSignal) continue;

      const id = String((p as any).id || '').trim();
      const name = String((p as any).name || '').trim();
      if (!id || !name) continue;
      if (!merged.some((x) => x.id === id)) merged.push({ id, name });
    } catch {
      // ignore bad entries
    }
  }

  const withAliases = [{ id: 'default', name: 'default' }, ...merged].filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);
  if (merged.length) return { ok: true, profiles: withAliases };
  return { ok: false, profiles: withAliases, message: 'No usable connection profiles found (need base_url/model/key in any data/*/settings.json).' };
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
      Authorization: `Bearer ${cred.apiKey}`,
      'x-api-key': cred.apiKey,
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
  apiKey: string;
} | null {
  const profiles = loadAllProfilesFromSettings();
  if (!profiles.length) return null;

  let chosen: AnyObject | null = null;
  if (profileId === "default") {
    chosen = profiles[0];
  } else {
    chosen = findProfileById(profiles, profileId) || null;
  }
  if (!chosen) return null;

  const p = normalizeProfile(chosen);
  const userDir = (chosen as any).__st_user_dir as string | undefined;
  const secrets = loadSecrets(userDir);

  const apiKey = p.apiKeyInline || pickApiKeyForProvider(p.provider, secrets, p.secretId);
  if (!p.baseUrl || !p.model || !apiKey) {
    const missing = [
      !p.baseUrl ? "base_url" : null,
      !p.model ? "model" : null,
      !apiKey ? "api_key" : null,
    ].filter(Boolean);
    return {
      ok: false,
      message: `Missing ${missing.join(", ")} for profile '${p.name}' (${p.id}).`,
      provider: p.provider,
      baseUrl: p.baseUrl || "",
      model: p.model || "",
      apiKey: apiKey || "",
    };
  }

  return {
    ok: true,
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: apiKey,
  };
}

function safeFsName(v: string): string {
  const cleaned = v.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return cleaned || "default";
}

function getLocalBaseDir(): string {
  return path.join(process.cwd(), "data", "memu-local");
}

function buildLocalPaths(userId: string, agentId: string): { baseDir: string; dbPath: string; resourcesDir: string } {
  const baseDir = path.join(getLocalBaseDir(), safeFsName(userId), safeFsName(agentId));
  const dbPath = path.join(baseDir, "memu.sqlite");
  const resourcesDir = path.join(baseDir, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  return { baseDir, dbPath, resourcesDir };
}

function buildMemuPayloadForLocal(
  cfg: MemuPluginConfig,
  userId: string,
  agentId: string,
  conversation?: any
): any {
  const { dbPath, resourcesDir } = buildLocalPaths(userId, agentId);

  const step = (s: MemuStep): string => cfg.stepProfileId?.[s] || cfg.defaultProfileId || "default";

  // Build unique set of needed profile ids (default + step overrides)
  const needIds = new Set<string>();
  needIds.add(step("preprocess"));
  needIds.add(step("memory_extract"));
  needIds.add(step("category_update"));
  needIds.add(step("reflection"));
  needIds.add(step("ranking"));
  needIds.add(step("embeddings"));

  const idToName = (id: string) => (id === "default" ? "default" : `st_${safeFsName(id)}`);

  const llm_profiles: Record<string, any> = {};

  // Always provide "default"
  const defCred = resolveProfileCredentials(cfg.defaultProfileId || "default");
  if (defCred && defCred.ok) {
    llm_profiles["default"] = {
      provider: "openai",
      base_url: defCred.baseUrl,
      api_key: defCred.apiKey,
      chat_model: defCred.model,
      client_backend: "sdk",
      // embed_model left as memU default unless embeddings profile overrides it
    };
  }

  // Populate step-specific profiles
  for (const id of needIds) {
    const name = idToName(id);
    if (llm_profiles[name]) continue;

    const cred = resolveProfileCredentials(id);
    if (cred && cred.ok) {
      llm_profiles[name] = {
        provider: "openai",
        base_url: cred.baseUrl,
        api_key: cred.apiKey,
        chat_model: cred.model,
        client_backend: "sdk",
      };
    }
  }

  // Embeddings: memU pipelines default to embed_llm_profile="embedding" in many steps.
  const embedId = step("embeddings");
  const embedCred = resolveProfileCredentials(embedId) || defCred;
  if (embedCred && embedCred.ok) {
    llm_profiles["embedding"] = {
      provider: "openai",
      base_url: embedCred.baseUrl,
      api_key: embedCred.apiKey,
      chat_model: embedCred.model,
      client_backend: "sdk",
      embed_model: (cfg as any).embeddingModel || "text-embedding-3-small",
    };
  } else if (llm_profiles["default"]) {
    llm_profiles["embedding"] = { ...llm_profiles["default"], embed_model: (cfg as any).embeddingModel || (llm_profiles["default"] as any).embed_model || "text-embedding-3-small" };
  }

  // Minimal per-step routing
  const memorize_config: any = {
    preprocess_llm_profile: idToName(step("preprocess")),
    memory_extract_llm_profile: idToName(step("memory_extract")),
    category_update_llm_profile: idToName(step("category_update")),
  };

  const retrieve_config: any = {
    method: "rag",
    sufficiency_check_llm_profile: idToName(step("reflection")),
    llm_ranking_llm_profile: idToName(step("ranking")),
  };

  const dbProvider = ((cfg as any).dbProvider || (cfg as any).metadataStoreProvider || "inmemory").toString().toLowerCase();
  const dbDsn = (cfg as any).dbDsn || (cfg as any).metadataStoreDsn;
  const ddlMode = ((cfg as any).ddlMode || "create").toString().toLowerCase();

  // NOTE: To keep the architecture simple (and easy to update with upstream memU),
  // local mode defaults to an in-memory store. Persistence can be enabled later by switching to Postgres.
  const metadata_store: any = { provider: dbProvider, ddl_mode: ddlMode };

  if (dbProvider === "postgres") {
    if (typeof dbDsn !== "string" || !dbDsn.trim()) {
      throw new Error("dbProvider=postgres requires dbDsn (postgres connection string).");
    }
    metadata_store.dsn = dbDsn.trim();
  } else if (dbProvider !== "inmemory") {
    // If the installed memU doesn't support a provider, fall back to inmemory.
    metadata_store.provider = "inmemory";
  }

  const database_config: any = { metadata_store };

  const blob_config: any = {
    provider: "local",
    resources_dir: resourcesDir,
  };

  const payload: any = {
    service_key: `${safeFsName(userId)}__${safeFsName(agentId)}`,
    llm_profiles,
    database_config,
    blob_config,
    memorize_config,
    retrieve_config,
    resources_dir: resourcesDir,
  };

  if (conversation) payload.conversation = conversation;

  return payload;
}

type BridgeOp = "health" | "memorize" | "list_categories";

type BridgeRequest = { id: string; op: BridgeOp; payload?: any };
type BridgeResponse = { id: string; ok: boolean; op?: string; error?: string; [k: string]: any };

let _localBridge:
  | {
      pythonCmd: string;
      child: ReturnType<typeof spawn>;
      buf: string;
      pending: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; t: any }>;
    }
  | null = null;

function ensureLocalBridge(pythonCmd: string, scriptPath: string) {
  if (_localBridge && _localBridge.pythonCmd === pythonCmd && _localBridge.child.exitCode === null) return;

  // Tear down old bridge if any
  try {
    if (_localBridge && _localBridge.child.exitCode === null) _localBridge.child.kill();
  } catch {
    // ignore
  }

  const child = spawn(pythonCmd, ["-u", scriptPath, "--daemon"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const bridge = {
    pythonCmd,
    child,
    buf: "",
    pending: new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; t: any }>(),
  };

  child.stdout.on("data", (d) => {
    bridge.buf += d.toString("utf8");
    let idx: number;
    while ((idx = bridge.buf.indexOf("\n")) >= 0) {
      const line = bridge.buf.slice(0, idx).trim();
      bridge.buf = bridge.buf.slice(idx + 1);
      if (!line) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = parsed as BridgeResponse;
      if (!msg || typeof (msg as any).id !== 'string') continue;
      const p = bridge.pending.get(msg.id) || null;
      if (!p) continue;
      clearTimeout(p.t);
      bridge.pending.delete(msg.id);
      if (!msg.ok) p.reject(new Error(msg.error || "Local memU bridge error"));
      else p.resolve(msg);
    }
  });

  const flushAll = (err: any) => {
    for (const [id, p] of bridge.pending.entries()) {
      clearTimeout(p.t);
      p.reject(err);
      bridge.pending.delete(id);
    }
  };

  child.on("error", (err) => flushAll(err));
  child.on("close", (code) => flushAll(new Error(`Local memU bridge exited (code=${code})`)));

  // Helpful stderr logging (doesn't affect protocol)
  child.stderr.on("data", (d) => {
    const s = d.toString("utf8").trim();
    if (s) console.warn("[memu-local-bridge]", s);
  });

  _localBridge = bridge;
}

async function runLocalPythonOp(op: BridgeOp, payload?: any): Promise<any> {
  const cfg = readPluginConfig();
  const pythonCmd = getPythonCmd(cfg);

  const pluginRoot = path.resolve(__dirname, ".."); // dist -> plugin root
  const scriptPath = path.join(pluginRoot, "py", "memu_st_bridge.py");

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Local memU bridge script not found: ${scriptPath}`);
  }

  ensureLocalBridge(pythonCmd, scriptPath);
  if (!_localBridge || !_localBridge.child.stdin) throw new Error("Local memU bridge not ready");

  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const req: BridgeRequest = { id, op, payload };

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      _localBridge?.pending.delete(id);
      reject(new Error("Local memU bridge timeout"));
    }, 120000); // 2 minutes (LLM calls can be slow)

    _localBridge!.pending.set(id, { resolve, reject, t });

    try {
      _localBridge!.child.stdin!.write(JSON.stringify(req) + "\n");
    } catch (e) {
      clearTimeout(t);
      _localBridge!.pending.delete(id);
      reject(e);
    }
  });
}

// ---------------------------------
// Cloud + Local task status emulation
// ---------------------------------

type LocalTaskStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILURE";

const localTasks = new Map<
  string,
  { status: LocalTaskStatus; createdAt: number; updatedAt: number; error?: string }
>();

function makeTaskId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function setTask(taskId: string, patch: Partial<{ status: LocalTaskStatus; updatedAt: number; error?: string }>) {
  const prev = localTasks.get(taskId);
  if (!prev) return;
  localTasks.set(taskId, { ...prev, ...patch, updatedAt: Date.now() });
}

// -------------
// Cloud helpers
// -------------

function newClient(apiKey: string, timeout?: number, maxRetries?: number, baseUrl?: string): MemuClient {
  const t = timeout || MEMU_DEFAULT_TIMEOUT;
  const r = maxRetries || MEMU_DEFAULT_MAX_RETRIES;
  const b = baseUrl || MEMU_BASE_URL;
  return new MemuClient({ apiKey, timeout: t, maxRetries: r, baseUrl: b });
}

export async function proxyMemorizeConversation(req: Request, res: Response): Promise<void> {
  if (!isLocalMode()) {
    const apiKey = req.body?.apiKey;
    if (!apiKey) {
      res.status(400).json({ error: "Missing apiKey" });
      return;
    }
    const client = newClient(apiKey, req.body?.timeout, req.body?.maxRetries);
    try {
      const response = await client.memorizeConversation(
        req.body?.conversation,
        req.body?.userId,
        req.body?.userName,
        req.body?.agentId,
        req.body?.agentName,
        req.body?.sessionDate
      );
      res.json(response);
    } catch (error: any) {
      console.error(chalk.red(MODULE_NAME), "Error in memorizeConversation:", error);
      res.status(500).json({ error: error?.message || String(error) });
    }
    return;
  }

  // Local mode (apiKey ignored)
  const userId = String(req.body?.userId || "");
  const agentId = String(req.body?.agentId || "");
  const conversation = req.body?.conversation;

  if (!userId || !agentId || !Array.isArray(conversation)) {
    res.status(400).json({ error: "Missing userId/agentId/conversation" });
    return;
  }

  const taskId = makeTaskId();
  localTasks.set(taskId, { status: "PENDING", createdAt: Date.now(), updatedAt: Date.now() });

  // Fire and forget
  void (async () => {
    try {
      setTask(taskId, { status: "PROCESSING" });
      const cfg = readPluginConfig();
      const payload = buildMemuPayloadForLocal(cfg, userId, agentId, conversation);
      const resp = await runLocalPythonOp("memorize", payload);
      if (resp?.ok) {
        setTask(taskId, { status: "SUCCESS" });
      } else {
        setTask(taskId, { status: "FAILURE", error: resp?.error || "unknown error" });
      }
    } catch (e: any) {
      setTask(taskId, { status: "FAILURE", error: e?.message || String(e) });
    }
  })();

  res.json({ taskId });
}

export async function proxyGetTaskStatus(req: Request, res: Response): Promise<void> {
  if (!isLocalMode()) {
    const apiKey = req.body?.apiKey;
    const taskId = req.body?.taskId;
    if (!apiKey || !taskId) {
      res.status(400).json({ error: "Missing apiKey or taskId" });
      return;
    }
    const client = newClient(apiKey, req.body?.timeout, req.body?.maxRetries);
    try {
      const response = await client.getTaskStatus(taskId);
      res.json(response);
    } catch (error: any) {
      console.error(chalk.red(MODULE_NAME), "Error in getTaskStatus:", error);
      res.status(500).json({ error: error?.message || String(error) });
    }
    return;
  }

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
  if (!isLocalMode()) {
    const apiKey = req.body?.apiKey;
    const taskId = req.body?.taskId;
    if (!apiKey || !taskId) {
      res.status(400).json({ error: "Missing apiKey or taskId" });
      return;
    }
    const client = newClient(apiKey, req.body?.timeout, req.body?.maxRetries);
    try {
      const response = await client.getTaskSummaryReady(taskId);
      res.json(response);
    } catch (error: any) {
      console.error(chalk.red(MODULE_NAME), "Error in getTaskSummaryReady:", error);
      res.status(500).json({ error: error?.message || String(error) });
    }
    return;
  }

  const taskId = String(req.body?.taskId || "");
  const task = localTasks.get(taskId);
  res.json({ allReady: task?.status === "SUCCESS" });
}

export async function proxyRetrieveDefaultCategories(req: Request, res: Response): Promise<void> {
  if (!isLocalMode()) {
    const apiKey = req.body?.apiKey;
    const userId = req.body?.userId;
    const agentId = req.body?.agentId;
    if (!apiKey || !userId || !agentId) {
      res.status(400).json({ error: "Missing apiKey or userId/agentId" });
      return;
    }
    const client = newClient(apiKey, req.body?.timeout, req.body?.maxRetries);
    try {
      const response = await client.retrieveDefaultCategories({ userId, agentId });
      res.json(response);
    } catch (error: any) {
      console.error(chalk.red(MODULE_NAME), "Error in retrieveDefaultCategories:", error);
      res.status(500).json({ error: error?.message || String(error) });
    }
    return;
  }

  const userId = String(req.body?.userId || "");
  const agentId = String(req.body?.agentId || "");
  if (!userId || !agentId) {
    res.status(400).json({ error: "Missing userId/agentId" });
    return;
  }

  try {
    const cfg = readPluginConfig();
    const payload = buildMemuPayloadForLocal(cfg, userId, agentId);
    const resp = await runLocalPythonOp("list_categories", payload);

    const categories = resp?.result?.categories || resp?.result?.response?.categories || [];
    // Ensure response shape matches memu-js: { categories: [...] }
    res.json({ categories });
  } catch (error: any) {
    console.error(chalk.red(MODULE_NAME), "Local retrieveDefaultCategories failed:", error);
    res.status(500).json({ error: error?.message || String(error) });
  }
}

export async function proxyLocalHealth(req: Request, res: Response): Promise<void> {
  if (!isLocalMode()) {
    res.json({ ok: true, mode: "cloud" });
    return;
  }
  try {
    const resp = await runLocalPythonOp("health");
    res.json({ ok: true, mode: "local", python: getPythonCmd(readPluginConfig()), bridge: resp });
  } catch (e: any) {
    res.status(500).json({ ok: false, mode: "local", error: e?.message || String(e) });
  }
}


// ---------------------
// Route registrations
// ---------------------

export function registerMemorizeConversation(router: Router): void {
  router.post("/memorizeConversation", bodyParser.json({ limit: "10mb" }), proxyMemorizeConversation);
}

export function registerGetTaskStatus(router: Router): void {
  router.post("/getTaskStatus", bodyParser.json({ limit: "1mb" }), proxyGetTaskStatus);
}

export function registerGetTaskSummaryReady(router: Router): void {
  router.post("/getTaskSummaryReady", bodyParser.json({ limit: "1mb" }), proxyGetTaskSummaryReady);
}

export function registerRetrieveDefaultCategories(router: Router): void {
  router.post("/retrieveDefaultCategories", bodyParser.json({ limit: "1mb" }), proxyRetrieveDefaultCategories);
}

export function registerLocalHealth(router: Router): void {
  router.get("/health", proxyLocalHealth);
}
