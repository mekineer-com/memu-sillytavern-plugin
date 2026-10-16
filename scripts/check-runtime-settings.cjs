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
assert.equal(context.sanitizeIncomingConfig({ serverPath: '  ' }).serverPath, undefined);
const managed = { ...context, exports: {}, process: { env: { MEMU_SERVER_PATH: ' /fictional/managed/server ' } } };
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, managed);
assert.equal(managed.sanitizeIncomingConfig({}).serverPath, '/fictional/managed/server');
assert.equal(managed.sanitizeIncomingConfig({ serverPath: '  ' }).serverPath, '/fictional/managed/server');
assert.equal(managed.sanitizeIncomingConfig({ serverPath: '/fictional/manual/server' }).serverPath, '/fictional/manual/server');
const normalize = value => JSON.parse(JSON.stringify(value));
const saved = { serverPath: '/fictional/server', autoStartServer: false, embeddingBatchSize: 9,
  useServerSettings: false, useClaudeCode: true, defaultProfileId: 'obsolete', stepProfileId: { reflection: 'obsolete' } };
const cfg = context.sanitizeIncomingConfig(saved);
context.exports.setPluginConfig(cfg);
for (const key of ['useServerSettings', 'useClaudeCode', 'defaultProfileId', 'stepProfileId']) assert.equal(Object.hasOwn(persisted, key), false);
assert.equal(persisted.serverPath, saved.serverPath); assert.equal(persisted.autoStartServer, false); assert.equal(persisted.embeddingBatchSize, 9);
context.resolveProfileCredentials = () => assert.fail('Metadata must not resolve obsolete profiles');
const payload = normalize(context.buildMemuPayloadForLocal(cfg, 'TestOwner', 'TestSoul', [{ role: 'user', content: 'Fictional message' }], { conversationId: ' test-chat ' }));
assert.deepEqual(payload.user, { user_id: 'TestOwner', soul_id: 'TestSoul' }); assert.equal(payload.conversation_id, 'test-chat');
for (const key of ['claude_code', 'llm_profiles', 'memorize_config', 'retrieve_config']) assert.equal(Object.hasOwn(payload, key), false);
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
    for (const autoStartServer of [false, true]) {
      for (const forceStart of [false, true]) {
        let healthy = false, spawns = 0;
        const lifecycle = {
          process: { env: managed ? { MEMU_SERVER_MANAGED: 'launcher' } : {} }, URL,
          getExternalServerBaseUrl: () => 'http://fictional.invalid:8099',
          isServerHealthy: async () => healthy,
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
        const cfg = { autoStartServer, serverPath: '/fictional/saved/server' };
        lifecycle.readPluginConfig = () => cfg;
        assert.equal((await lifecycle.exports.externalServerStatus()).managedByLauncher, managed);
        lifecycle.readPluginConfig = () => { throw new Error('Fictional config failure'); };
        assert.equal((await lifecycle.exports.externalServerStatus()).managedByLauncher, managed);
        lifecycle.readPluginConfig = () => cfg;
        const shouldStart = !managed && (autoStartServer || forceStart);
        if (shouldStart) await lifecycle.ensureLocalServer(cfg, { forceStart });
        else await assert.rejects(lifecycle.ensureLocalServer(cfg, { forceStart }), managed ? /Start memU Server in OpenAlma Launcher/ : /autoStartServer=false/);
        assert.equal(spawns, shouldStart ? 1 : 0);
        assert.equal(cfg.autoStartServer, autoStartServer);
        healthy = true;
        await lifecycle.ensureLocalServer(cfg, { forceStart });
        assert.equal(spawns, shouldStart ? 1 : 0);
        if (managed) {
          healthy = false;
          await assert.rejects(lifecycle.ensureLocalServer(cfg, { forceStart }), /Start memU Server in OpenAlma Launcher/);
          healthy = true;
          await lifecycle.ensureLocalServer(cfg, { forceStart });
          assert.equal(spawns, 0);
        }
      }
    }
  }
  console.log('Managed requests never spawn; standalone auto-start and explicit Start remain intact.');
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
  let suggestionWire;
  context.httpJson = async (_url, route, method, body) => { suggestionWire = normalize(body); return { narrative_self: 'Considered' }; };
  await context.exports.proxyNarrativeSuggestion({ body: { userId: 'TestOwner', soulId: 'TestSoul', suggestion: 'Fictional request' } }, { json() {}, status() { assert.fail('Unexpected suggestion error'); } });
  assert.deepEqual(suggestionWire, { user: { user_id: 'TestOwner', soul_id: 'TestSoul' }, user_id: 'TestOwner', suggestion: 'Fictional request' });
  console.log('Suggestions defer model selection to the canonical server mapping.');

  const ownDir = '/fake/user-A';
  const profiles = [
    { id: 'a', name: 'A', mode: 'cc', api: 'openai', model: 'same-name', 'api-url': 'https://a.invalid/v1', 'secret-id': 'a-key', context_window_tokens: 8000 },
    { id: 'b', name: 'B', mode: 'cc', api: 'openrouter', model: 'same-name', 'api-url': 'https://b.invalid/v1', 'secret-id': 'b-key' },
    { id: 'unsupported', name: 'Native Claude', mode: 'cc', api: 'claude', model: 'native-model', 'api-url': 'https://claude.invalid' },
    { id: 'local', name: 'Local Ollama compatible endpoint', mode: 'tc', api: 'ollama', model: 'local-model', 'api-url': 'http://localhost:11434' },
  ];
  const settings = { extension_settings: { connectionManager: { profiles } }, oai_settings: { openai_model: 'same-name', mistralai_model: 'mistral-native', custom_model: 'custom-local', custom_url: 'http://localhost:1234/v1' } };
  const secrets = { api_key_openai: [{ id: 'a-key', value: 'own-a-key', active: true }], api_key_openrouter: [{ id: 'b-key', value: 'own-b-key', active: true }], api_key_mistralai: 'native-mistral-key' };
  let canonical = { claude_code: false, llm: { provider: 'openai', chat_model: 'custom-base', api_key: 'base-key', embedding: { api_key: 'embedding-key' }, reply_models: { srmm: { source: 'config' }, other_apps: { source: 'config' } }, step_models: { reflection: { source: 'config' } } } };
  let coreWrites = 0, reloads = 0, discoveries = 0;
  const mapping = { exports: {}, URL, path: require('node:path'), fs: { readFileSync: fs.readFileSync },
    getStRoot: () => require('node:path').resolve(__dirname, '../../..'),
    readJsonIfExists: file => { assert(file.startsWith(ownDir + '/')); return file.endsWith('settings.json') ? settings : secrets; },
    readPluginConfig: () => ({}), ensureLocalServer: async () => ({ baseUrl: 'http://core.invalid' }),
    _stProviderUrls: { openai: 'https://openai.invalid/v1', mistralai: 'https://mistral.invalid/v1' },
    resolveProfileBaseUrl: (_profile, normalized) => normalized.baseUrl,
    sorted_unique: values => [...new Set(values)].sort(), MODEL_CACHE: new Map(), MODEL_CACHE_TTL_MS: 60000,
    listModelsForProfileUncached: async (_id, _kind, credentials) => { discoveries++; assert(credentials.baseUrl); return { ok: true, models: ['same-name', 'second-model'], context_windows: { 'second-model': 7000 } }; },
    httpJson: async (_base, route, method, body) => {
      if (route === '/reload') { reloads++; return { ok: true }; }
      assert.equal(route, '/config');
      if (method === 'POST') { coreWrites++; if (body.claude_code !== undefined) canonical.claude_code = body.claude_code;
        for (const [key, value] of Object.entries(body.llm || {})) canonical.llm[key] = key === 'st_selected' ? value : { ...canonical.llm[key], ...value }; }
      return { ok: true, config: canonical };
    },
  };
  const mappingCode = slice('function normalizeProfile(', 'function resolveProfileBaseUrl(')
    + slice('function _extractKeyValue(', '// Exported for meta endpoints')
    + slice('function nativeModelFields(', 'let _externalSpawnCooldownUntilUnixMs');
  vm.runInNewContext(ts.transpileModule(mappingCode, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, mapping);
  let projection, status;
  const mappingRes = { json: body => { projection = body; }, status: code => { status = code; return mappingRes; } };
  const request = { method: 'GET', user: { directories: { root: ownDir } }, query: {} };
  await mapping.exports.proxyModelMappings(request, mappingRes);
  assert.equal(reloads, 1); assert.equal(discoveries, 0); assert.equal(coreWrites, 0);
  assert.equal(projection.base_model.model, 'custom-base');
  assert.equal(projection.providers.find(p => p.profile_id === 'unsupported').supported, false);
  assert.equal(projection.providers.find(p => p.profile_id === 'local').supported, true);
  assert(projection.providers.some(p => p.profile_id === 'native:cc:mistralai' && p.supported));
  assert(!JSON.stringify(projection).includes('own-a-key')); assert(!JSON.stringify(projection).includes('embedding-key'));
  const before = coreWrites;
  await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body: { reply_models: { srmm: { source: 'configured', selection: { profile_id: 'a', provider: 'openai', model: 'same-name', api_key: 'forged-key' }, resolved: { api_key: 'forged-key' } } } } }, mappingRes);
  assert.equal(coreWrites, before + 1); assert.equal(discoveries, 0);
  assert.equal(canonical.llm.reply_models.srmm.resolved.api_key, 'own-a-key');
  assert.equal(canonical.llm.reply_models.srmm.resolved.context_window_tokens, 8000);
  assert.equal(Object.hasOwn(canonical.llm.reply_models.srmm.selection, 'api_key'), false);
  assert.equal(canonical.llm.embedding.api_key, 'embedding-key'); assert.equal(canonical.llm.api_key, 'base-key');
  await mapping.exports.proxyModelMappings({ ...request, query: { models: 'all' } }, mappingRes);
  assert.equal(reloads, 1); assert.equal(coreWrites, before + 1); assert(discoveries > 1);
  await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body: { step_models: { reflection: { source: 'configured', selection: { profile_id: 'b', provider: 'openrouter', model: 'second-model' } } } } }, mappingRes);
  assert.equal(canonical.llm.step_models.reflection.resolved.api_key, 'own-b-key');
  assert.equal(canonical.llm.step_models.reflection.resolved.context_window_tokens, 7000);
  await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body: { st_selected: { selection: { profile_id: 'native:cc:custom', provider: 'custom', model: 'custom-local', base_url: 'http://localhost:1234/v1', context_window_tokens: 9000 } } } }, mappingRes);
  assert.equal(canonical.llm.st_selected.resolved.api_key, ''); assert.equal(canonical.llm.st_selected.resolved.context_window_tokens, 9000);
  await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body: { st_selected: { selection: { profile_id: 'native:tc:ollama', provider: 'ollama', model: 'local-model', base_url: 'http://localhost:11434' } } } }, mappingRes);
  assert.equal(canonical.llm.st_selected.resolved.base_url, 'http://localhost:11434/v1'); assert.equal(canonical.llm.st_selected.resolved.api_key, '');
  settings.oai_settings.reverse_proxy = 'https://proxy.invalid/v1';
  settings.oai_settings.proxy_password = 'fictional-proxy-password';
  await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body: { st_selected: { selection: { profile_id: 'a', provider: 'openai', model: 'same-name' } } } }, mappingRes);
  assert.equal(canonical.llm.st_selected.resolved.base_url, settings.oai_settings.reverse_proxy);
  assert.equal(canonical.llm.st_selected.resolved.api_key, 'fictional-proxy-password');
  await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body: { st_selected: { selection: { profile_id: 'b', provider: 'openrouter', model: 'same-name' } } } }, mappingRes);
  assert.equal(canonical.llm.st_selected.resolved.base_url, 'https://b.invalid/v1');
  assert.equal(canonical.llm.st_selected.resolved.api_key, 'own-b-key');
  for (const selection of [{ profile_id: 'unsupported', provider: 'claude', model: 'native-model' }, { profile_id: 'a', provider: 'openrouter', model: 'same-name' }, { profile_id: 'missing', provider: 'openai', model: 'same-name' }]) {
    const beforeRefusal = coreWrites; status = undefined;
    await mapping.exports.proxyModelMappings({ ...request, method: 'POST', body: { reply_models: { srmm: { source: 'configured', selection } } } }, mappingRes);
    assert.equal(status, 400); assert.equal(coreWrites, beforeRefusal);
  }
  const beforeUnauthenticated = reloads;
  await mapping.exports.proxyModelMappings({ method: 'GET' }, mappingRes);
  assert.equal(status, 403); assert.equal(reloads, beforeUnauthenticated);
  console.log('Actual mapping bridge: startup reload, scoped credentials, keyless/native transports, capacities, lazy catalog, masking and refusals pass.');

})().catch(error => { console.error(error); process.exitCode = 1; });
