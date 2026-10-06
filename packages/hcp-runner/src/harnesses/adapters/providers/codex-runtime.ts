import { z } from "zod";
import { realpath } from "node:fs/promises";
import type {
  HarnessTurnFinalOutput,
  HarnessUsageSnapshot,
  HarnessContextUsage,
} from "@harness-control/protocol";
import { HarnessAdapterError } from "../types.js";
import { adapterMcpServers } from "./shared.js";
import { selectedEffort, type NativeTurn } from "./native-turn.js";
import { CodexRpc, type RpcMessage, type RpcRequestHandler } from "./codex-rpc.js";
import { NativeMcpBridge } from "./native-mcp.js";
import { recordMcpContinuation } from "./mcp-continuation.js";
import { NativeInteractions } from "../../native-interactions.js";
import {updateCodexRootSettings, type CodexSettingsReadback} from "./codex-settings.js";
import {codexApproval} from "./codex-approvals.js";
import type {CodexOwnedWork} from "./codex-work.js";
import type {CodexWorkCallbacks} from "./codex-work-callbacks.js";
import {retainedContent, retainedFinalText, textChunks} from "./content-projection.js";
import {measuredContext, unavailableContext} from "./native-context.js";

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
  approvalsReviewer: z.string().optional(),
});
/** A retained transport belongs to one admitted HCP session, never a process-global pool. */
export type CodexRuntimeLease = {
  rpc: CodexRpc;
  initialized: boolean;
  started?: z.infer<typeof startedSchema>;
  work?: CodexOwnedWork;
  callbacks?: CodexWorkCallbacks;
  settings?: CodexSettingsReadback | undefined;
  closeSettings?: () => void;
};
const deltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string().min(1).max(512).optional(),
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

export const runCodexTurn: NativeTurn = (input, signal, emit) => executeCodexTurn(input, signal, emit);
export const runRetainedCodexTurn = (input: Parameters<NativeTurn>[0], signal: AbortSignal,
  emit: Parameters<NativeTurn>[2], lease: CodexRuntimeLease) => executeCodexTurn(input, signal, emit, lease);
