import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HarnessSessionManager } from '../packages/hcp-runner/dist/harnesses/index.js';
import { JsonRunnerStateStore } from '../packages/hcp-runner/dist/state/index.js';
import { HcpSessionEventReducer } from '../packages/hcp-protocol/dist/index.js';

async function worker() {
  const directory = process.env.MCP_REVIEW_FIXTURE;
  const provider = {id: 'fixture', driver_kind: 'codex', enabled: true,
    executable_path: process.env.CODEX_BINARY ?? 'codex', home: join(directory, 'codex'), env: {}, launch_args: [],
    models: [{id: 'fixture-model', label: 'Fixture', capabilities: {option_descriptors: []}}],
    hidden_models: [], model_order: [], favorite_models: [], local_capabilities: []};
  const config = {runner_id: 'fixture-runner', host_id: 'fixture-host', control_plane_url: 'ws://127.0.0.1:1',
    workspaces: [{id: 'workspace', path: directory}], local_capabilities: [], provider_instances: [provider], mcp_stdio_profiles: []};
  class FixtureStateStore extends JsonRunnerStateStore {
    persist() {
      super.persist();
      if (process.argv.includes('--resume-worker') && this.getMcpReview('session')?.outcome.phase === process.env.MCP_REVIEW_CRASH_PHASE) {
        process.send({type: 'persisted'});
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45000);
        throw new Error('The fixture should kill this worker after the durable write.');
      }
    }
  }
  const store = new FixtureStateStore(join(directory, 'runner-state.json'));
  const manager = new HarnessSessionManager(config, {stateStore: store, mcpClientFactory() {
    return {async connect() {}, async close() {}, async listTools() {return [{name: 'echo', review_policy: {kind: 'always'},
      input_schema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false}}];},
    async callTool(name, args, grant) {
      assert.ok(grant?.request_id);
      process.send({type: 'dispatch', name, args, request_id: grant.request_id});
      if (process.env.MCP_REVIEW_CANCEL_IN_FLIGHT === '1') await manager.cancelTurn('session', 'turn');
      return {is_error: false, structured_content: {echo: args.text}};
    }};
  }});
  const publish = event => {if (event.event_type === 'approval.requested') process.send({type: 'review'});};
  const validateJournal = () => {
    const reducer = new HcpSessionEventReducer();
    for (const event of store.replayEventsAfter('session', 0)) assert.equal(reducer.applyEvent(event).outcome, 'applied');
  };
  if (process.argv.includes('--cancel-worker')) {
    await manager.cancelTurn('session', 'turn');
    assert.deepEqual(await manager.stopSession('session', 'cancelled'), []);
    assert.equal(store.getMcpReview('session'), undefined);
    validateJournal();
    process.send({type: 'completed'});
    return;
  }
  if (process.argv.includes('--resume-worker') || process.argv.includes('--recover-worker')) {
    if (process.argv.includes('--recover-worker')) {
      const completions = [];
      await manager.recoverMcpReviews(publish, completion => {completions.push(completion);});
      await Promise.all(completions);
      if (process.env.MCP_REVIEW_CRASH_PHASE === 'dispatching') {
        assert.ok(store.replayEventsAfter('session', 0).some(event => event.event_type === 'turn.failed' && event.data.error.code === 'mcp_review_outcome_unknown'));
        assert.equal(store.getMcpReview('session'), undefined);
        validateJournal();
        process.send({type: 'completed'});
        return;
      }
    } else {
      const review = store.getMcpReview('session');
      assert.equal(review.outcome.phase, 'waiting');
      const result = await manager.respondToMcpReview({session_id: 'session', turn_id: 'turn',
        request_id: review.request_id, action_hash: review.action_hash, decision: process.env.MCP_REVIEW_DECISION, actor_id: 'fixture-actor'}, publish);
      assert.equal(result.kind, 'resumed');
      await result.completion;
    }
    if (process.env.MCP_REVIEW_CANCEL_IN_FLIGHT === '1') {
      assert.equal(store.replayEventsAfter('session', 0).filter(event => event.event_type === 'turn.cancelled').length, 1);
      assert.equal(store.replayEventsAfter('session', 0).some(event => event.event_type === 'turn.completed'), false);
      await manager.stopSession('session', 'cancelled');
      validateJournal();
      process.send({type: 'completed'});
      return;
    }
    const terminal = store.replayEventsAfter('session', 0).find(event => event.event_type === 'turn.completed');
    assert.equal(terminal?.data.final_output.final_text, 'Review handled.', JSON.stringify(store.replayEventsAfter('session', 0).filter(event => event.event_type === 'turn.failed')));
    assert.equal(store.replayEventsAfter('session', 0).filter(event => event.event_type === 'turn.started').length, 1);
    await manager.stopSession('session', 'fixture_complete');
    validateJournal();
    process.send({type: 'completed'});
  } else {
    await manager.startSession({session_id: 'session', workspace_id: 'workspace', provider_instance_id: 'fixture', driver_kind: 'codex',
      cwd: directory, model_selection: {model: 'fixture-model', options: []}, sandbox_mode: 'read_only', approval_policy: 'full_access',
      continue_session: false, mcp_servers: [{name: 'fixture', transport: 'streamable_http', url: 'https://fixture.invalid/mcp',
        headers: {}, lease_id: 'fixture-lease', expires_at: new Date(Date.now() + 120000).toISOString(),
        proof_of_possession: {scheme: 'runner_signed_request', key_id: 'fixture-key', required_headers: ['x-hcp-proof-signature', 'x-hcp-proof-nonce']}}]});
    await manager.sendTurn({session_id: 'session', turn_id: 'turn', input: 'Call echo with text hello.'}, publish);
    throw new Error('The first worker must be killed while its review is pending.');
  }
}

