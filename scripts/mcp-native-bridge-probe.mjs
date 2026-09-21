import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { runCodexTurn } from '../packages/hcp-runner/dist/harnesses/adapters/providers/codex-runtime.js';

// Exercises the installed native runtime with a local model fixture and no external effects.
const directory = await mkdtemp(join(tmpdir(), 'hcp-mcp-native-'));
const home = join(directory, 'codex');
await mkdir(home);
const namespace = `mcp_${createHash('sha256').update('fixture').digest('hex').slice(0, 24)}`;
const requests = [];
const calls = [];
const mock = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const id = `response_${requests.length}`;
  const item = calls.length === 0
    ? {type: 'function_call', id: 'fc_fixture', call_id: 'fixture_call', namespace, name: 'echo', arguments: '{"text":"hello"}', status: 'completed'}
    : {type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{type: 'output_text', text: 'Tool completed.', annotations: []}]};
  response.writeHead(200, {'Content-Type': 'text/event-stream'});
  const event = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({type, ...payload})}\n\n`);
  event('response.created', {response: {id, object: 'response', status: 'in_progress', output: []}});
  event('response.output_item.added', {output_index: 0, item});
  event('response.output_item.done', {output_index: 0, item});
  event('response.completed', {response: {id, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}});
  response.end();
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
try {
  await writeFile(join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local MCP fixture"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const selection = {model: 'fixture-model', options: []};
  const output = await runCodexTurn({
    provider: {id: 'fixture', driver_kind: 'codex', executable_path: process.env.CODEX_BINARY ?? 'codex', home, env: {}, launch_args: []},
    session: {adapter_session_id: 'fixture'},
    startPayload: {session_id: 'fixture', cwd: directory, model_selection: selection, sandbox_mode: 'read_only', approval_policy: 'full_access', mcp_servers: []},
    payload: {session_id: 'fixture', turn_id: 'turn', input: 'Call echo with text hello.', model_selection: selection},
    mcpServers: [{name: 'fixture', transport: 'streamable_http', url: 'http://127.0.0.1:1/mcp', headers: {}}],
    mcpToolsets: [{name: 'fixture', tools: [{name: 'echo', input_schema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false}}],
      async callTool(name, args) {calls.push({name, args}); return {is_error: false, structured_content: {echo: args.text}};},
    }],
  }, AbortSignal.timeout(45_000), () => {});
  assert.equal(output.final_text, 'Tool completed.');
  assert.deepEqual(calls, [{name: 'echo', args: {text: 'hello'}}]);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].input.some(item => item.type === 'function_call_output' && JSON.stringify(item.output).includes('hello')));
  console.log(JSON.stringify({status: 'completed', native_calls: calls.length, model_requests: requests.length}));
} finally {
  await new Promise(resolve => mock.close(resolve));
  await rm(directory, {recursive: true, force: true});
}
