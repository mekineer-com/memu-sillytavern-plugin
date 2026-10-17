const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the existing config and builder, with no ST files, credentials or network.
const source = fs.readFileSync(`${__dirname}/../src/memu-endpoint.ts`, 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const code = slice('const DEFAULT_CONFIG', '// -----------------------------')
  + slice('function sanitizeIncomingConfig(', 'let _cachedPluginConfig')
  + slice('export function setPluginConfig(', '// -----------------------------')
  + slice('function buildMemuPayloadForLocal(', '// ---------------------------------')
  + slice('export async function proxyNarrativeSuggestion(', 'export function registerNarrativeSuggestion(');
let resolved = [];
let persisted;
const context = {
  _cachedPluginConfig: null,
  exports: {}, getConfigPath: () => 'test-config.json',
  fs: { writeFileSync: (_path, json) => { persisted = JSON.parse(json); } },
  process: { env: { HOME: '/fictional/home', USERPROFILE: '/fictional/profile' } }, path: require('node:path'),
  resolveProfileCredentials(id) {
    resolved.push(id);
    return { ok: true, provider: 'openai', baseUrl: 'https://test.invalid/v1', key: 'fictional-key', model: id };
  },
  mapSTProviderToMemU: () => ({ provider: 'openai' }),
};
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
assert.equal(context.sanitizeIncomingConfig({}).serverPath, undefined);
assert.equal(context.sanitizeIncomingConfig({ autoStartServer: true }).autoStartWithSillyTavern, false,
  'The retired request-triggered default must not enable the new lifecycle option');
assert.equal(context.sanitizeIncomingConfig({ serverPath: '  ' }).serverPath, undefined);
const managed = { ...context, exports: {}, process: { env: { MEMU_SERVER_PATH: ' /fictional/managed/server ' } } };
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, managed);
assert.equal(managed.sanitizeIncomingConfig({}).serverPath, '/fictional/managed/server');
assert.equal(managed.sanitizeIncomingConfig({ serverPath: '  ' }).serverPath, '/fictional/managed/server');
assert.equal(managed.sanitizeIncomingConfig({ serverPath: '/fictional/manual/server' }).serverPath, '/fictional/manual/server');
const normalize = value => JSON.parse(JSON.stringify(value));
// Transition cleanup expires 2027-01-17: remove this old-mapping upgrade handling.
const saved = { serverPath: '/fictional/server', autoStartWithSillyTavern: false, embeddingBatchSize: 9,
  useServerSettings: false, useClaudeCode: true, defaultProfileId: 'obsolete', stepProfileId: { reflection: 'obsolete' } };
const cfg = context.sanitizeIncomingConfig(saved);
context.exports.setPluginConfig(cfg);
for (const key of ['useServerSettings', 'useClaudeCode', 'defaultProfileId', 'stepProfileId']) assert.equal(Object.hasOwn(persisted, key), false);
assert.equal(persisted.serverPath, saved.serverPath); assert.equal(persisted.autoStartWithSillyTavern, false); assert.equal(persisted.embeddingBatchSize, 9);
context.resolveProfileCredentials = () => assert.fail('Metadata must not resolve obsolete profiles');
const payload = normalize(context.buildMemuPayloadForLocal(cfg, 'TestOwner', 'TestSoul', [{ role: 'user', content: 'Fictional message' }], { conversationId: ' test-chat ' }));
assert.deepEqual(payload.user, { user_id: 'TestOwner', soul_id: 'TestSoul' }); assert.equal(payload.conversation_id, 'test-chat');
for (const key of ['claude_code', 'llm_profiles', 'srmm', 'memorize_config', 'retrieve_config']) assert.equal(Object.hasOwn(payload, key), false);
console.log('Operational config retained; obsolete model persistence and request overrides removed.');