async function executeCodexTurn(input: Parameters<NativeTurn>[0], signal: AbortSignal, emit: Parameters<NativeTurn>[2], lease?: CodexRuntimeLease) {
  let interactions: NativeInteractions | undefined;
  let nativeTurnId: string | undefined;
  let interrupt: Promise<void> | undefined;
  let interruptDeadline: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  let rejectAdmission: ((error: Error) => void) | undefined;
  signal.throwIfAborted();
  if (input.payload.action === "compact" && lease?.work?.busy)
    throw new HarnessAdapterError("native_work_active", "Compaction requires resolved native child ownership.");
  const selection =
    input.payload.model_selection ?? input.startPayload.model_selection;
  let context: HarnessContextUsage = unavailableContext(selection, input.payload.action === "compact" ? "compaction_started" : "new_native_request");
  emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
  const effort = selectedEffort(selection, "codex");
  const rpc = lease?.rpc ?? new CodexRpc(
    input.provider.executable_path ?? "codex",
    input.startPayload.cwd,
    {
      ...process.env,
      ...input.provider.env,
      ...(input.provider.home ? { CODEX_HOME: input.provider.home } : {}),
    },
  );
  const abort = (): void => {
    if (lease?.started && nativeTurnId) {
      interruptDeadline = setTimeout(() => {void rpc.process.stop();}, 10_000);
      interrupt = rpc.request("turn/interrupt", {threadId: lease.started.thread.id, turnId: nativeTurnId}).then(() => undefined,
        () => rpc.process.stop());
      void interrupt.catch(() => {});
    } else void rpc.process.stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    if (!lease?.initialized) {
    await rpc.request("initialize", {
      clientInfo: { name: "hcp-runner", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    if (lease) lease.initialized = true;
    }
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
    const bridge = new NativeMcpBridge(toolsets, input.reviewMcpTool, input.dispatchMcp);
    const sandbox = input.startPayload.sandbox_mode.replaceAll("_", "-");
    const approvalPolicy = {ask: "untrusted", auto_edits: "on-request", full_access: "never"}[input.startPayload.approval_policy];
    const resumeThread = input.mcpContinuation?.native_thread_id ?? input.session.native_thread_id;
    const started = lease?.started ?? startedSchema.parse(
      await rpc.request(resumeThread ? "thread/resume" : "thread/start", {
        ...(resumeThread ? {threadId: resumeThread} : {
          ephemeral: false,
          dynamicTools: bridge.definitions,
        }),
        cwd: input.startPayload.cwd,
        model: selection.model,
        sandbox,
        approvalPolicy,
        approvalsReviewer: "user",
        ...(input.startPayload.instructions?.system ? {baseInstructions: input.startPayload.instructions.system} : {}),
        ...(input.startPayload.instructions?.developer ? {developerInstructions: input.startPayload.instructions.developer} : {}),

        config: {
          mcp_servers: servers,
          plugins: Object.fromEntries(
            Object.keys(inheritedPlugins).map((name) => [name, { enabled: false }]),
          ),
          "features.apps": false,
          "features.multi_agent": !!lease?.work,
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
      started.approvalPolicy !== approvalPolicy || lease && started.approvalsReviewer !== "user"
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
    lease?.work?.attachRootThread(threadId);
    if (resumeThread && threadId !== resumeThread) {
      throw new HarnessAdapterError("mcp_continuation_thread_mismatch", "Codex resumed another MCP review thread.");
    }
    if (lease) lease.started = started;
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
    let live = true;
    input.registerActiveTurnControls?.({async steer(text) {
      if (!live || !nativeTurnId || signal.aborted)
        throw new HarnessAdapterError("active_turn_unavailable", "The native turn is no longer steerable.");
      const expectedTurnId = nativeTurnId;
      await rpc.request("turn/steer", {threadId, expectedTurnId, input: [{type: "text", text, text_elements: []}]});
    }});
    interactions = new NativeInteractions(input.startPayload, input.payload, {threadId, turnId: () => nativeTurnId}, emit);
    input.registerNativeInteractions?.(interactions);
    let admit!: () => void;
    const admission = new Promise<void>((resolve, reject) => {admit = resolve; rejectAdmission = reject;});
    lease?.callbacks?.pendingAdmission(admission);
    void admission.catch(() => {});
    if (input.payload.action === "compact") admit();
    const setTurnRequestHandler = (method: string, handler: RpcRequestHandler): void => {
      rpc.setRequestHandler(method, async (params, requestSignal) => {
        await admission; requestSignal.throwIfAborted(); return handler(params, requestSignal);
      });
    };
    setTurnRequestHandler("item/commandExecution/requestApproval", (params, requestSignal) => codexApproval(interactions!, params, "command", requestSignal, !!lease));
    setTurnRequestHandler("item/fileChange/requestApproval", (params, requestSignal) => codexApproval(interactions!, params, "file_change", requestSignal, !!lease));
    setTurnRequestHandler("item/permissions/requestApproval", async (params, requestSignal) => {
      const request = z.object({threadId: z.string(), turnId: z.string(), itemId: z.string(),
        permissions: z.record(z.string(), z.json())}).passthrough().parse(params);
      // This isolated profile never offers session grants or a grant that broadens restricted containment.
      const response = await interactions!.approval({...request, additionalPermissions: request.permissions,
        availableDecisions: ["accept", "decline", "cancel"]}, "permissions", requestSignal);
      return {permissions: response.decision === "accept" ? request.permissions : {}, scope: "turn"};
    });
    setTurnRequestHandler("item/tool/requestUserInput", (params, requestSignal) => interactions!.questions(params, requestSignal));
    setTurnRequestHandler("item/tool/call", async (params, requestSignal) => {
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
    let admissionPending = input.payload.action !== "compact";
    const pendingNotifications: RpcMessage[] = [];
    let pendingBytes = 0;
    const projectNotification = (message: RpcMessage): void => {
      if (settled) return;
      if (message.method === "turn/started") {
        const event = z
          .object({ threadId: z.string(), turn: idObject })
          .parse(message.params);
        if (event.threadId === threadId && input.payload.action === "compact" && nativeTurnId === undefined) {
          nativeTurnId = event.turn.id;
          lease?.callbacks?.admit(input, threadId, nativeTurnId);
        }
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
        for (const delta of textChunks(event.delta)) emit({
          event_type:
            message.method === "item/agentMessage/delta"
              ? "content.delta"
              : "reasoning.delta",
          turn_id: input.payload.turn_id,
          data: { delta, ...(event.itemId ? {item_id: event.itemId} : {}) },
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
              ...(event.item.aggregatedOutput != null ? {output: retainedContent(event.item.aggregatedOutput, input.publishContent)} : {})}});
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
              ? { content: retainedContent(event.item.text, input.publishContent) }
              : event.item.type === "fileChange" ? {content: retainedContent({changes: event.item.changes ?? []}, input.publishContent)} : {}),
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
          data: {item_id: event.itemId, item_type: "commandExecution", content: {output_delta: retainedContent(event.delta, input.publishContent)}}});
      } else if (message.method === "turn/plan/updated") {
        const event = z.object({threadId: z.string(), turnId: z.string(), plan: z.array(z.json()), explanation: z.string().nullish()}).parse(message.params);
        if (event.threadId !== threadId || event.turnId !== nativeTurnId) return;
        emit({event_type: "turn.plan.updated", turn_id: input.payload.turn_id,
          data: {plan: retainedContent(event.plan, input.publishContent), ...(event.explanation ? {delta: boundedText(event.explanation)} : {})}});
      } else if (message.method === "turn/diff/updated") {
        const event = z.object({threadId: z.string(), turnId: z.string(), diff: z.string()}).parse(message.params);
        if (event.threadId !== threadId || event.turnId !== nativeTurnId) return;
        emit({event_type: "turn.diff.updated", turn_id: input.payload.turn_id, data: {diff_summary: boundedText(event.diff),
          ...(Buffer.byteLength(event.diff) > 32 * 1024 && input.publishContent ? {content_ref: input.publishContent(event.diff)} : {})}});
      } else if (message.method === "thread/tokenUsage/updated") {
        const binding = z.object({threadId: z.string(), turnId: z.string()}).parse(message.params);
        if (binding.threadId !== threadId || !nativeTurnId || binding.turnId !== nativeTurnId) return;
        const event = z
          .object({
            threadId: z.string(),
            turnId: z.string(),
            tokenUsage: z.object({
              last: z.object({totalTokens: z.number().int().nonnegative()}).optional(),
              modelContextWindow: z.number().int().nonnegative().nullable().optional(),
              total: z.object({
                inputTokens: z.number().int().nonnegative(),
                outputTokens: z.number().int().nonnegative(),
                totalTokens: z.number().int().nonnegative(),
              }),
            }),
          })
          .parse(message.params);
        if (event.tokenUsage.last) {
          context = measuredContext(selection, "codex.thread.tokenUsage.last", event.tokenUsage.last.totalTokens, event.tokenUsage.modelContextWindow);
          emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
        }
        usage = {
          scope: "conversation", status: "complete", source: "codex.thread.tokenUsage.total",
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
        live = false;
        interrupted = event.turn.status === "interrupted";
        if (
          event.turn.status !== "completed" ||
          event.turn.error != null ||
          (finalText === undefined && input.payload.action !== "compact")
        ) {
          reject(
            new HarnessAdapterError(
              "codex_turn_failed",
              `Codex ended without a successful final answer (status: ${event.turn.status}).${
                event.turn.error && typeof event.turn.error === "object" && "message" in event.turn.error && typeof event.turn.error.message === "string"
                  ? ` ${boundedText(event.turn.error.message)}` : ""}`,
            ),
          );
        } else resolve({ ...retainedFinalText(finalText ?? "", input.publishContent), context, ...(usage ? { usage } : {}) });
      }
    };
    rpc.onNotification = message => {
      if (!admissionPending) return projectNotification(message);
      pendingBytes += Buffer.byteLength(JSON.stringify(message));
      if (pendingNotifications.length >= 256 || pendingBytes > 1024 * 1024)
        throw new HarnessAdapterError("codex_admission_overflow", "Codex exceeded the bounded turn-admission notification buffer.");
      pendingNotifications.push(message);
    };
    if (lease && input.payload.action !== "compact") {
      const settings = await updateCodexRootSettings(rpc, {threadId, model: selection.model, ...(effort ? {effort} : {}),
        mode: input.payload.mode === "plan" ? "plan" : "default", cwd: input.startPayload.cwd,
        approvalPolicy: started.approvalPolicy, sandbox: started.sandbox}, signal, lease.settings);
      emit({event_type: "settings.effective", turn_id: input.payload.turn_id, data: {scope: "root", source: "native",
        model_selection: {model: settings.model, options: settings.effort ? [{id: "reasoningEffort", value: settings.effort}] : []},
        mode: settings.collaborationMode.mode === "plan" ? "plan" : "execute",
        approval_policy: input.startPayload.approval_policy, sandbox_mode: input.startPayload.sandbox_mode}});
    }
    const continuation = input.mcpContinuation;
    if (continuation) await recordMcpContinuation(rpc, threadId, continuation);
    if (input.payload.action === "compact") {
      await rpc.request("thread/compact/start", {threadId});
      return await terminal;
    }
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
    lease?.callbacks?.admit(input, threadId, nativeTurnId);
    admissionPending = false;
    admit();
    for (const message of pendingNotifications) projectNotification(message);
    const output = await terminal;
    await lease?.work?.settled();
    return output;
  } catch (failure) {
    if (lease && !(signal.aborted && interrupted)) await rpc.process.stop();
    throw failure;
  } finally {
    rejectAdmission?.(new HarnessAdapterError("codex_turn_admission_lost", "The native turn was not admitted."));
    input.registerActiveTurnControls?.(undefined);
    interactions?.close();
    input.registerNativeInteractions?.(undefined);
    signal.removeEventListener("abort", abort);
    await interrupt;
    if (interruptDeadline) clearTimeout(interruptDeadline);
    if (!lease) await rpc.process.stop();
    rpc.onNotification = () => {};
    rpc.onFailure = () => {};
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
      "item/permissions/requestApproval", "item/tool/requestUserInput", "item/tool/call"])
      rpc.removeRequestHandler(method);
  }
}

function boundedText(value: string): string {
  if (Buffer.byteLength(value) <= 32 * 1024) return value;
  return [...value].slice(0, 8192).join("") + "\n[output truncated by HCP; inspect the native conversation for the full output]";
}
