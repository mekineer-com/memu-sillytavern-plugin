const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the existing proxies and HTTP decoder without starting ST or reading config.
const source = fs.readFileSync(`${__dirname}/../src/memu-endpoint.ts`, 'utf8');
const code = source.slice(source.indexOf('async function httpJson('), source.indexOf('// ---------------------------------', source.indexOf('async function httpJson(')))
  + source.slice(source.indexOf('export async function proxyConversationRetrieve('), source.indexOf('export async function proxyScopeStorageProbe('))
  + source.slice(source.indexOf('export async function proxyMemorizeConversation('), source.indexOf('export async function proxyRetrieveDefaultCategories('))
  + source.slice(source.indexOf('export async function proxyNarrativeSuggestion('), source.indexOf('export function registerNarrativeSuggestion('));
const detail = { code: 'soul_paused', message: 'Test Soul is paused. Retry in OpenAlma launcher.' };
const context = {
  exports: {}, URLSearchParams,
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
})().catch(error => { console.error(error); process.exitCode = 1; });
