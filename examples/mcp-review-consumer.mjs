import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessSessionManager, HarnessAdapterRegistry } from '@harness-control/runner/harnesses';
import { JsonRunnerStateStore } from '@harness-control/runner/state';
import { mcpReviewGrantSchema, hashMcpReviewAction } from '@harness-control/protocol';

// A separate control-plane consumer using only published HCP entry points.
const root = await mkdtemp(join(tmpdir(), 'hcp-review-consumer-'));
const path = join(root, 'state.json');
const interrupted = new AbortController();
let requestReady;
const requested = new Promise(resolve => {requestReady = resolve;});
let calls = 0;
const events = [];
const adapter = {
  driverKind: 'example.echo', durableMcpContinuation: true,
  async probe() {throw new Error('Not required by this example');},
  async validateStart() {}, async startSession(input) {return {adapter_session_id: input.payload.session_id};},
  async sendTurn(input) {
    if (input.mcpContinuation) {
      assert.deepEqual(input.mcpContinuation.outcome, {kind: 'completed', result: {is_error: false, structured_content: {done: true}}});
      return [{event_type: 'turn.completed', data: {status: 'completed', final_output: {final_text: 'Approved operation completed'}}}];
    }
    await input.reviewMcpTool.request({attachment_name: 'tools', tool_name: 'write', arguments: {text: 'hello'},
      native_thread_id: 'echo-thread', native_turn_id: 'echo-turn', native_call_id: 'echo-call'}, interrupted.signal);
    throw new Error('The original adapter must remain interrupted');
  },
  async cancelTurn() {return [];}, async stopSession() {return [];},
};
const config = {runner_id: 'example', host_id: 'example', control_plane_url: 'ws://localhost:1',
  workspaces: [{id: 'workspace', path: root}], mcp_stdio_profiles: [], local_capabilities: [],
  provider_instances: [{id: 'echo', driver_kind: adapter.driverKind, enabled: true, env: {}, launch_args: [],
    local_capabilities: [], hidden_models: [], model_order: [], favorite_models: [],
    models: [{id: 'echo', label: 'Echo', capabilities: {option_descriptors: []}}]}]};
const options = () => ({stateStore: new JsonRunnerStateStore(path), adapterRegistry: new HarnessAdapterRegistry([adapter]),
  mcpClientFactory: () => ({async connect() {}, async close() {}, async listTools() {
    return [{name: 'write', input_schema: {type: 'object'}, review_policy: {kind: 'always'}}];
  }, async callTool(name, args, rawGrant) {
    calls++;
    const grant = mcpReviewGrantSchema.parse(rawGrant);
    assert.equal(name, 'write'); assert.deepEqual(args, {text: 'hello'});
    assert.equal(await hashMcpReviewAction(grant.action_json), review.action_hash);
    return {is_error: false, structured_content: {done: true}};
  }})});
let review;
let recovered;
try {
  const manager = new HarnessSessionManager(config, options());
  await manager.startSession({session_id: 'session', workspace_id: 'workspace', provider_instance_id: 'echo', driver_kind: adapter.driverKind,
    cwd: root, sandbox_mode: 'read_only', approval_policy: 'full_access', continue_session: false, model_selection: {model: 'echo'},
    mcp_servers: [{name: 'tools', transport: 'streamable_http', url: 'https://example.invalid/mcp', headers: {}, lease_id: 'lease',
      expires_at: new Date(Date.now() + 60000).toISOString(), proof_of_possession: {scheme: 'runner_signed_request', key_id: 'key', required_headers: ['x-hcp-proof-signature']}}]});
  const running = manager.sendTurn({session_id: 'session', turn_id: 'turn', input: 'Write hello'}, event => {
    if (event.event_type === 'approval.requested') {review = event.data; requestReady();}
  });
  const stopped = assert.rejects(running, /interrupted/);
  await requested;
  interrupted.abort();
  await stopped;
  assert.equal(calls, 0);
  recovered = new HarnessSessionManager(config, options());
  await recovered.recoverMcpReviews(event => events.push(event), () => assert.fail('Waiting review must not dispatch'));
  const resumed = await recovered.respondToMcpReview({session_id: 'session', turn_id: 'turn', request_id: review.request_id,
    action_hash: review.action_hash, actor_id: 'example-user', decision: 'accept'}, event => events.push(event));
  assert.equal(resumed.kind, 'resumed');
  await resumed.completion;
  assert.equal(calls, 1);
  assert.equal(events.filter(event => event.event_type === 'turn.completed').length, 1);
  assert.equal(new JsonRunnerStateStore(path).getMcpReview('session'), undefined);
  console.log('Public HCP consumer: approval, reload, resume and terminal cleanup passed for a non-Codex adapter.');
} finally {
  if (recovered) await recovered.stopSession('session', 'example complete');
  await rm(root, {recursive: true, force: true});
}
