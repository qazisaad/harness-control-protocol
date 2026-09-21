import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessSessionManager, HarnessAdapterRegistry} from '@harness-control/runner/harnesses';
import {JsonRunnerStateStore} from '@harness-control/runner/state';

const root = await mkdtemp(join(tmpdir(), 'hcp-startup-cleanup-'));
try {
  for (const failure of ['none', 'client', 'adapter', 'both']) {
    const calls = [];
    const original = new Error('adapter initialization failed');
    const adapter = {
      driverKind: 'example.failed-start',
      async probe() {throw new Error('Not needed');},
      async validateStart() {},
      async startSession() {calls.push('start'); throw original;},
      async sendTurn() {return [];},
      async cancelTurn() {return [];},
      async stopSession() {
        calls.push('stop');
        if (failure === 'adapter' || failure === 'both') throw new Error('stop failed');
        return [];
      },
    };
    const config = {runner_id: 'cleanup-consumer', host_id: 'cleanup-consumer', control_plane_url: 'ws://localhost:1',
      workspaces: [{id: 'workspace', path: root}], mcp_stdio_profiles: [], local_capabilities: [],
      provider_instances: [{id: 'test', driver_kind: adapter.driverKind, enabled: true, env: {}, launch_args: [],
        local_capabilities: [], hidden_models: [], model_order: [], favorite_models: [],
        models: [{id: 'test', label: 'Test', capabilities: {option_descriptors: []}}]}]};
    const statePath = join(root, `${failure}.json`);
    const options = {stateStore: new JsonRunnerStateStore(statePath), adapterRegistry: new HarnessAdapterRegistry([adapter]),
      mcpClientFactory: () => ({async connect() {calls.push('connect');}, async close() {
        calls.push('close');
        if (failure === 'client' || failure === 'both') throw new Error('close failed');
      }})};
    const manager = new HarnessSessionManager(config, options);
    await assert.rejects(manager.startSession({session_id: failure, workspace_id: 'workspace', provider_instance_id: 'test',
      driver_kind: adapter.driverKind, cwd: root, sandbox_mode: 'read_only', approval_policy: 'full_access',
      continue_session: false, model_selection: {model: 'test'},
      mcp_servers: [{name: 'tools', transport: 'streamable_http', url: 'https://example.invalid/mcp', headers: {}, lease_id: 'lease',
        proof_of_possession: {scheme: 'runner_signed_request', key_id: 'key', required_headers: ['x-hcp-proof-signature']}}]}),
      error => failure === 'none' ? error === original : error.code === 'adapter_start_cleanup_failed');
    assert.deepEqual(calls, ['connect', 'start', 'close', 'stop']);
    const restored = new HarnessSessionManager(config, {...options, stateStore: new JsonRunnerStateStore(statePath)});
    const replay = restored.replayEventsAfter({sessions: [{session_id: failure, last_event_sequence: 0}]});
    assert.deepEqual(replay.events.map(event => event.event_type), failure === 'none' ? ['session.exited'] : []);
  }
  console.log('Released HCP startup cleanup: all four closure outcomes and durable replay passed.');
} finally {await rm(root, {recursive: true, force: true});}
