import { z } from "zod";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  HarnessTurnFinalOutput,
  HarnessUsageSnapshot,
} from "@harness-control/protocol";
import { HarnessAdapterError } from "../types.js";
import { adapterMcpServers } from "./shared.js";
import { selectedEffort, type NativeTurn } from "./native-turn.js";
import { CodexRpc } from "./codex-rpc.js";
import { NativeMcpBridge } from "./native-mcp.js";
import { recordMcpContinuation } from "./mcp-continuation.js";
import { NativeInteractions } from "../../native-interactions.js";
import { CodexProcessPool } from "./codex-pool.js";

export function createCodexTurnRuntime(onProcessLease?: (reused: boolean) => void) {
  type Launch = {executable: string; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal};
  const createRuntime = async (launch: Launch) => {
    const rpc = new CodexRpc(launch.executable, launch.cwd, launch.env);
    const abort = () => {void rpc.process.stop();};
    launch.signal.addEventListener("abort", abort, {once: true});
    if (launch.signal.aborted) abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([rpc.request("initialize", {clientInfo: {name: "hcp-runner", version: "0.0.0"}, capabilities: {experimentalApi: true}}),
        new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("Codex initialization timed out")), 5_000);})]);
      rpc.notify("initialized");
      return rpc;
    } catch (error) {await rpc.process.stop(); throw error;}
    finally {clearTimeout(timer); launch.signal.removeEventListener("abort", abort);}
  };
  const pool = new CodexProcessPool<CodexRpc>(async () => {throw new Error("Codex runtime requires invocation-scoped launch settings");});
  const run: NativeTurn = async (input, signal, emit) => {
    const env = {...process.env, ...input.provider.env, ...(input.provider.home ? {CODEX_HOME: input.provider.home} : {})};
    const key = createHash("sha256").update(JSON.stringify({provider: input.provider,
      workspace: input.startPayload.workspace_id, cwd: await realpath(input.startPayload.cwd),
      sandbox: input.startPayload.sandbox_mode, approval: input.startPayload.approval_policy,
      attachments: input.startPayload.mcp_servers, env})).digest("hex");
    const create = () => createRuntime({executable: input.provider.executable_path ?? "codex", cwd: input.startPayload.cwd, env, signal});
    return await runCodexTurn(input, signal, emit, pool, key, create, onProcessLease);

  };
  return {run, close: () => pool.close()};
}

const object = z.record(z.string(), z.unknown());
const idObject = z.object({ id: z.string() });
const startedSchema = z.object({
  thread: idObject,
  sandbox: z.object({
    type: z.string(),
    writableRoots: z.array(z.string()).optional(),
    excludeTmpdirEnvVar: z.boolean().optional(),
    excludeSlashTmp: z.boolean().optional(),
  }),
  approvalPolicy: z.string(),
});
const deltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  delta: z.string(),
});
const itemSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
    phase: z.string().nullable().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    status: z.string().optional(),
    aggregatedOutput: z.string().nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().nonnegative().nullable().optional(),
    changes: z.array(z.json()).optional(),
  }),
});
const terminalSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.unknown().nullable().optional(),
  }),
});

