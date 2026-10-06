import assert from "node:assert/strict";
import {test} from "node:test";
import type {Query, SDKMessage, Options} from "@anthropic-ai/claude-agent-sdk";
import {PersistentClaudeSession} from "./claude-session.js";
import type {HarnessAdapterStartInput} from "../types.js";
import {RunnerConfigSchema} from "../../../config/index.js";

for (const scenario of ["confirmed", "foreign-session", "wrong-mode", "lost-control"] as const)
test(`Claude idle replacement requires observed native policy without a user prompt (${scenario})`, async () => {
  const messages: SDKMessage[] = [], controls: string[] = [];
  let wake: (() => void) | undefined, closed = false, promptCount = 0;
  const output = async function* () {
    while (!closed) {
      const message = messages.shift();
      if (message) yield message;
      else await new Promise<void>(resolve => {wake = resolve;});
    }
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: process.cwd()}], provider_instances: [{id: "claude", driver_kind: "claude"}]});
  const start: HarnessAdapterStartInput = {provider: config.provider_instances[0]!,
    payload: {session_id: "target", workspace_id: "workspace", cwd: process.cwd(), provider_instance_id: "claude", driver_kind: "claude",
      model_selection: {model: "sonnet"}, approval_policy: "ask", sandbox_mode: "danger_full_access", execution_profile: "interactive",
      continue_session: true, continuation_group_key: "conversation", mcp_servers: []},
    nativeConversation: {native_thread_id: "native", binding_hash: "a".repeat(64), updated_at: new Date().toISOString(),
      last_session_id: "source", provider_instance_id: "claude", provider_binding_hash: "b".repeat(64), workspace_id: "workspace", cwd: process.cwd()},
    emitSessionEvent() {}, registerSessionInteractions() {}};
  const runtime = new PersistentClaudeSession(start, ({prompt}) => {
    void (async () => {for await (const _message of prompt) promptCount++;})();
    return Object.assign(output(), {
      async initializationResult() {return {};},
      async setPermissionMode(mode: NonNullable<Options["permissionMode"]>) {
        controls.push(mode);
        if (scenario === "lost-control") throw new Error("Native acknowledgement lost");
        messages.push({type: "system", subtype: "status", status: null, uuid: "00000000-0000-4000-8000-000000000001",
          session_id: scenario === "foreign-session" ? "foreign" : "native",
          permissionMode: scenario === "wrong-mode" ? "bypassPermissions" : mode});
        wake?.(); wake = undefined;
      },
      close() {closed = true; wake?.();},
    }) as unknown as Query;
  });
  try {
    if (scenario === "confirmed") {
      assert.deepEqual(await runtime.confirmIdlePolicy(), {source: "native", execution_profile: "interactive",
        approval_policy: "ask", sandbox_mode: "danger_full_access"});
      assert.deepEqual(controls, ["acceptEdits", "default"]);
    } else await assert.rejects(runtime.confirmIdlePolicy());
    assert.equal(promptCount, 0);
  } finally {await runtime.stop();}
});