if (process.argv.some(arg => arg.endsWith('-worker'))) {
  try {await worker(); process.exit(0);} catch (error) {console.error(error); process.exit(1);}
}

const directory = await mkdtemp(join(tmpdir(), 'hcp-reviewed-native-'));
const home = join(directory, 'codex');
await mkdir(home);
const namespace = `mcp_${createHash('sha256').update('fixture').digest('hex').slice(0, 24)}`;
const requests = [];
const dispatches = [];
const decision = process.argv.includes('--decline') ? 'decline' : 'accept';
const cancelled = process.argv.includes('--cancel');
const cancelledInFlight = process.argv.includes('--cancel-in-flight');
const crashAfterInjection = process.argv.includes('--crash-after-injection');
let injected;
const injectionReached = new Promise(resolve => {injected = resolve;});
const crashPhase = process.argv.includes('--crash-after-result') ? 'completed' : process.argv.includes('--crash-before-dispatch') ? 'dispatching' : '';
let resuming = false;
const children = [];
const mock = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  if (crashAfterInjection && requests.length === 2) {injected(); return;}
  const id = `response_${requests.length}`;
  const item = !resuming
    ? {type: 'function_call', id: 'fc_fixture', call_id: 'fixture_call', namespace, name: 'echo', arguments: '{"text":"hello"}', status: 'completed'}
    : {type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{type: 'output_text', text: 'Review handled.', annotations: []}]};
  response.writeHead(200, {'Content-Type': 'text/event-stream'});
  const event = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({type, ...payload})}\n\n`);
  event('response.created', {response: {id, object: 'response', status: 'in_progress', output: []}});
  event('response.output_item.added', {output_index: 0, item});
  event('response.output_item.done', {output_index: 0, item});
  event('response.completed', {response: {id, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}});
  response.end();
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
function launch(mode, expected) {
  const child = fork(fileURLToPath(import.meta.url), [mode], {silent: true, env: {...process.env, MCP_REVIEW_FIXTURE: directory,
    MCP_REVIEW_DECISION: decision, MCP_REVIEW_CRASH_PHASE: crashPhase, MCP_REVIEW_CANCEL_IN_FLIGHT: cancelledInFlight ? '1' : '0'}});
  children.push(child);
  let stderr = '';
  child.stderr.on('data', chunk => {stderr += chunk;});
  return {child, ready: new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}: ${stderr}`)), 45000);
    child.on('message', message => {
      if (message.type === 'dispatch') dispatches.push(message);
      if (message.type === expected) {clearTimeout(timer); resolve(message);}
    });
    child.on('exit', code => {clearTimeout(timer); if (code) reject(new Error(`Worker exited: ${stderr}`));});
  })};
}
try {
  await writeFile(join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local MCP fixture"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const first = launch('--review-worker', 'review');
  await first.ready;
  assert.equal(dispatches.length, 0);
  const exited = new Promise(resolve => first.child.once('exit', resolve));
  first.child.kill('SIGKILL'); await exited;
  resuming = true;
  const second = launch(cancelled ? '--cancel-worker' : '--resume-worker', crashPhase ? 'persisted' : 'completed');
  if (crashAfterInjection) {
    void second.ready.catch(() => {});
    await injectionReached;
    const exited = new Promise(resolve => second.child.once('exit', resolve));
    second.child.kill('SIGKILL'); await exited;
    await launch('--recover-worker', 'completed').ready;
  } else await second.ready;
  if (crashPhase) {
    const exited = new Promise(resolve => second.child.once('exit', resolve));
    second.child.kill('SIGKILL'); await exited;
    await launch('--recover-worker', 'completed').ready;
  }
  const unknown = crashPhase === 'dispatching';
  assert.equal(dispatches.length, decision === 'accept' && !unknown && !cancelled ? 1 : 0);
  assert.equal(requests.length, unknown || cancelled || cancelledInFlight ? 1 : crashAfterInjection ? 3 : 2);
  if (crashAfterInjection) assert.equal(requests.at(-1).input.filter(item => item.type === 'function_call_output' && item.call_id.startsWith('reviewed_')).length, 1);
  if (!unknown && !cancelled && !cancelledInFlight) assert.equal(requests[1].input.some(item => item.type === 'function_call_output' && item.call_id.startsWith('reviewed_') && JSON.stringify(item.output).includes('hello')), decision === 'accept');
  console.log(JSON.stringify({status: cancelled || cancelledInFlight ? 'cancelled' : unknown ? 'unknown_without_retry' : 'completed', decision, crash_phase: crashAfterInjection ? 'native_injection' : crashPhase || 'waiting',
    process_restart: true, tool_dispatches: dispatches.length, model_requests: requests.length}));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await rm(directory, {recursive: true, force: true});
}