const runCodexTurn = async (input: Parameters<NativeTurn>[0], signal: AbortSignal,
  emit: Parameters<NativeTurn>[2], pool: CodexProcessPool<CodexRpc>, key: string, create: () => Promise<CodexRpc>,
  onProcessLease?: (reused: boolean) => void): ReturnType<NativeTurn> => {
  let interactions: NativeInteractions | undefined;
  signal.throwIfAborted();
  const selection =
    input.payload.model_selection ?? input.startPayload.model_selection;
  const effort = selectedEffort(selection, "codex");
  const lease = await pool.acquire(key, create);
  const rpc = lease.runtime;
  let reusable = false;
  let cleanupThreadId: string | undefined;
  const abort = (): void => {
    void rpc.process.stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    onProcessLease?.(lease.reused);
    signal.throwIfAborted();
    const configResult = z.object({ config: object }).parse(
      await rpc.request("config/read", {
        cwd: input.startPayload.cwd,
        includeLayers: false,
      }),
    );
    const inherited = object.parse(configResult.config.mcp_servers ?? {});
    const inheritedPlugins = object.parse(configResult.config.plugins ?? {});
    const servers: Record<string, unknown> = {};
    for (const name of Object.keys(inherited))
      servers[name] = { enabled: false };
    const attachments = adapterMcpServers(input.mcpServers, input.startPayload);
    const toolsets = input.mcpToolsets ?? [];
    if (attachments.length !== toolsets.length ||
        attachments.some(attachment => !toolsets.some(toolset => toolset.name === attachment.name))) {
      throw new HarnessAdapterError("mcp_bridge_missing", "Codex requires the authorized runner tool bridge for every selected MCP attachment.");
    }
    const bridge = new NativeMcpBridge(toolsets, input.reviewMcpTool);
    const sandbox = input.startPayload.sandbox_mode.replaceAll("_", "-");
    const approvalPolicy = {ask: "untrusted", auto_edits: "on-request", full_access: "never"}[input.startPayload.approval_policy];
    const resumeThread = input.mcpContinuation?.native_thread_id ?? input.session.native_thread_id;
    const started = startedSchema.parse(
      await rpc.request(resumeThread ? "thread/resume" : "thread/start", {
        ...(resumeThread ? {threadId: resumeThread} : {
          ephemeral: false,
          dynamicTools: bridge.definitions,
        }),
        cwd: input.startPayload.cwd,
        model: selection.model,
        sandbox,
        approvalPolicy,

        config: {
          mcp_servers: servers,
          plugins: Object.fromEntries(
            Object.keys(inheritedPlugins).map((name) => [name, { enabled: false }]),
          ),
          "features.apps": false,
          "features.multi_agent": false,
          "sandbox_workspace_write.writable_roots": [],
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      }),
    );
    const expectedSandbox = {
      read_only: "readOnly",
      workspace_write: "workspaceWrite",
      danger_full_access: "dangerFullAccess",
    }[input.startPayload.sandbox_mode];
    if (
      started.sandbox.type !== expectedSandbox ||
      started.approvalPolicy !== approvalPolicy
    ) {
      throw new HarnessAdapterError(
        "policy_mismatch",
        "Codex did not accept the requested execution policy.",
      );
    }
    if (started.sandbox.type === "workspaceWrite") {
      const cwd = await realpath(input.startPayload.cwd);
      const roots = await Promise.all(
        (started.sandbox.writableRoots ?? []).map((root) => realpath(root)),
      );
      if (
        started.sandbox.writableRoots === undefined ||
        roots.some((root) => root !== cwd) ||
        started.sandbox.excludeTmpdirEnvVar !== true ||
        started.sandbox.excludeSlashTmp !== true
      ) {
        throw new HarnessAdapterError(
          "policy_mismatch",
          "Codex granted writes beyond the requested workspace.",
        );
      }
    }
    const threadId = started.thread.id;
    cleanupThreadId = threadId;
    if (resumeThread && threadId !== resumeThread) {
      throw new HarnessAdapterError("mcp_continuation_thread_mismatch", "Codex resumed another MCP review thread.");
    }
    input.session.native_thread_id = threadId;
    input.persistNativeThread?.(threadId);
    if (input.persistNativeThread) emit({event_type: "session.configured", data: {native_conversation_ready: true}});
    let cursor: string | undefined;
    do {
      const inventory = z
        .object({
          data: z.array(
            z.object({
              name: z.string(),
              runtimeStatus: z.string().nullable().optional(),
              tools: object.optional(),
            }),
          ),
          nextCursor: z.string().nullable().optional(),
        })
        .parse(
          await rpc.request("mcpServerStatus/list", {
            threadId,
            ...(cursor ? { cursor } : {}),
          }),
        );
      if (
        inventory.data.some(
          (server) =>
            !(
              server.runtimeStatus === "disabled" &&
              Object.keys(server.tools ?? {}).length === 0
            ),
        )
      ) {
        throw new HarnessAdapterError(
          "mcp_scope_mismatch",
          "Codex exposed an MCP server outside the selected attachment scope.",
        );
      }
      cursor = inventory.nextCursor ?? undefined;
    } while (cursor);
    let nativeTurnId: string | undefined;
    interactions = new NativeInteractions(input.startPayload, input.payload, {threadId, turnId: () => nativeTurnId}, emit);
    input.registerNativeInteractions?.(interactions);
    rpc.setRequestHandler("item/commandExecution/requestApproval", (params, requestSignal) => interactions!.approval(params, "command", requestSignal));
    rpc.setRequestHandler("item/fileChange/requestApproval", (params, requestSignal) => interactions!.approval(params, "file_change", requestSignal));
    rpc.setRequestHandler("item/tool/requestUserInput", (params, requestSignal) => interactions!.questions(params, requestSignal));
    rpc.setRequestHandler("item/tool/call", async (params, requestSignal) => {
      if (!nativeTurnId) throw new HarnessAdapterError("codex_turn_missing", "Native tool calls require an active turn.");
      return bridge.call(params, {threadId, turnId: nativeTurnId}, requestSignal);
    });
    let finalText: string | undefined;
    let usage: HarnessUsageSnapshot | undefined;
    let settled = false;
    let resolve!: (output: HarnessTurnFinalOutput) => void;
    let reject!: (error: Error) => void;
    const terminal = new Promise<HarnessTurnFinalOutput>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Attach immediately: the server can emit a terminal event before turn/start replies.
    void terminal.catch(() => {});
    rpc.onFailure = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    rpc.onNotification = (message) => {
      if (settled) return;
      if (message.method === "turn/started") {
        const event = z
          .object({ threadId: z.string(), turn: idObject })
          .parse(message.params);
        if (event.threadId === threadId) nativeTurnId = event.turn.id;
      } else if (
        message.method === "item/agentMessage/delta" ||
        message.method === "item/reasoning/summaryTextDelta"
      ) {
        const event = deltaSchema.parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turnId !== nativeTurnId)
        )
          return;
        emit({
          event_type:
            message.method === "item/agentMessage/delta"
              ? "content.delta"
              : "reasoning.delta",
          turn_id: input.payload.turn_id,
          data: { delta: event.delta },
        });
      } else if (
        message.method === "item/started" ||
        message.method === "item/completed"
      ) {
        const event = itemSchema.parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turnId !== nativeTurnId)
        )
          return;
        if (event.item.type === "commandExecution") {
          emit({event_type: message.method === "item/started" ? "command.started" : "command.completed", turn_id: input.payload.turn_id,
            data: {command_id: event.item.id, ...(event.item.command !== undefined ? {command: event.item.command} : {}),
              ...(event.item.cwd ? {cwd: event.item.cwd} : {}), ...(event.item.status ? {status: event.item.status} : {}),
              ...(event.item.exitCode != null ? {exit_code: event.item.exitCode} : {}),
              ...(event.item.durationMs != null ? {duration_ms: event.item.durationMs} : {}),
              ...(event.item.aggregatedOutput != null ? {output: boundedContent(event.item.aggregatedOutput)} : {})}});
        }
        emit({
          event_type:
            message.method === "item/started"
              ? "item.started"
              : "item.completed",
          turn_id: input.payload.turn_id,
          data: {
            item_id: event.item.id,
            item_type: event.item.type === "fileChange" ? "file_change" : event.item.type,
            ...(event.item.text !== undefined
              ? { content: event.item.text }
              : event.item.type === "fileChange" ? {content: boundedContent({changes: event.item.changes ?? []})} : {}),
            ...(event.item.status ? {status: event.item.status} : {}),
          },
        });
        if (
          message.method === "item/completed" &&
          event.item.type === "agentMessage" &&
          event.item.phase !== "commentary"
        )
          finalText = event.item.text;
      } else if (message.method === "item/commandExecution/outputDelta") {
        const event = deltaSchema.extend({itemId: z.string()}).parse(message.params);
        if (event.threadId !== threadId || event.turnId !== nativeTurnId) return;
        emit({event_type: "item.updated", turn_id: input.payload.turn_id,
          data: {item_id: event.itemId, item_type: "commandExecution", content: {output_delta: boundedContent(event.delta)}}});
      } else if (message.method === "turn/plan/updated") {
        const event = z.object({threadId: z.string(), turnId: z.string(), plan: z.array(z.json()), explanation: z.string().nullish()}).parse(message.params);
        if (event.threadId !== threadId || event.turnId !== nativeTurnId) return;
        emit({event_type: "turn.plan.updated", turn_id: input.payload.turn_id,
          data: {plan: boundedContent(event.plan), ...(event.explanation ? {delta: event.explanation} : {})}});
      } else if (message.method === "turn/diff/updated") {
        const event = z.object({threadId: z.string(), turnId: z.string(), diff: z.string()}).parse(message.params);
        if (event.threadId !== threadId || event.turnId !== nativeTurnId) return;
        emit({event_type: "turn.diff.updated", turn_id: input.payload.turn_id, data: {diff_summary: boundedText(event.diff)}});
      } else if (message.method === "thread/tokenUsage/updated") {
        const event = z
          .object({
            threadId: z.string(),
            turnId: z.string(),
            tokenUsage: z.object({
              total: z.object({
                inputTokens: z.number().int().nonnegative(),
                outputTokens: z.number().int().nonnegative(),
                totalTokens: z.number().int().nonnegative(),
              }),
            }),
          })
          .parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turnId !== nativeTurnId)
        )
          return;
        usage = {
          input_tokens: event.tokenUsage.total.inputTokens,
          output_tokens: event.tokenUsage.total.outputTokens,
          total_tokens: event.tokenUsage.total.totalTokens,
        };
        emit({
          event_type: "usage.updated",
          turn_id: input.payload.turn_id,
          data: { ...usage },
        });
      } else if (message.method === "turn/completed") {
        const event = terminalSchema.parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turn.id !== nativeTurnId)
        )
          return;
        settled = true;
        if (
          event.turn.status !== "completed" ||
          event.turn.error != null ||
          finalText === undefined
        ) {
          reject(
            new HarnessAdapterError(
              "codex_turn_failed",
              "Codex ended without a successful final answer.",
            ),
          );
        } else resolve({ final_text: finalText, ...(usage ? { usage } : {}) });
      }
    };
    const continuation = input.mcpContinuation;
    if (continuation) await recordMcpContinuation(rpc, threadId, continuation);
    const turn = z.object({ turn: idObject }).parse(
      await rpc.request("turn/start", {
        threadId,
        model: selection.model,
        ...(effort ? { effort } : {}),
        collaborationMode: {mode: input.payload.mode === "plan" ? "plan" : "default",
          settings: {model: selection.model, reasoning_effort: effort ?? null, developer_instructions: null}},
        input: [{ type: "text", text: continuation
          ? (continuation.outcome.kind === "declined" ? "The user declined the pending tool call. Continue without executing it."
            : "Continue using the result of the separately approved tool operation recorded above.")
          : input.payload.input, text_elements: [] }, ...(input.payload.images ?? []).map(image => ({type: "image", url: `data:${image.mime_type};base64,${image.data_base64}`}))],
      }),
    );
    if (nativeTurnId !== undefined && nativeTurnId !== turn.turn.id)
      throw new HarnessAdapterError(
        "codex_turn_mismatch",
        "Codex returned conflicting turn identities.",
      );
    nativeTurnId = turn.turn.id;
    const output = await terminal;
    reusable = true;
    return output;
  } finally {
    interactions?.close();
    input.registerNativeInteractions?.(undefined);
    signal.removeEventListener("abort", abort);
    if (reusable && !signal.aborted && cleanupThreadId) {
      // Unload the invocation's thread before reusing its process. Never retain
      // callbacks, approvals or tool bridges belonging to the preceding owner.
      let timer: NodeJS.Timeout | undefined;
      try {
        rpc.onNotification = () => {};
        const cleanup = async () => {
          const response = z.object({status:z.enum(["notLoaded","notSubscribed","unsubscribed"])}).parse(
            await rpc.request("thread/unsubscribe", {threadId:cleanupThreadId}));
          if (response.status === "notSubscribed") throw new Error("Codex thread ownership is not confirmed");
          // An unsubscribed client may no longer receive thread/closed. Verify
          // that the server has actually unloaded every invocation thread.
          for (;;) {
            const loaded = z.object({data: z.array(z.string()), nextCursor: z.string().nullable().optional()}).parse(
              await rpc.request("thread/loaded/list", {}));
            if (loaded.data.length === 0 && !loaded.nextCursor) return;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        };
        await Promise.race([cleanup(),
          new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("Codex thread cleanup timed out")), 2_000);})]);
        reusable = rpc.resetTurnHandlers();
        } catch {reusable = false;}
      finally {clearTimeout(timer);}
    } else reusable = false;
    await lease.release(reusable);
  }
};

function boundedText(value: string): string {
  if (Buffer.byteLength(value) <= 32 * 1024) return value;
  return [...value].slice(0, 8192).join("") + "\n[output truncated by HCP; inspect the native conversation for the full output]";
}
function boundedContent(value: unknown): unknown {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) <= 48 * 1024 ? value : {truncated: true, summary: boundedText(json)};
}
