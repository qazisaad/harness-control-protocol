import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { runCodexTurn } from '../packages/hcp-runner/dist/harnesses/adapters/providers/codex-runtime.js';
import { HarnessMcpReview } from '../packages/hcp-runner/dist/harnesses/mcp-review.js';
import { HarnessSessionManager } from '../packages/hcp-runner/dist/harnesses/index.js';
import { JsonRunnerStateStore } from '../packages/hcp-runner/dist/state/index.js';
import { McpInputRequiredError, parseMcpPendingInput } from '../packages/hcp-runner/dist/mcp/input-required.js';

// Local model and tool fixtures; the native process and disk continuation are real.
const directory = await mkdtemp(join(tmpdir(), 'hcp-mcp-input-recovery-'));
const home = join(directory, 'codex');
await mkdir(home);
const statePath = join(directory, 'runner-state.json');
const namespace = `mcp_${createHash('sha256').update('fixture').digest('hex').slice(0, 24)}`;
const requests = [];
let calls = 0;
const mock = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const id = `response_${requests.length}`;
  const item = calls === 0
    ? {type: 'function_call', id: 'fc_fixture', call_id: 'fixture_call', namespace, name: 'echo', arguments: '{"text":"hello"}', status: 'completed'}
    : {type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{type: 'output_text', text: 'Recovered tool completed.', annotations: []}]};
  response.writeHead(200, {'Content-Type': 'text/event-stream'});
  const event = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({type, ...payload})}\n\n`);
  event('response.created', {response: {id, object: 'response', status: 'in_progress', output: []}});
  event('response.output_item.added', {output_index: 0, item});
  event('response.output_item.done', {output_index: 0, item});
  event('response.completed', {response: {id, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}});
  response.end();
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const controller = new AbortController();
try {
  await writeFile(join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local MCP fixture"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const selection = {model: 'fixture-model', options: []};
  const attachment = {name: 'fixture', transport: 'streamable_http', url: 'http://127.0.0.1:1/mcp', headers: {},
    lease_id: 'lease', expires_at: new Date(Date.now() + 120000).toISOString(),
    proof_of_possession: {scheme: 'runner_signed_request', key_id: 'key', required_headers: ['x-hcp-proof-signature']}};
  const start = {session_id: 'fixture', workspace_id: 'workspace', provider_instance_id: 'fixture', driver_kind: 'codex',
    cwd: directory, model_selection: selection, sandbox_mode: 'read_only', approval_policy: 'full_access', continue_session: false,
    mcp_servers: [attachment]};
  const turn = {session_id: 'fixture', turn_id: 'turn', input: 'Call echo with text hello.', model_selection: selection};
  let notifyInput;
  const inputReady = new Promise(resolve => {notifyInput = resolve;});
  const events = [];
  const owner = new HarnessMcpReview(new JsonRunnerStateStore(statePath), start, turn, event => {
    events.push(event);
    if (event.event_type === 'input.requested') notifyInput();
  });
  const pending = parseMcpPendingInput({requestState: 'original-private-state', inputRequests: {name: {
    method: 'elicitation/create', params: {message: 'Choose a name', requestedSchema: {
      type: 'object', properties: {name: {type: 'string'}}, required: ['name'],
    }},
  }}});
  const callTool = async (name, args, grant, reply) => {
    calls++;
    assert.equal(name, 'echo');
    assert.deepEqual(args, {text: 'hello'});
    assert.equal(grant, undefined);
    if (calls === 1) throw new McpInputRequiredError(pending);
    assert.equal(calls, 2);
    assert.deepEqual(reply, {pending, responses: {name: {action: 'accept', content: {name: 'Ada'}}}});
    assert.equal(new JsonRunnerStateStore(statePath).getMcpReview('fixture').outcome.phase, 'input_resuming');
    return {is_error: false, structured_content: {echo: 'hello Ada'}};
  };
  const toolset = {name: 'fixture', tools: [{name: 'echo', input_schema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}}], callTool};
  const input = {
    provider: {id: 'fixture', driver_kind: 'codex', executable_path: process.env.CODEX_BINARY ?? 'codex', home, env: {}, launch_args: []},
    session: {adapter_session_id: 'fixture'}, startPayload: start, payload: turn,
    mcpServers: [attachment], mcpToolsets: [toolset], reviewMcpTool: owner,
  };
  const running = runCodexTurn(input, AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]), () => {});
  const stopped = running.then(() => assert.fail('Input must not complete before a response'), error => error);
  await Promise.race([inputReady, running]);
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.event_type === 'approval.requested'), false);
  controller.abort();
  owner.interrupt();
  await stopped;

  const store = new JsonRunnerStateStore(statePath);
  const retained = store.getMcpReview('fixture');
  assert.equal(retained.outcome.phase, 'input_waiting');
  const manager = new HarnessSessionManager({
    runner_id: 'fixture', host_id: 'host', control_plane_url: 'ws://127.0.0.1:1',
    mcp_stdio_profiles: [], workspaces: [{id: 'workspace', path: directory}], local_capabilities: [],
    provider_instances: [{...input.provider, enabled: true, local_capabilities: [], hidden_models: [], model_order: [],
      favorite_models: [], models: [{id: 'fixture-model', label: 'Fixture', capabilities: {option_descriptors: []}}]}],
  }, {stateStore: store, mcpClientFactory: () => ({
    async connect() {}, async close() {}, async listTools() {return toolset.tools;}, callTool,
  })});
  try {
    await manager.recoverMcpReviews(event => events.push(event), () => assert.fail('Waiting input must not dispatch automatically'));
    assert.equal(calls, 1);
    const response = {session_id: 'fixture', turn_id: 'turn', request_id: retained.outcome.input_request_id,
      actor_id: 'actor', value: {name: {action: 'accept', content: {name: 'Ada'}}}};
    const resolution = await manager.respondToMcpInput(response, event => events.push(event));
    assert.equal(resolution.kind, 'resumed');
    await resolution.completion;
    const terminal = events.filter(event => ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.event_type));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].event_type, 'turn.completed');
    assert.equal(terminal[0].data.final_output.final_text, 'Recovered tool completed.');
    assert.equal(new JsonRunnerStateStore(statePath).getMcpReview('fixture'), undefined);
    await assert.rejects(manager.respondToMcpInput(response, event => events.push(event)), /No waiting/);
  } finally {
    await manager.stopSession('fixture', 'probe complete');
  }
  assert.equal(calls, 2);
  assert.equal(requests.length, 2);
  const recoveredCallId = `reviewed_${retained.request_id}`;
  assert.ok(requests[1].input.some(item => item.type === 'function_call_output' && item.call_id === recoveredCallId && JSON.stringify(item.output).includes('hello Ada')));
  assert.equal(JSON.stringify(events).includes('original-private-state'), false);
  console.log(JSON.stringify({status: 'completed', native_restarted: true, unreviewed_input: true, tool_calls: calls, model_requests: requests.length}));
} finally {
  controller.abort();
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await rm(directory, {recursive: true, force: true});
}
