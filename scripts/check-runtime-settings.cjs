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
  process: { env: {} }, path: require('node:path'),
  resolveProfileCredentials(id) {
    resolved.push(id);
    return { ok: true, provider: 'openai', baseUrl: 'https://test.invalid/v1', key: 'fictional-key', model: id };
  },
  mapSTProviderToMemU: () => ({ provider: 'openai' }),
};
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const normalize = value => JSON.parse(JSON.stringify(value));
const saved = { defaultProfileId: 'test-api', stepProfileId: { preprocess: 'test-preprocess', reflection: 'test-reflection', embeddings: 'unused' } };
let cfg = context.sanitizeIncomingConfig(saved);
assert.equal(cfg.useServerSettings, true);
assert.equal(cfg.useClaudeCode, false);
for (const bad of ['false', 0, null]) {
  const sanitized = context.sanitizeIncomingConfig({ useServerSettings: bad, useClaudeCode: bad });
  assert.equal(sanitized.useServerSettings, true);
  assert.equal(sanitized.useClaudeCode, false);
}
const conversation = [{ role: 'user', content: 'Fictional message' }];
for (const useServerSettings of [true, false]) {
  for (const useClaudeCode of [false, true]) {
    cfg = context.sanitizeIncomingConfig({ ...saved, useServerSettings, useClaudeCode });
    resolved = [];
    const payload = normalize(context.buildMemuPayloadForLocal(cfg, 'TestOwner', 'TestSoul', conversation, { conversationId: ' test-chat ' }));
    assert.deepEqual(payload.user, { user_id: 'TestOwner', soul_id: 'TestSoul' });
    assert.deepEqual(payload.conversation, conversation);
    assert.equal(payload.conversation_id, 'test-chat');
    if (useServerSettings || useClaudeCode) {
      assert.deepEqual(resolved, []);
      for (const field of ['llm_profiles', 'memorize_config', 'retrieve_config']) assert.equal(field in payload, false);
      assert.equal(JSON.stringify(payload).includes('fictional-key'), false);
    } else {
      assert.deepEqual(resolved, ['test-api', 'test-preprocess', 'test-reflection']);
      assert.equal(payload.llm_profiles.default.chat_model, 'test-api');
      assert.equal(payload.llm_profiles.preprocess.api_key, 'fictional-key');
      assert.deepEqual(payload.memorize_config, { preprocess_llm_profile: 'preprocess' });
      assert.deepEqual(payload.retrieve_config, { sufficiency_check_llm_profile: 'reflection' });
      assert.equal('embeddings' in payload.llm_profiles, false);
    }
    assert.equal('claude_code' in payload, !useServerSettings);
    if (!useServerSettings) assert.equal(payload.claude_code, useClaudeCode);
    const restored = context.sanitizeIncomingConfig({ ...cfg, useServerSettings: !useServerSettings });
    assert.equal(restored.defaultProfileId, saved.defaultProfileId);
    assert.deepEqual(normalize(restored.stepProfileId), saved.stepProfileId);
    assert.equal(restored.useClaudeCode, useClaudeCode);
    context.exports.setPluginConfig(restored);
    assert.deepEqual(persisted.stepProfileId, saved.stepProfileId);
    assert.equal(persisted.useServerSettings, !useServerSettings);
    assert.equal(persisted.useClaudeCode, useClaudeCode);
  }
}
context.resolveProfileCredentials = () => { throw new Error('Credential resolution must be skipped'); };
for (const mode of [{ useServerSettings: true }, { useServerSettings: false, useClaudeCode: true }]) {
  context.buildMemuPayloadForLocal(context.sanitizeIncomingConfig({ ...saved, ...mode }), 'TestOwner', 'TestSoul');
}
assert.throws(() => context.buildMemuPayloadForLocal(context.sanitizeIncomingConfig({ ...saved, useServerSettings: false }), 'TestOwner', 'TestSoul'), /Credential resolution/);
console.log('Runtime defaults, explicit modes, profile mapping, credential omission and saved-choice restoration pass.');

