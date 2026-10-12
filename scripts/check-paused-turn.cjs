const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the existing proxies and HTTP decoder without starting ST or reading config.
const source = fs.readFileSync(`${__dirname}/../src/memu-endpoint.ts`, 'utf8');
const code = source.slice(source.indexOf('async function httpJson('), source.indexOf('// ---------------------------------', source.indexOf('async function httpJson(')))
  + source.slice(source.indexOf('function getExternalServerBaseUrl('), source.indexOf('function getExternalServerRunPy('))
  + source.slice(source.indexOf('async function _externalServerHealthInfo('), source.indexOf('export async function externalServerStatus('))
  + source.slice(source.indexOf('export function registerDeleteConversationSource('), source.indexOf('export function registerScopeStorageProbe('))
  + source.slice(source.indexOf('export async function proxyConversationRetrieve('), source.indexOf('export async function proxyScopeStorageProbe('))
  + source.slice(source.indexOf('export async function proxyMemorizeConversation('), source.indexOf('export async function proxyRetrieveDefaultCategories('))
  + source.slice(source.indexOf('export async function proxyNarrativeSuggestion('), source.indexOf('export function registerNarrativeSuggestion('));
const detail = { code: 'soul_paused', message: 'Test Soul is paused. Retry in OpenAlma launcher.' };
const context = {
  exports: {}, URLSearchParams,
  process: { env: { MEMU_SERVER_URL: 'http://test.invalid/' } },
  _externalServerInstanceId: null, _externalServerEphemeralDb: null,
  fetch: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ detail }) }),
  readPluginConfig: () => ({}), ensureLocalServer: async () => ({ baseUrl: 'http://test.invalid' }),
  buildMemuPayloadForLocal: () => ({}),
  pruneLocalTasks: () => {},
  sanitizeIncomingConfig: value => value,
  localTasks: new Map(), makeTaskId: () => `task-${context.localTasks.size}`,
};
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
(async () => {
  for (const handler of [context.exports.proxyConversationRetrieve, context.exports.proxyConversationTurn,
    context.exports.proxyMemorizeConversation, context.exports.proxyNarrativeSuggestion]) {
    let status, body;
    const res = { status(value) { status = value; return this; }, json(value) { body = value; } };
    await handler({ body: { userId: 'TestOwner', soulId: 'TestSoul', conversationId: 'test-chat', query: 'Draft', message: 'Draft', conversation: [], suggestion: 'Fictional suggestion' } }, res);
    assert.equal(status, 409);
    assert.equal(body.error.code, detail.code);
    assert.equal(body.error.message, detail.message);
  }
  console.log('Paused retrieve/turn/memorize/suggestion proxies preserve scoped refusal.');
  let wire, response, cfgAtBuild, releaseServer;
  context.buildMemuPayloadForLocal = (cfg, userId, soulId, conversation, opts) => {
    cfgAtBuild = cfg;
    return { user: { user_id: userId, soul_id: soulId }, conversation, conversation_id: opts.conversationId };
  };
  context.fetch = async (_url, options) => {
    wire = JSON.parse(options.body || '{}');
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  };
  const messages = [
    { role: 'user', name: 'OtherPersona', content: 'Other human', source_conversation_index: 0 },
    { role: 'soul', name: '', content: 'Unnamed saved row', source_conversation_index: 3 },
    { role: 'user', content: 'Owner', source_conversation_index: 4 },
    { role: 'soul', content: 'Newest reply', source_conversation_index: 5 },
  ];
  const settings = { useServerSettings: false, useClaudeCode: true, defaultProfileId: 'captured-api', stepProfileId: { reflection: 'captured-reflection' } };
  const req = { query: { rebuild: 'true' }, body: { userId: 'TestOwner', userName: 'TestOwner', soulId: 'TestSoul',
    conversationId: 'integrity:test-main', conversation: messages, chat_name: 'TestSoul', source_message_count: 6, intent: 'manual', runtimeSettings: settings } };
  let body, httpStatus;
  const res = { json: value => { body = value; }, status: value => { httpStatus = value; return res; } };
  for (const status of ['accepted', 'started', 'waiting_for_import', 'deferred', 'nothing_to_memorize', 'published', 'coalesced']) {
    response = { status };
    const before = context.localTasks.size;
    await context.exports.proxyMemorizeConversation(req, res);
    assert.equal(body.status, status);
    const task = status === 'accepted' || status === 'started';
    assert.equal(Boolean(body.taskId), task);
    assert.equal(context.localTasks.size, before + Number(task));
    assert.equal(wire.conversation[0].name, 'OtherPersona');
    assert.equal(wire.conversation[1].name, '');
    assert.equal(wire.conversation[2].name, 'TestOwner');
    assert.equal(wire.conversation[3].name, 'TestSoul');
    assert.equal(wire.source_message_count, 6); assert.equal(wire.intent, 'manual');
    assert.equal(wire.chat_name, 'TestSoul'); assert.equal(wire.conversation_id, 'integrity:test-main');
    assert.deepEqual(wire.conversation.map(row => row.source_conversation_index), [0, 3, 4, 5]);
    assert.equal(cfgAtBuild.useClaudeCode, true); assert.equal(cfgAtBuild.defaultProfileId, 'captured-api');
  }
  context.ensureLocalServer = () => new Promise(resolve => { releaseServer = resolve; });
  response = { status: 'deferred' };
  const delayed = context.exports.proxyMemorizeConversation(req, res);
  assert.equal(cfgAtBuild.defaultProfileId, 'captured-api'); // builder ran before server wait
  releaseServer({ baseUrl: 'http://test.invalid' }); await delayed;
  context.ensureLocalServer = async () => ({ baseUrl: 'http://test.invalid' });
  for (const status of [undefined, 'success']) {
    const before = context.localTasks.size;
    response = { status }; await context.exports.proxyMemorizeConversation(req, res);
    assert.equal(httpStatus, 502); assert.equal(context.localTasks.size, before);
  }
  for (const phase of ['accepted', 'extracting', 'consolidation']) {
    response = { active: true, phase, current: 0, total: 2 };
    await context.exports.proxyGetTaskStatus({ body: { taskId: 'task-0' } }, res);
    assert.equal(body.status, phase === 'accepted' ? 'PENDING' : 'PROCESSING');
    assert.equal(body.progress.phase, phase);
  }
  for (const last_result of ['success', 'failure', 'cancelled']) {
    response = { active: false, last_result };
    await context.exports.proxyGetTaskStatus({ body: { taskId: 'task-0' } }, res);
    assert.equal(body.status, last_result === 'success' ? 'SUCCESS' : 'FAILURE');
  }
  console.log('Saved metadata/names, captured runtime choices, truthful admissions and accepted/terminal polling pass.');
  context.buildMemuPayloadForLocal = () => assert.fail('Undo must not resolve API profiles');
  response = { status: 'restored' };
  await context.exports.proxyConversationTurnUndo({ body: {
    userId: 'TestOwner', soulId: 'TestSoul', conversationId: 'integrity:test-main', turnId: 'matching-turn',
  } }, res);
  assert.deepEqual(wire, { user: { user_id: 'TestOwner', soul_id: 'TestSoul' }, turn_id: 'matching-turn' });
  assert.equal(body.status, 'restored');
  context.ensureLocalServer = () => assert.fail('Missing turn ID must refuse before connecting');
  await context.exports.proxyConversationTurnUndo({ body: {
    userId: 'TestOwner', soulId: 'TestSoul', conversationId: 'integrity:test-main',
  } }, res);
  assert.equal(httpStatus, 400);
  console.log('Undo forwards the exact reply ID without API-profile resolution; unqualified requests refuse.');

  const transportCalls = [];
  let configReads = 0, healthMode = 'ok', deleteStatus = 200, deleteResponse = { status: 'deleted' };
  const secretConfig = { autoStartServer: true, apiKey: 'fictional-secret', defaultProfileId: 'broken-profile' };
  context.readPluginConfig = () => { configReads++; return secretConfig; };
  context.ensureLocalServer = () => assert.fail('Source retirement must not auto-start memU');
  context.sanitizeIncomingConfig = () => assert.fail('Source retirement must not resolve runtime profiles');
  context.fetch = async (url, options) => {
    transportCalls.push({ url, options });
    if (url.endsWith('/health')) {
      assert.equal(options, undefined);
      if (healthMode === 'throw') throw Error('fictional offline server');
      return { ok: healthMode === 'ok', status: healthMode === 'ok' ? 200 : 503,
        text: async () => JSON.stringify({ serverInstanceId: 'fake-instance', ephemeralDb: false }) };
    }
    if (deleteStatus === 'throw') throw Error('fictional retirement connection failure');
    return { ok: deleteStatus === 200, status: deleteStatus, text: async () => JSON.stringify(deleteResponse) };
  };
  const deletion = { userId: 'TestOwner', soulId: 'TestSoul', conversationId: 'integrity:chat /?#%\u96ea',
    runtimeSettings: secretConfig, apiKey: 'must-not-forward', conversation: messages };
  for (const field of ['userId', 'soulId', 'conversationId']) {
    for (const invalid of [undefined, '', '  ', 7, true, [], {}]) {
      const before = [configReads, transportCalls.length];
      await context.exports.proxyDeleteConversationSource({ body: { ...deletion, [field]: invalid } }, res);
      assert.equal(httpStatus, 400);
      assert.deepEqual([configReads, transportCalls.length], before);
    }
  }
  for (const scope of [{ userId: 'TestOwner', soulId: 'TestSoul' }, { userId: 'OtherOwner', soulId: 'OtherSoul' }]) {
    httpStatus = undefined;
    const before = transportCalls.length;
    await context.exports.proxyDeleteConversationSource({ body: { ...deletion, ...scope } }, res);
    assert.equal(httpStatus, undefined); // Express defaults successful JSON to HTTP 200
    assert.equal(body.status, 'deleted');
    const [health, retired] = transportCalls.slice(before);
    assert.equal(transportCalls.length, before + 2);
    assert.equal(health.url, 'http://test.invalid/health');
    assert.equal(retired.url, `http://test.invalid/conversation/${encodeURIComponent(deletion.conversationId)}/source`);
    assert.equal(retired.options.method, 'DELETE');
    assert.deepEqual(JSON.parse(JSON.stringify(retired.options.headers)), { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(retired.options.body), { user: { user_id: scope.userId, soul_id: scope.soulId } });
  }
  for (const mode of ['refuse', 'throw']) {
    healthMode = mode;
    const before = transportCalls.length;
    await context.exports.proxyDeleteConversationSource({ body: deletion }, res);
    assert.equal(httpStatus, 503); assert.match(body.error, /offline/);
    assert.equal(transportCalls.length, before + 1);
    assert.equal(transportCalls.at(-1).url, 'http://test.invalid/health');
  }
  healthMode = 'ok';
  for (const [status, refusal] of [[409, detail], [404, 'Conversation source missing'], [422, { code: 'invalid_scope', message: 'Fictional scope refusal' }]]) {
    deleteStatus = status; deleteResponse = { detail: refusal };
    await context.exports.proxyDeleteConversationSource({ body: deletion }, res);
    assert.equal(httpStatus, status);
    assert.deepEqual(JSON.parse(JSON.stringify(body.error)), refusal);
  }
  deleteStatus = 'throw';
  await context.exports.proxyDeleteConversationSource({ body: deletion }, res);
  assert.equal(httpStatus, 503); assert.match(body.error, /retirement connection failure/);

  const indexSource = fs.readFileSync(`${__dirname}/../src/index.ts`, 'utf8');
  assert(indexSource.includes('  registerDeleteConversationSource,'));
  const initCode = indexSource.slice(indexSource.indexOf('export async function init('), indexSource.indexOf('export async function exit('));
  const registered = [];
  const initContext = { exports: {}, express: { json: () => 'fake-json-middleware' },
    chalk: { green: value => value }, MODULE_NAME: 'memu', console: { log() {} } };
  for (const [, name] of initCode.matchAll(/\b(register\w+)\(router\);/g)) initContext[name] = () => {};
  initContext.registerDeleteConversationSource = context.exports.registerDeleteConversationSource;
  vm.runInNewContext(ts.transpileModule(initCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, initContext);
  await initContext.exports.init({ use() {}, post: (route, handler) => registered.push({ route, handler }) });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].route, '/deleteConversationSource');
  assert.equal(registered[0].handler, context.exports.proxyDeleteConversationSource);
  console.log('Scoped source retirement, encoded CID, offline refusal, exact HTTP errors and init registration pass without auto-start or profiles.');
})().catch(error => { console.error(error); process.exitCode = 1; });
