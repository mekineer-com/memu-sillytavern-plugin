const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the existing proxies and HTTP decoder without starting ST or reading config.
const source = fs.readFileSync(`${__dirname}/../src/memu-endpoint.ts`, 'utf8');
const code = source.slice(source.indexOf('async function httpJson('), source.indexOf('// ---------------------------------', source.indexOf('async function httpJson(')))
  + source.slice(source.indexOf('export async function proxyConversationRetrieve('), source.indexOf('export async function proxyConversationTurnUndo('));
const detail = { code: 'soul_paused', message: 'Test Soul is paused. Retry in OpenAlma launcher.' };
const context = {
  exports: {}, URLSearchParams,
  fetch: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ detail }) }),
  readPluginConfig: () => ({}), ensureLocalServer: async () => ({ baseUrl: 'http://test.invalid' }),
  buildMemuPayloadForLocal: () => ({}),
};
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
(async () => {
  for (const handler of [context.exports.proxyConversationRetrieve, context.exports.proxyConversationTurn]) {
    let status, body;
    const res = { status(value) { status = value; return this; }, json(value) { body = value; } };
    await handler({ body: { userId: 'TestOwner', soulId: 'TestSoul', conversationId: 'test-chat', query: 'Draft', message: 'Draft' } }, res);
    assert.equal(status, 409);
    assert.equal(body.error.code, detail.code);
    assert.equal(body.error.message, detail.message);
  }
  console.log('Paused retrieve/turn proxies preserve scoped refusal.');
})().catch(error => { console.error(error); process.exitCode = 1; });