const soulContext = {
  exports: {}, readPluginConfig: () => ({}), ensureLocalServer: async () => ({ baseUrl: 'http://test.invalid' }),
  httpJson: async (_url, route, method, body) => ({ route, method, body }),
};
vm.runInNewContext(ts.transpileModule(slice('export async function proxySouls(', '// ---------------------')
  + slice('export function registerSouls(', 'export async function proxyNarrativeSuggestion('), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, soulContext);
(async () => {
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

  const storedSettings = { useServerSettings: true, useClaudeCode: false, defaultProfileId: 'later-default',
    stepProfileId: { reflection: 'broken-unused', category_update: 'also-broken' } };
  context.readPluginConfig = () => storedSettings;
  context.ensureLocalServer = async () => ({ baseUrl: 'http://test.invalid' });
  let suggestionWire, suggestionResult, status;
  context.httpJson = async (_url, route, method, payload) => {
    suggestionWire = normalize(payload);
    assert.equal(route, '/souls/TestSoul/narrative_suggestion'); assert.equal(method, 'POST');
    return { narrative_self: 'Fictional considered result' };
  };
  context.resolveProfileCredentials = id => {
    resolved.push(id);
    if (id !== 'captured-api') throw new Error(`Broken unused profile ${id}`);
    return { ok: true, provider: 'openai', baseUrl: 'https://test.invalid/v1', key: 'fictional-key', model: id };
  };
  const suggestionRes = { json: value => { suggestionResult = value; }, status: value => { status = value; return suggestionRes; } };
  const suggestionBody = { userId: 'TestOwner', soulId: 'TestSoul', suggestion: 'Fictional suggestion' };
  for (const useServerSettings of [true, false]) {
    for (const useClaudeCode of [true, false]) {
      resolved = []; status = undefined;
      await context.exports.proxyNarrativeSuggestion({ body: { ...suggestionBody, runtimeSettings: {
        useServerSettings, useClaudeCode, defaultProfileId: 'captured-api', stepProfileId: { reflection: 'broken-unused' },
      } } }, suggestionRes);
      assert.equal(status, undefined);
      assert.equal(suggestionResult.narrative_self, 'Fictional considered result');
      assert.deepEqual(suggestionWire.user, { user_id: 'TestOwner', soul_id: 'TestSoul' });
      assert.equal(suggestionWire.user_id, 'TestOwner'); assert.equal(suggestionWire.suggestion, 'Fictional suggestion');
      if (!useServerSettings && !useClaudeCode) {
        assert.deepEqual(resolved, ['captured-api']);
        assert.deepEqual(Object.keys(suggestionWire.llm_profiles), ['default']);
        assert.equal(suggestionWire.llm_profiles.default.chat_model, 'captured-api');
      } else {
        assert.deepEqual(resolved, []); assert.equal('llm_profiles' in suggestionWire, false);
      }
      assert.equal('claude_code' in suggestionWire, !useServerSettings);
      if (!useServerSettings) assert.equal(suggestionWire.claude_code, useClaudeCode);
      assert.equal('memorize_config' in suggestionWire, false); assert.equal('retrieve_config' in suggestionWire, false);
    }
  }
  assert.deepEqual(storedSettings.stepProfileId, { reflection: 'broken-unused', category_update: 'also-broken' });
  let releaseServer;
  context.ensureLocalServer = () => new Promise(resolve => { releaseServer = resolve; });
  const captured = { useServerSettings: false, useClaudeCode: false, defaultProfileId: 'captured-api', stepProfileId: { reflection: 'broken-unused' } };
  const delayed = context.exports.proxyNarrativeSuggestion({ body: { ...suggestionBody, runtimeSettings: captured } }, suggestionRes);
  captured.defaultProfileId = 'changed-after-send';
  releaseServer({ baseUrl: 'http://test.invalid' }); await delayed;
  assert.equal(suggestionWire.llm_profiles.default.chat_model, 'captured-api');
  console.log('Suggestion uses captured default runtime only, skips unused profiles, and preserves choices through server waits.');
})().catch(error => { console.error(error); process.exitCode = 1; });
