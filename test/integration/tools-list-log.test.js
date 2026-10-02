// The adapter records each tools/list answer (tool names, count, why input tools were in or out)
// and each initialize — never arguments, terminal text, or keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpServer } = require('../../src/mcp/server');

function server(capsImpl) {
  const events = [];
  const sent = [];
  const s = createMcpServer({ callTool: async (name) => capsImpl(name), send: (m) => sent.push(m), onEvent: (e) => events.push(e) });
  return { s, events, sent };
}

const caps = (inputWrite) => async () => ({ ok: true, features: { input_write: inputWrite } });

test('tools/list is logged with the names and count it returned', async () => {
  for (const [impl, count, reason] of [[caps(true), 6, 'input_on'], [caps(false), 4, 'input_off']]) {
    const t = server(impl);
    await t.s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = t.sent[0].result.tools.map((x) => x.name);
    assert.equal(names.length, count);
    assert.deepEqual(t.events, [{ event: 'tools_list', count, tools: names.join(','), reason }]);
  }
});

test('a failing capabilities check is logged as the reason input tools were left out', async () => {
  const t = server(async () => { throw new Error('APP_UNAVAILABLE'); });
  await t.s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(t.events[0].count, 4);
  assert.equal(t.events[0].reason, 'app_unavailable');
  const u = server(async () => ({ ok: false, error: { code: 'X' } }));
  await u.s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(u.events[0].reason, 'capabilities_error');
});

test('initialize is logged with a sanitized client name only; tool calls are not logged here', async () => {
  const t = server(caps(true));
  await t.s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'openai-mcp\n{"x":1}', version: '1' } } });
  assert.deepEqual(t.events, [{ event: 'mcp_initialize', reason: 'openai-mcpx1 2025-06-18' }]);
  await t.s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workbench_capabilities', arguments: {} } });
  assert.equal(t.events.length, 1);
});
