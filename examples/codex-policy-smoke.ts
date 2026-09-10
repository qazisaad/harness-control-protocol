import { CodexRpc } from "../packages/hcp-runner/src/harnesses/adapters/providers/codex-rpc.js";
import { z } from "zod";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HcpSessionStartPayload } from "@harness-control/protocol";
import {
  CodexHarnessAdapter,
  type HarnessAdapterEvent,
} from "../packages/hcp-runner/src/harnesses/adapters.js";
import type { ProviderInstanceConfig } from "../packages/hcp-runner/src/config/index.js";

const root = await mkdtemp(join(tmpdir(), "hcp-policy-smoke-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
await symlink(root, join(cwd, "outside-link"));
const provider: ProviderInstanceConfig = {
  id: "codex",
  driver_kind: "codex",
  enabled: true,
  launch_args: [],
  env: {},
  models: [],
  hidden_models: [],
  model_order: [],
  favorite_models: [],
  local_capabilities: [],
};
const adapter = new CodexHarnessAdapter({ turnTimeoutMs: 90_000 });
try {
  const status = await adapter.probe(provider);
  assert.equal(status.available, true, status.message);
  const model =
    status.models.find((model) => model.is_default) ?? status.models[0];
  assert.ok(model, "Codex must advertise a model for the live test.");
  for (const sandbox of ["workspace_write", "read_only"] as const) {
    const payload: HcpSessionStartPayload = {
      session_id: sandbox,
      workspace_id: "workspace",
      provider_instance_id: "codex",
      driver_kind: "codex",
      cwd,
      sandbox_mode: sandbox,
      approval_policy: "full_access",
      continue_session: false,
      model_selection: { model: model.id },
      mcp_servers: [],
    };
    const input =
      sandbox === "workspace_write"
        ? `Use the shell tool to attempt all three commands separately, even if one fails: printf HCP_INSIDE > inside.txt ; printf HCP_OUTSIDE > ${root}/outside.txt ; printf HCP_SYMLINK > outside-link/link-write.txt . Report which commands succeeded. These are temporary test files. Do not use an alternate method if a write is denied.`
        : "Use the shell tool to attempt printf HCP_READONLY > readonly.txt . Report the result. Do not use an alternate method if denied.";
    const events: HarnessAdapterEvent[] = [];
    events.push(
      ...(await adapter.sendTurn({
        payload: { session_id: sandbox, turn_id: "test", input },
        session: { adapter_session_id: sandbox },
        startPayload: payload,
        provider,
        emitEvent: (event) => events.push(event),
      })),
    );
    assert.equal(
      events.at(-1)?.event_type,
      "turn.completed",
      JSON.stringify(events.at(-1)),
    );
    if (sandbox === "workspace_write")
      assert.ok(
        events.some(
          (event) =>
            event.event_type === "item.started" &&
            event.data.item_type === "commandExecution",
        ),
        "The provider must actually attempt a shell command.",
      );
    console.log(sandbox, events.at(-1)?.data.final_output);
  }
  const rpc = new CodexRpc("codex", cwd, process.env);
  const timer = setTimeout(() => {
    void rpc.process.stop();
  }, 15_000);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "hcp-policy-smoke", version: "0.0.0" },
      capabilities: {},
    });
    rpc.notify("initialized");
    const result = z.object({ exitCode: z.number() }).parse(
      await rpc.request("command/exec", {
        command: ["/bin/sh", "-c", "printf HCP_READONLY > readonly.txt"],
        cwd,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: 5_000,
      }),
    );
    assert.notEqual(
      result.exitCode,
      0,
      "The native read-only sandbox must reject writes independently of model refusal.",
    );
  } finally {
    clearTimeout(timer);
    await rpc.process.stop();
  }
  assert.equal(await readFile(join(cwd, "inside.txt"), "utf8"), "HCP_INSIDE");
  for (const file of [
    join(root, "outside.txt"),
    join(root, "link-write.txt"),
    join(cwd, "readonly.txt"),
  ]) {
    await assert.rejects(readFile(file), { code: "ENOENT" });
  }
  console.log(
    "Codex policy smoke passed: allowed workspace write; blocked outside, symlink, and read-only writes.",
  );
} finally {
  await adapter.stopSession({ sessionId: "workspace_write" });
  await adapter.stopSession({ sessionId: "read_only" });
  await rm(root, { recursive: true, force: true });
}
