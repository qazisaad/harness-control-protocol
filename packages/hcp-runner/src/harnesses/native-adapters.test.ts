import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type {
  Query,
  SDKMessage,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  HcpSessionEventReducer,
  hcpHarnessEventPayloadSchema,
  type HcpSessionStartPayload,
} from "@harness-control/protocol";
import {
  CodexHarnessAdapter,
  ClaudeHarnessAdapter,
  HarnessAdapterError,
  type HarnessAdapterEvent,
} from "./adapters.js";
import type { ProviderInstanceConfig } from "../config/index.js";
import type { ClaudeQueryFactory } from "./adapters/providers/claude-runtime.js";

function provider(driver: string, executable?: string): ProviderInstanceConfig {
  return {
    id: driver,
    driver_kind: driver,
    enabled: true,
    launch_args: [],
    env: {},
    models: [],
    hidden_models: [],
    model_order: [],
    favorite_models: [],
    local_capabilities: [],
    ...(executable ? { executable_path: executable } : {}),
  };
}
function start(driver: string, cwd: string): HcpSessionStartPayload {
  return {
    session_id: "session",
    workspace_id: "workspace",
    provider_instance_id: driver,
    driver_kind: driver,
    cwd,
    sandbox_mode:
      driver === "claude" ? "danger_full_access" : "workspace_write",
    approval_policy: "full_access",
    continue_session: false,
    model_selection: { model: "test-model" },
    mcp_servers: [],
  };
}
function turn(
  payload: HcpSessionStartPayload,
  selected: ProviderInstanceConfig,
  emitEvent?: (event: HarnessAdapterEvent) => void,
) {
  return {
    payload: {
      session_id: payload.session_id,
      turn_id: "turn",
      input: "hello",
    },
    startPayload: payload,
    provider: selected,
    session: { adapter_session_id: payload.session_id },
    ...(emitEvent ? { emitEvent } : {}),
  };
}
function verifyTranscript(events: HarnessAdapterEvent[]): void {
  const reducer = new HcpSessionEventReducer();
  for (const [index, event] of events.entries()) {
    const payload = {
      ...event,
      session_id: "session",
      sequence: index + 1,
      created_at: new Date().toISOString(),
    };
    hcpHarnessEventPayloadSchema.parse(payload);
    assert.equal(reducer.applyEvent(payload).outcome, "applied");
    assert.equal(reducer.applyEvent(payload).outcome, "duplicate");
  }
  assert.equal(
    events.filter((event) =>
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(
        event.event_type,
      ),
    ).length,
    1,
  );
}
const fixture = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
if (process.argv.includes('login')) process.exit(0);
const send = (x) => process.stdout.write(JSON.stringify(x)+'\n');
const notify = (method, params) => send({method,params});
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if (!m.id) return;
 fs.appendFileSync(process.env.RECORD,JSON.stringify(m)+'\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='config/read') send({id:m.id,result:{config:{mcp_servers:{inherited:{url:'http://localhost:1',enabled:true}}}}});
 if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:[{name:'inherited',runtimeStatus:process.env.MODE==='mcp-leak'?'connected':'disabled',tools:{}}],nextCursor:null}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'native-thread'},sandbox:{type:process.env.MODE==='policy'?'dangerFullAccess':'workspaceWrite',writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true},approvalPolicy:'never'}});
 if(m.method==='turn/start') {
  const params={threadId:'native-thread',turnId:'native-turn'};
  notify('turn/started',{threadId:'native-thread',turn:{id:'native-turn'}});
  send({id:m.id,result:{turn:{id:'native-turn'}}});
  if(process.env.MODE==='exit') return process.exit(0);
  if(process.env.MODE==='request') return send({id:'approval-1',method:'item/commandExecution/requestApproval',params});
  if(process.env.MODE==='malformed') return process.stdout.write('not json\n');
  const delta=JSON.stringify({method:'item/agentMessage/delta',params:{...params,delta:'🙂hello'}})+'\n';
  const bytes=Buffer.from(delta); const i=bytes.indexOf(Buffer.from('🙂'))+1;
  process.stdout.write(bytes.subarray(0,i));
  setTimeout(()=>{process.stdout.write(bytes.subarray(i));
   if(process.env.MODE==='sleep') return;
   setTimeout(()=>{
    notify('item/completed',{...params,item:{id:'message',type:'agentMessage',phase:'final_answer',text:'x'.repeat(80000)}});
    notify('turn/completed',{threadId:'native-thread',turn:{id:'native-turn',status:process.env.MODE==='failed'?'failed':'completed',error:null}});
   },30);
  },5);
 }
});
`;

for (const mode of [
  "success",
  "exit",
  "failed",
  "malformed",
  "request",
  "policy",
  "mcp-leak",
  "sleep",
]) {
  it(`Codex app-server ${mode} through real stdio and production reducer`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hcp-native-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "codex.cjs");
    const record = join(root, "requests.jsonl");
    await writeFile(executable, fixture);
    await chmod(executable, 0o755);
    const selected = provider("codex", executable);
    selected.env = { MODE: mode, RECORD: record };
    const payload = start("codex", root);
    payload.model_selection.options = [
      { id: "reasoningEffort", value: "high" },
    ];
    const adapter = new CodexHarnessAdapter({
      turnTimeoutMs: mode === "sleep" ? 1500 : 5000,
    });
    const events: HarnessAdapterEvent[] = [];
    let running = true;
    const terminal = await adapter.sendTurn(
      turn(payload, selected, (event) => {
        assert.equal(running, true);
        events.push(event);
      }),
    );
    running = false;
    events.push(...terminal);
    assert.equal(
      events.at(-1)?.event_type,
      mode === "success" ? "turn.completed" : "turn.failed",
    );
    if (mode === "success") {
      assert.equal(
        events.find((e) => e.event_type === "content.delta")?.data.delta,
        "🙂hello",
      );
      assert.equal(
        (events.at(-1)?.data.final_output as { final_text: string }).final_text
          .length,
        80000,
      );
    }
    verifyTranscript(events);
    const requests = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: Record<string, unknown>;
          },
      );
    const configuration = requests.find((r) => r.method === "thread/start")
      ?.params.config as { mcp_servers: { inherited: { enabled: boolean } } };
    assert.equal(configuration.mcp_servers.inherited.enabled, false);
    if (mode !== "policy" && mode !== "mcp-leak")
      assert.equal(
        requests.find((r) => r.method === "turn/start")?.params.effort,
        "high",
      );
    else
      assert.equal(
        requests.some((r) => r.method === "turn/start"),
        false,
      );
  });
}

function fakeQuery(
  messages: unknown[],
  inspect: (options: Options) => void = () => {},
): ClaudeQueryFactory {
  return ({ options }) => {
    inspect(options!);
    const stream = (async function* () {
      for (const message of messages) yield message as SDKMessage;
    })();
    return Object.assign(stream, { close() {} }) as Query;
  };
}
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "x".repeat(80000),
  terminal_reason: "completed",
  stop_reason: "end_turn",
};
for (const [label, result] of Object.entries({
  success,
  overloaded: { ...success, api_error_status: 529 },
  budget: { ...success, terminal_reason: "budget_exhausted" },
  missingText: { ...success, result: undefined },
  failure: { ...success, subtype: "error_during_execution" },
  tokenLimit: { ...success, stop_reason: "max_tokens" },
})) {
  it(`Claude SDK ${label} is classified truthfully`, async () => {
    const delta = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    };
    const adapter = new ClaudeHarnessAdapter({
      queryFactory: fakeQuery([delta, result], (options) => {
        assert.equal(options.strictMcpConfig, true);
        assert.deepEqual(options.mcpServers, {});
        assert.deepEqual(options.settingSources, []);
        assert.equal(options.includePartialMessages, true);
        assert.equal(options.effort, "high");
        assert.equal(options.persistSession, false);
      }),
    });
    const payload = start("claude", tmpdir());
    payload.model_selection.options = [{ id: "effort", value: "high" }];
    const events: HarnessAdapterEvent[] = [];
    events.push(
      ...(await adapter.sendTurn(
        turn(payload, provider("claude"), (event) => events.push(event)),
      )),
    );
    assert.equal(events[0]?.event_type, "content.delta");
    assert.equal(
      events.at(-1)?.event_type,
      label === "success" ? "turn.completed" : "turn.failed",
    );
    verifyTranscript(events);
  });
}

it("Claude EOF without result is a failure", async () => {
  const adapter = new ClaudeHarnessAdapter({ queryFactory: fakeQuery([]) });
  const events = await adapter.sendTurn(
    turn(start("claude", tmpdir()), provider("claude")),
  );
  assert.equal(events.at(-1)?.event_type, "turn.failed");
  verifyTranscript(events);
});

for (const driver of ["codex", "claude"]) {
  it(`${driver} rejects unsupported policy, continuation and options before provider execution`, async () => {
    const adapter =
      driver === "codex"
        ? new CodexHarnessAdapter()
        : new ClaudeHarnessAdapter();
    for (const changes of [
      { continue_session: true },
      { approval_policy: "ask" as const },
      {
        model_selection: {
          model: "test",
          options: [{ id: "unknown", value: true }],
        },
      },
    ]) {
      await assert.rejects(
        adapter.startSession({
          payload: { ...start(driver, tmpdir()), ...changes },
          provider: provider(driver),
        }),
        HarnessAdapterError,
      );
    }
    await assert.rejects(
      adapter.startSession({
        payload: start(driver, tmpdir()),
        provider: { ...provider(driver), launch_args: ["--unsafe"] },
      }),
      HarnessAdapterError,
    );
    if (driver === "claude")
      await assert.rejects(
        adapter.startSession({
          payload: {
            ...start(driver, tmpdir()),
            sandbox_mode: "workspace_write",
          },
          provider: provider(driver),
        }),
        HarnessAdapterError,
      );
  });
}

it("cancellation emits one terminal only after Codex child closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hcp-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex.cjs");
  await writeFile(executable, fixture);
  await chmod(executable, 0o755);
  const selected = provider("codex", executable);
  selected.env = { MODE: "sleep", RECORD: join(root, "requests") };
  const adapter = new CodexHarnessAdapter();
  const events: HarnessAdapterEvent[] = [];
  let ready!: () => void;
  const streamed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = adapter.sendTurn(
    turn(start("codex", root), selected, (event) => {
      events.push(event);
      ready();
    }),
  );
  await streamed;
  assert.deepEqual(
    await adapter.cancelTurn({ sessionId: "session", turnId: "turn" }),
    [],
  );
  events.push(...(await pending));
  assert.equal(events.at(-1)?.event_type, "turn.cancelled");
  verifyTranscript(events);
  assert.deepEqual(await adapter.stopSession({ sessionId: "session" }), []);
});

it("immediate cancellation prevents Claude startup and publishes its terminal before cancel resolves", async () => {
  let spawned = false;
  const adapter = new ClaudeHarnessAdapter({
    queryFactory: fakeQuery([], () => {
      spawned = true;
    }),
  });
  const events: HarnessAdapterEvent[] = [];
  const pending = adapter.sendTurn(
    turn(start("claude", tmpdir()), provider("claude"), (event) =>
      events.push(event),
    ),
  );
  await adapter.cancelTurn({ sessionId: "session", turnId: "turn" });
  assert.equal(spawned, false);
  assert.equal(events.at(-1)?.event_type, "turn.cancelled");
  assert.deepEqual(await pending, []);
  verifyTranscript(events);
});

it("Claude cancellation waits for a real child that ignores SIGTERM", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let pid: number | undefined;
  const factory: ClaudeQueryFactory = ({ options }) => {
    const child = options!.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      cwd: tmpdir(),
      env: process.env as Record<string, string>,
      signal: new AbortController().signal,
    });
    pid = (child as import("node:child_process").ChildProcess).pid;
    child.stdout.once("data", ready);
    const closed = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    const stream = (async function* () {
      await closed;
    })() as AsyncGenerator<SDKMessage>;
    return Object.assign(stream, { close() {} }) as Query;
  };
  const adapter = new ClaudeHarnessAdapter({ queryFactory: factory });
  const events: HarnessAdapterEvent[] = [];
  const pending = adapter.sendTurn(
    turn(start("claude", tmpdir()), provider("claude"), (event) =>
      events.push(event),
    ),
  );
  await started;
  await adapter.stopSession({ sessionId: "session" });
  await pending;
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  assert.equal(events.at(-1)?.event_type, "turn.cancelled");
  verifyTranscript(events);
});

it("native probes advertise the same execution policies enforced at session start", async () => {
  for (const driver of ["codex", "claude"] as const) {
    const processSpawner: import("./adapters.js").CliProcessSpawner = (
      _executable,
      args,
    ) => ({
      result: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: args.includes("status")
          ? '{"loggedIn":true}'
          : "fixture-version",
        stderr: "",
        error: undefined,
        timedOut: false,
      }),
      kill() {},
    });
    const adapter =
      driver === "codex"
        ? new CodexHarnessAdapter({ processSpawner })
        : new ClaudeHarnessAdapter({ processSpawner });
    const selected = provider(driver);
    selected.models = [
      { id: "test", label: "Test", capabilities: { option_descriptors: [] } },
    ];
    const status = await adapter.probe(selected);
    assert.equal(status.available, true);
    assert.deepEqual(status.execution_capabilities?.approval_policies, [
      "full_access",
    ]);
    assert.deepEqual(
      status.execution_capabilities?.sandbox_modes,
      driver === "codex"
        ? ["read_only", "workspace_write", "danger_full_access"]
        : ["danger_full_access"],
    );
    assert.equal(status.execution_capabilities?.session_continuation, false);
  }
});

it("a second turn cannot silently start a fresh Claude conversation", async () => {
  let calls = 0;
  const adapter = new ClaudeHarnessAdapter({
    queryFactory: fakeQuery([success], () => {
      calls++;
    }),
  });
  const input = turn(start("claude", tmpdir()), provider("claude"));
  await adapter.sendTurn(input);
  await assert.rejects(
    adapter.sendTurn({
      ...input,
      payload: { ...input.payload, turn_id: "second" },
    }),
    (error: unknown) =>
      error instanceof HarnessAdapterError &&
      error.code === "session_turn_limit",
  );
  assert.equal(calls, 1);
  await adapter.stopSession({ sessionId: "session" });
});