const soulContext = {
  exports: {}, readPluginConfig: () => ({}), ensureLocalServer: async () => ({ baseUrl: 'http://test.invalid' }),
  httpJson: async (_url, route, method, body) => ({ route, method, body }),
};
vm.runInNewContext(ts.transpileModule(slice('export async function proxySouls(', '// ---------------------')
  + slice('export function registerSouls(', 'export async function proxyNarrativeSuggestion('), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, soulContext);
(async () => {
  for (const managed of [false, true]) {
    for (const autoStartWithSillyTavern of [false, true]) {
      for (const forceStart of [false, true]) {
        let healthy = false, spawns = 0;
        const lifecycle = {
          process: { env: managed ? { MEMU_SERVER_MANAGED: 'launcher' } : {} }, URL,
          getExternalServerBaseUrl: () => 'http://fictional.invalid:8099',
          getExternalServerRunPy: () => '/fictional/server/run.py',
          fs: { existsSync: () => true }, getExternalServerPython: () => '/fictional/python',
          _externalSpawnCooldownUntilUnixMs: 0,
          spawnExternalServer: () => { spawns++; healthy = true; }, waitForServerHealthy: async () => {},
          _externalServerHealthInfo: async () => ({ healthy }),
          _getExternalLogFile: () => null, _readLogTail: () => [],
          _externalServerInstanceId: null, _externalServerEphemeralDb: null,
          exports: {},
        };
        vm.runInNewContext(ts.transpileModule(slice('async function ensureLocalServer(', 'type ExternalServerShutdownInfo')
          + slice('export async function externalServerStatus(', 'export async function externalServerPingInfo('), {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText, lifecycle);
        const cfg = { autoStartWithSillyTavern, serverPath: '/fictional/saved/server' };
        lifecycle.readPluginConfig = () => cfg;
        assert.equal((await lifecycle.exports.externalServerStatus()).ok, true);
        lifecycle.readPluginConfig = () => { throw new Error('Fictional config failure'); };
        assert.equal((await lifecycle.exports.externalServerStatus()).ok, false);
        lifecycle.readPluginConfig = () => cfg;
        const shouldStart = forceStart;
        if (shouldStart) await lifecycle.ensureLocalServer(cfg, { forceStart });
        else await assert.rejects(lifecycle.ensureLocalServer(cfg, { forceStart }), /Click Start/);
        assert.equal(spawns, shouldStart ? 1 : 0);
        assert.equal(cfg.autoStartWithSillyTavern, autoStartWithSillyTavern);
        healthy = true;
        await lifecycle.ensureLocalServer(cfg, { forceStart });
        assert.equal(spawns, shouldStart ? 1 : 0);
        lifecycle._externalServerHealthInfo = async () => ({ healthy: false, unavailable: true });
        await assert.rejects(lifecycle.ensureLocalServer(cfg, { forceStart }), /status is unavailable/);
        assert.equal(spawns, shouldStart ? 1 : 0, 'Unknown health must not spawn or claim a server');
      }
    }
  }
  console.log('Ordinary requests never spawn; explicit Start remains available in both launch modes.');
  const hookCode = slice('export async function externalServerStop(', 'export function registerServerControl(');
  function hooks({ managed = false, enabled = true, startedPid = 42, busy = false } = {}) {
    const cfg = { serverPath: '/fictional/server', autoStartWithSillyTavern: enabled };
    const calls = { starts: 0, stops: 0, warnings: [], cfg, instance: 'fictional-instance', busy, alive: true };
    const env = { exports: {}, process: { env: managed ? { MEMU_SERVER_MANAGED: 'launcher' } : {} },
      readPluginConfig: () => cfg,
      ensureLocalServer: async () => { calls.starts++; return { baseUrl: 'http://fictional.invalid', startedPid }; },
      getExternalServerBaseUrl: actual => { assert.equal(actual, cfg); return 'http://fictional.invalid'; },
      _externalServerHealthInfo: async () => ({ healthy: calls.alive, serverInstanceId: calls.instance }),
      externalServerStatus: async () => ({ ok: true, healthy: calls.alive }),
      httpJson: async (_base, route, _method, body) => {
        if (route === '/integration/mentra/status') return { busy: calls.busy };
        assert.equal(route, '/admin/shutdown'); assert.equal(body.max_wait_sec, 0);
        calls.stops++; calls.alive = false; return { ok: true };
      },
      console: { warn: (...args) => calls.warnings.push(args) },
    };
    vm.runInNewContext(ts.transpileModule(hookCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, env);
    return { calls, env, start: env.exports.startServerWithSillyTavern, stop: env.exports.stopServerWithSillyTavern };
  }
  for (const managed of [false, true]) {
    const disabled = hooks({ managed, enabled: false }); await disabled.start(); await disabled.stop();
    assert.equal(disabled.calls.starts, 0); assert.equal(disabled.calls.stops, 0);
    const running = hooks({ managed, startedPid: null }); await running.start(); await running.stop();
    assert.equal(running.calls.starts, 1); assert.equal(running.calls.stops, 0);
    const launched = hooks({ managed }); await launched.start(); await launched.stop();
    assert.equal(launched.calls.starts, 1); assert.equal(launched.calls.stops, 1);
  }
  const replacement = hooks(); await replacement.start(); replacement.calls.instance = 'replacement';
  await replacement.stop(); assert.equal(replacement.calls.stops, 0);
  for (const busy of [true, undefined]) {
    const hook = hooks(); await hook.start(); hook.calls.busy = busy;
    await hook.stop(); assert.equal(hook.calls.stops, 0); assert.equal(hook.calls.warnings.length, 1);
  }
  const unknown = hooks(); await unknown.start();
  unknown.env.httpJson = async () => { throw new Error('Fictional Iris status failure'); };
  await unknown.stop(); assert.equal(unknown.calls.stops, 0); assert.equal(unknown.calls.warnings.length, 1);
  const failed = hooks(); failed.env.ensureLocalServer = async () => { throw new Error('Fictional startup failure'); };
  await failed.start(); await failed.stop(); assert.equal(failed.calls.stops, 0); assert.equal(failed.calls.warnings.length, 1);
  const owned = hooks(); await owned.start();
  owned.env.readPluginConfig = () => { throw new Error('Shutdown must use the captured server configuration'); };
  await owned.stop(); await owned.stop(); assert.equal(owned.calls.stops, 1);
  const active = hooks({ busy: true });
  assert.equal((await active.env.exports.externalServerStop()).ok, false);
  assert.equal((await active.env.exports.externalServerStop(undefined, true)).ok, false);
  assert.equal(active.calls.stops, 0);
  const unchecked = hooks(); unchecked.calls.busy = undefined;
  assert.equal((await unchecked.env.exports.externalServerStop()).confirmationRequired, true);
  assert.equal(unchecked.calls.stops, 0);
  assert.equal((await unchecked.env.exports.externalServerStop(undefined, true)).ok, true);
  assert.equal(unchecked.calls.stops, 1);
  const healthEnv = { exports: {}, process: { env: {} }, AbortSignal, _externalServerInstanceId: null, _externalServerEphemeralDb: null,
    readPluginConfig: () => ({}), getExternalServerBaseUrl: () => 'http://fictional.invalid',
    _getExternalLogFile: () => null, _readLogTail: () => [],
    fetch: async () => { throw new Error('Fictional health timeout'); },
  };
  vm.runInNewContext(ts.transpileModule(slice('async function ensureLocalServer(', 'type ExternalServerShutdownInfo')
    + slice('async function _externalServerHealthInfo(', 'export async function externalServerPingInfo('),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, healthEnv);
  assert.equal((await healthEnv.exports.externalServerStatus()).ok, false, 'A timeout is unknown, not stopped');
  await assert.rejects(healthEnv.ensureLocalServer({}, { forceStart: true }), /status is unavailable/,
    'A real health-probe failure must refuse Start before attempting to spawn');
  healthEnv.fetch = async () => { throw Object.assign(new Error('Refused'), { cause: { code: 'ECONNREFUSED' } }); };
  const offline = await healthEnv.exports.externalServerStatus();
  assert.equal(offline.ok, true); assert.equal(offline.running, false);
  const entrySource = fs.readFileSync(`${__dirname}/../src/index.ts`, 'utf8');
  assert(entrySource.includes('await startServerWithSillyTavern();'));
  assert(entrySource.includes('await stopServerWithSillyTavern();'));
  console.log('ST hooks: both launch modes respect Auto Start, disabled/existing/replaced cases retained, spawned instance stopped once without PID inspection, busy/unknown Iris retained.');
  const routes = [];
  soulContext.exports.registerSouls({ get: route => routes.push(route), post: route => routes.push(route) });
  assert(routes.includes('/souls/:soulId'));
  let result;
  const res = { json: value => { result = value; }, status() { assert.fail('Unexpected proxy failure'); } };
  for (const user_name of [undefined, 'TestOwner']) {
    await soulContext.exports.proxySouls({ method: 'POST', params: {}, body: { soul_id: 'TestSoul', ...(user_name !== undefined ? { user_name } : {}) } }, res);
    assert.equal(result.body.soul_id, 'TestSoul'); assert.equal(result.body.user_name, user_name);
    assert.equal(Object.hasOwn(result.body, 'user_name'), user_name !== undefined);
  }
  await soulContext.exports.proxySouls({ method: 'GET', params: { soulId: 'Test Soul' } }, res);
  assert.equal(result.route, '/souls/Test%20Soul'); assert.equal(result.method, 'GET'); assert.equal(result.body, undefined);
  await soulContext.exports.proxySouls({ method: 'GET', params: { soulId: 'Test Soul' }, query: { include_narrative: 'true' } }, res);
  assert.equal(result.route, '/souls/Test%20Soul?include_narrative=true');
  await soulContext.exports.proxySouls({ method: 'GET', params: { soulId: 'Test Soul' }, query: { include_narrative: 'false' } }, res);
  assert.equal(result.route, '/souls/Test%20Soul');
  console.log('Soul creation forwards optional binding; live narrative GET is explicitly opt-in.');

  context.readPluginConfig = () => cfg;
  context.ensureLocalServer = async () => ({ baseUrl: 'http://test.invalid' });
  context.resolveSrmm = async () => 'config';
  let suggestionWire;
  context.httpJson = async (_url, route, method, body) => { suggestionWire = normalize(body); return { narrative_self: 'Considered' }; };
  await context.exports.proxyNarrativeSuggestion({ body: { userId: 'TestOwner', soulId: 'TestSoul', suggestion: 'Fictional request' } }, { json() {}, status() { assert.fail('Unexpected suggestion error'); } });
  assert.deepEqual(suggestionWire, { user: { user_id: 'TestOwner', soul_id: 'TestSoul' }, user_id: 'TestOwner', suggestion: 'Fictional request', srmm: 'config' });
  console.log('Suggestions carry a reply-only SRMM field.');

  const ownDir = '/fake/user-A';
  const profiles = [
    { id: 'a', name: 'A', mode: 'cc', api: 'openai', model: 'same-name', 'api-url': 'https://a.invalid/v1', 'secret-id': 'a-key', context_window_tokens: 8000 },
    { id: 'a-twin', name: 'Same endpoint, different credential', mode: 'cc', api: 'openai', model: 'same-name', 'api-url': 'https://a.invalid/v1', 'secret-id': 'twin-key', context_window_tokens: 8000 },
    { id: 'b', name: 'B', mode: 'cc', api: 'openrouter', model: 'same-name', 'api-url': 'https://b.invalid/v1', 'secret-id': 'b-key', context_window_tokens: 7000 },
    { id: 'unsupported', name: 'Native Claude', mode: 'cc', api: 'claude', model: 'native-model', 'api-url': 'https://claude.invalid' },
    { id: 'local', name: 'Local Ollama compatible endpoint', mode: 'tc', api: 'ollama', model: 'local-model', 'api-url': 'http://localhost:11434' },
    { id: 'missing-key', name: 'Cloud without credentials', mode: 'cc', api: 'groq', model: 'cloud-model', 'api-url': 'https://cloud.invalid/v1' },
    { id: 'metadata', name: 'Chosen metadata connection', mode: 'cc', api: 'custom', model: 'chosen-model', 'api-url': 'https://metadata.invalid/v1', api_key: 'scoped-metadata-key' },
  ];
  const settings = { extension_settings: { connectionManager: { profiles } }, oai_settings: { openai_model: 'same-name', mistralai_model: 'mistral-native', custom_model: 'custom-local', custom_url: 'http://localhost:1234/v1' } };
  const secrets = { api_key_openai: [{ id: 'a-key', value: 'own-a-key', active: true }, { id: 'twin-key', value: 'own-twin-key' }], api_key_openrouter: [{ id: 'b-key', value: 'own-b-key', active: true }], api_key_mistralai: 'native-mistral-key' };
  let canonical = { claude_code: false, retrieve: { mental_health_query: true, top_k: 7 }, llm: { provider: 'openai', chat_model: 'custom-base', api_key: 'base-key', embedding: { api_key: 'embedding-key' }, step_models: { reflection: 'hand-model' }, step_context_window_tokens: { reflection: 6000, unrelated: 3000 } } };
  let coreWrites = 0, reloads = 0, discoveries = 0, lastPatch, replyWire;
  let metadataResponse = { data: [{ id: 'local-model' }] }, metadataError = false;
  const metadataCalls = [];
  const mapping = { exports: {}, URL, path: require('node:path'), fs: { readFileSync: fs.readFileSync },
    getStRoot: () => require('node:path').resolve(__dirname, '../../..'),
    readJsonIfExists: file => { assert(file.startsWith(ownDir + '/')); return file.endsWith('settings.json') ? settings : secrets; },
    sanitizeIncomingConfig: cfg => ({ ...cfg, serverPath: cfg.serverPath || '/fake/managed-server' }), readPluginConfig: () => ({ serverPath: '' }), _readExternalServerConfig: root => { assert.equal(root, '/fake/managed-server'); return canonical; }, ensureLocalServer: async () => ({ baseUrl: 'http://core.invalid' }),
    _stProviderUrls: { openai: 'https://openai.invalid/v1', mistralai: 'https://mistral.invalid/v1', groq: 'https://cloud.invalid/v1' },
    resolveProfileBaseUrl: (_profile, normalized) => normalized.baseUrl,
    sorted_unique: values => [...new Set(values)].sort(), MODEL_CACHE: new Map(), MODEL_CACHE_TTL_MS: 60000,
    resolveProfileCredentials: () => assert.fail('Mapping metadata must never scan all users'),
    httpGetJson: async (url, headers) => {
      discoveries++;
      metadataCalls.push({ url, headers: normalize(headers) });
      if (metadataError) throw new Error('Fictional metadata unavailable');
      return metadataResponse;
    },
    httpJson: async (_base, route, method, body) => {
      if (route === '/reload') { reloads++; return { ok: true }; }
      if (route !== '/config') { replyWire = normalize(body); return {}; }
      if (method === 'POST') { lastPatch = normalize(body); coreWrites++; if (body.claude_code !== undefined) canonical.claude_code = body.claude_code;
        if (body.retrieve !== undefined) canonical.retrieve = { ...canonical.retrieve, ...body.retrieve };
        for (const [key, value] of Object.entries(body.llm || {})) {
          if (['step_models', 'step_context_window_tokens'].includes(key)) {
            canonical.llm[key] = { ...canonical.llm[key] };
            for (const [step, row] of Object.entries(value)) {
              if (row === null) delete canonical.llm[key][step]; else canonical.llm[key][step] = row;
            }
            if (!Object.keys(canonical.llm[key]).length) delete canonical.llm[key];
          } else canonical.llm[key] = value;
        } }
      return { ok: true, config: JSON.parse(JSON.stringify(canonical, (key, value) => key === 'api_key' ? '********' : value)) };
    },
  };
  const mappingCode = slice('function normalizeProfile(', 'function resolveProfileBaseUrl(')
    + slice('function _extractKeyValue(', '// Exported for meta endpoints')
    + slice('function _stripTrailingSlash(', 'function httpGetJson(')
    + slice('async function listModelsForProfileUncached(', 'function resolveProfileCredentials(')
    + slice('function mappingContext(', 'let _externalSpawnCooldownUntilUnixMs')
    + slice('function buildMemuPayloadForLocal(', '// ---------------------------------')
    + slice('export async function proxyConversationTurn(', 'export async function proxyConversationTurnUndo(')
    + slice('export async function proxyNarrativeSuggestion(', 'export function registerNarrativeSuggestion(');
  vm.runInNewContext(ts.transpileModule(mappingCode, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, mapping);
  let projection, status;
  const mappingRes = { json: body => { projection = body; }, status: code => { status = code; return mappingRes; } };
  const request = { method: 'GET', user: { directories: { root: ownDir } }, query: {} };
  await mapping.exports.proxyModelMappings(request, mappingRes);
  assert.equal(reloads, 1); assert.equal(discoveries, 0); assert.equal(coreWrites, 0);
  assert.equal(projection.base_model.chat_model, 'custom-base');
  assert.equal(projection.providers.find(p => p.profile_id === 'unsupported').supported, false);
  assert.equal(projection.providers.find(p => p.profile_id === 'local').supported, true);
  assert.equal(projection.providers.find(p => p.profile_id === 'metadata').models.length, 1);
  assert.equal(projection.providers.find(p => p.profile_id === 'missing-key').supported, false);
  assert.match(projection.providers.find(p => p.profile_id === 'missing-key').reason, /Missing api_key.*Cloud without credentials/);
  assert(!projection.providers.some(p => p.profile_id.startsWith('native:')));
  assert(!JSON.stringify(projection).includes('own-a-key')); assert(!JSON.stringify(projection).includes('embedding-key'));
  assert.equal(projection.mental_health_query, undefined, 'Mental Health is not a shared model mapping');
  const before = coreWrites;
  const post = async body => {
    status = undefined;
    await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body }, mappingRes);
  };
  await post({ step_models: { memory_extract: { source: 'configured', profile_id: 'a', api_key: 'forged-key', resolved: { api_key: 'forged-key' } } } });
  assert.equal(coreWrites, before + 1); assert.equal(discoveries, 0);
  assert.equal(canonical.llm.step_models.memory_extract.api_key, 'own-a-key');
  assert.equal(canonical.llm.step_models.memory_extract.context_window_tokens, 8000);
  assert.equal(projection.step_models.memory_extract.profile_id, 'a');
  await post({ step_models: { memory_extract: { source: 'configured', profile_id: 'a-twin' } } });
  assert.equal(projection.step_models.memory_extract.profile_id, 'a-twin');
  canonical.llm.step_models.memory_extract.api_key = 'hand-only-credential';
  await mapping.exports.proxyModelMappings(request, mappingRes);
  assert.equal(projection.step_models.memory_extract.profile_id, undefined, 'Changed key cannot match by URL/model');
  canonical.llm.step_models.memory_extract.api_key = 'own-a-key';

  assert.equal(canonical.llm.step_models.reflection, 'hand-model');
  assert.equal(canonical.llm.embedding.api_key, 'embedding-key'); assert.equal(canonical.llm.api_key, 'base-key');
  assert(!JSON.stringify(projection).includes('"api_key":'));
  assert(!JSON.stringify(lastPatch).includes('selection')); assert(!JSON.stringify(lastPatch).includes('resolved'));
  await post({ step_models: { reflection: { source: 'configured', profile_id: 'b' } } });
  assert.equal(canonical.llm.step_models.reflection.api_key, 'own-b-key');
  assert.equal(canonical.llm.step_models.reflection.context_window_tokens, 7000);
  assert.equal(canonical.llm.step_context_window_tokens.reflection, undefined);
  assert.equal(canonical.llm.step_context_window_tokens.unrelated, 3000);
  await post({ step_models: { preprocess: { model: 'custom-hand-model', api_key: 'forged' } } });
  assert.equal(canonical.llm.step_models.preprocess, 'custom-hand-model');
  await post({ step_models: { preprocess: null, reflection: null, memory_extract: null } });
  assert.equal(canonical.llm.step_models, undefined);
  assert.deepEqual(lastPatch.llm.step_context_window_tokens, { preprocess: null, reflection: null, memory_extract: null });
  const native = { profile_id: 'native:cc:custom', provider: 'custom', model: 'custom-local', base_url: 'http://localhost:1234/v1', context_window_tokens: 9000 };
  await post({ base_model: { source: 'st_native', native } });
  assert.equal(canonical.llm.api_key, ''); assert.equal(canonical.llm.context_window_tokens, 9000);
  await post({ base_model: { source: 'configured', profile_id: 'local' } });
  assert.equal(canonical.llm.base_url, 'http://localhost:11434/v1'); assert.equal(canonical.llm.api_key, '');
  assert.equal(lastPatch.llm.context_window_tokens, null); assert.equal(lastPatch.llm.max_tokens, null);
  assert.equal(lastPatch.llm.temperature, null); assert.deepEqual(lastPatch.llm.endpoint_overrides, {});
  assert.equal(canonical.llm.embedding.api_key, 'embedding-key');
  assert.deepEqual(metadataCalls[0], { url: 'http://localhost:11434/v1/models', headers: {} });
  const beforeDeletedBase = coreWrites;
  await post({ base_model: { source: 'configured', profile_id: 'deleted', native } });
  assert.equal(coreWrites, beforeDeletedBase, 'Deleted Other App profile must not write a fallback connection');
  await post({ step_models: { preprocess: { source: 'srmm', srmm: { source: 'config' } } } });
  const copiedBase = normalize(canonical.llm.step_models.preprocess);
  assert.equal(copiedBase.base_url, canonical.llm.base_url); assert.equal(copiedBase.api_key, '');
  assert.equal(Object.hasOwn(copiedBase, 'source'), false);
  await post({ base_model: { source: 'configured', profile_id: 'b' } });
  assert.deepEqual(normalize(canonical.llm.step_models.preprocess), copiedBase, 'Config-default SRMM copies once');
  const replyReq = { ...request, body: { userId: 'TestOwner', soulId: 'TestSoul', conversationId: 'test-chat', message: 'Draft', suggestion: 'Fictional suggestion' } };
  for (const handler of [mapping.exports.proxyConversationTurn, mapping.exports.proxyNarrativeSuggestion]) {
    for (const [choice, key] of [[{ source: 'config' }, null], [{ source: 'configured', profile_id: 'b' }, 'own-b-key'],
      [{ source: 'configured', profile_id: 'deleted', native }, ''], [{ source: 'st_native', native }, '']]) {
      status = undefined;
      await handler({ ...replyReq, body: { ...replyReq.body, srmm: choice } }, mappingRes);
      assert.equal(status, undefined);
      if (key === null) assert.equal(replyWire.srmm, 'config'); else assert.equal(replyWire.srmm.api_key, key);
    }
    const previous = replyWire;
    for (const choice of [undefined, { source: 'configured', profile_id: 'unsupported' }, { source: 'st_native', native: null }]) {
      status = undefined;
      await handler({ ...replyReq, body: { ...replyReq.body, srmm: choice } }, mappingRes);
      assert.equal(status, 400); assert.equal(replyWire, previous);
    }
  }
  settings.oai_settings.reverse_proxy = 'https://proxy.invalid/v1';
  settings.oai_settings.proxy_password = 'fictional-proxy-password';
  await post({ step_models: { reflection: { source: 'st_native', native: { profile_id: 'a', provider: 'openai', model: 'same-name' } } } });
  assert.equal(canonical.llm.step_models.reflection.base_url, settings.oai_settings.reverse_proxy);
  assert.equal(canonical.llm.step_models.reflection.api_key, 'fictional-proxy-password');
  const writesBeforeLoad = coreWrites;
  canonical.llm.step_models.reflection = 'new-hand-edit';
  await mapping.exports.proxyModelMappings(request, mappingRes);
  assert.equal(projection.step_models.reflection, 'new-hand-edit'); assert.equal(coreWrites, writesBeforeLoad);
  for (const row of [{ source: 'configured', profile_id: 'unsupported' }, { profile_id: 'a', provider: 'openrouter', model: 'same-name' }, { profile_id: 'missing', provider: 'openai', model: 'same-name' }]) {
    const beforeRefusal = coreWrites;
    await post({ step_models: { reflection: row } });
    assert.equal(status, 400); assert.equal(coreWrites, beforeRefusal);
  }
  const beforeMissing = JSON.stringify(canonical), missingWrites = coreWrites, missingDiscovery = discoveries;
  for (const body of [{ base_model: { source: 'configured', profile_id: 'missing-key' } },
    { step_models: { reflection: { source: 'configured', profile_id: 'missing-key' } } },
    { base_model: { source: 'st_native', native: { profile_id: 'native:cc:groq', provider: 'groq', model: 'cloud-model', base_url: 'https://cloud.invalid/v1' } } }]) {
    await post(body);
    assert.equal(status, 400); assert.match(projection.error, /Missing api_key/);
    assert.equal(coreWrites, missingWrites); assert.equal(JSON.stringify(canonical), beforeMissing);
    assert.equal(discoveries, missingDiscovery);
  }
  profiles.push({ id: 'keyless-alias', name: 'Explicit local endpoint', mode: 'cc', api: 'openai',
    model: 'local-alias', 'api-url': 'http://localhost:1235/v1', context_window_tokens: 8000 });
  const openAiSecrets = secrets.api_key_openai;
  delete secrets.api_key_openai;
  await post({ base_model: { source: 'configured', profile_id: 'keyless-alias' } });
  assert.equal(status, undefined);
  assert.equal(canonical.llm.api_key, '', 'A provider label must not ban an explicitly keyless non-default endpoint');
  assert.equal(canonical.llm.base_url, 'http://localhost:1235/v1');
  secrets.api_key_openai = openAiSecrets;

  const metadataProfile = profiles.find(p => p.id === 'metadata');
  metadataResponse = { data: [{ id: 'chosen-model', context_length: 32000 }, { id: 'other-model', context_length: 999999 }] };
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(status, undefined); assert.equal(canonical.llm.context_window_tokens, 32000);
  assert.equal(projection.base_model.profile_id, 'metadata');
  assert.equal(projection.providers.find(p => p.profile_id === 'metadata').models.length, 1, 'Never expose discovered model dropdowns');
  assert.deepEqual(metadataCalls.at(-1), { url: 'https://metadata.invalid/v1/models',
    headers: { Authorization: 'Bearer scoped-metadata-key', 'x-api-key': 'scoped-metadata-key' } });
  const cachedDiscoveries = discoveries;
  await post({ step_models: { reflection: { source: 'configured', profile_id: 'metadata' } } });
  assert.equal(canonical.llm.step_models.reflection.context_window_tokens, 32000);
  await mapping.exports.proxyModelMappings(request, mappingRes);
  assert.equal(discoveries, cachedDiscoveries, 'Unexpired selected metadata is reused; GET never discovers');
  for (const cached of mapping.MODEL_CACHE.values()) cached.ts = 0;
  metadataResponse = { data: [{ id: 'chosen-model', context_length: 48000 }] };
  await mapping.exports.proxyModelMappings(request, mappingRes);
  assert.equal(discoveries, cachedDiscoveries, 'Expired metadata never triggers network during display');
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(canonical.llm.context_window_tokens, 48000);
  assert.equal(discoveries, cachedDiscoveries + 1);

  metadataProfile.model = 'no-capacity';
  metadataResponse = { data: [{ id: 'chosen-model', context_length: 32000 }, { id: 'no-capacity' }] };
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(canonical.llm.chat_model, 'no-capacity'); assert.equal(lastPatch.llm.context_window_tokens, null);
  assert.equal(discoveries, cachedDiscoveries + 2, 'Changing the chosen model cannot reuse old-model metadata');
  metadataProfile.api_key = 'changed-scoped-key';
  metadataResponse = [{ id: 'no-capacity', context_window_tokens: 16000 }];
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(canonical.llm.context_window_tokens, 16000);
  assert.equal(discoveries, cachedDiscoveries + 3, 'Changed credentials cannot reuse metadata');
  metadataProfile['api-url'] = 'https://changed-metadata.invalid/v1';
  metadataResponse = { models: [{ id: 'no-capacity', context_window: 24000 }] };
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(canonical.llm.context_window_tokens, 24000);
  assert.equal(metadataCalls.at(-1).url, 'https://changed-metadata.invalid/v1/models');
  metadataProfile.model = 'unlisted';
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(lastPatch.llm.context_window_tokens, null, 'Never use another model capacity when chosen model is absent');

  metadataProfile.model = 'unavailable'; metadataError = true;
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(status, undefined); assert.equal(lastPatch.llm.context_window_tokens, null);
  metadataError = false;
  metadataProfile.context_window_tokens = 12000;
  const explicitDiscoveries = discoveries;
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(canonical.llm.context_window_tokens, 12000); assert.equal(discoveries, explicitDiscoveries);
  await post({ base_model: { source: 'st_native', native: { profile_id: 'metadata', provider: 'custom', model: 'unavailable', context_window_tokens: 10000 } } });
  assert.equal(canonical.llm.context_window_tokens, 10000, 'Native capacity takes precedence over profile capacity');
  assert.equal(canonical.llm.api_key, '', 'Explicit custom connection remains keyless');
  assert.equal(discoveries, explicitDiscoveries);
  delete metadataProfile.context_window_tokens;
  delete metadataProfile.api_key;
  metadataResponse = { data: [{ id: 'unavailable', context_length: 13000 }] };
  await post({ base_model: { source: 'configured', profile_id: 'metadata' } });
  assert.equal(canonical.llm.api_key, ''); assert.equal(canonical.llm.context_window_tokens, 13000);
  assert.deepEqual(metadataCalls.at(-1).headers, {}, 'Custom keyless metadata omits empty authentication headers');
  canonical.llm.context_window_tokens = 11000;
  mapping.MODEL_CACHE.clear();
  const beforeColdRefresh = discoveries;
  await mapping.exports.proxyModelMappings(request, mappingRes);
  assert.equal(canonical.llm.context_window_tokens, 11000, 'Catalog refresh must preserve hand capacity');
  assert.equal(discoveries, beforeColdRefresh, 'Fresh profile display never needs discovery');
  assert.equal(projection.base_model.profile_id, undefined, 'Do not guess a match for unknown hand capacity');
  const beforeUnauthenticated = reloads;
  await mapping.exports.proxyModelMappings({ method: 'GET' }, mappingRes);
  assert.equal(status, 403); assert.equal(reloads, beforeUnauthenticated);
  console.log('Actual mapping bridge: startup reload, configured models only, scoped credentials, keyless/native transports, capacities, masking and refusals pass.');

})().catch(error => { console.error(error); process.exitCode = 1; });
