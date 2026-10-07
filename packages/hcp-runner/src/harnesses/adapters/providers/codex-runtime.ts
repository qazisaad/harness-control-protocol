import {nativeTurnImages} from "./native-images.js";
import {portableItemObservation} from "../../portable-history.js";
import {nativePlanObservation} from "./native-plan.js";
import {isDeepStrictEqual} from "node:util";
import {harnessNativeReasoningContentSchema} from "@harness-control/protocol";
import {codexApprovalPolicy, codexApprovalPolicySchema} from "./codex-approval-options.js";
import {CodexRootUsage} from "./codex-root-usage.js";
import {codexRequestIdentity} from "./codex-request-identity.js";
import { z } from "zod";
import { realpath } from "node:fs/promises";
import type {
  HarnessTurnFinalOutput,
  HarnessUsageSnapshot,
  HarnessContextUsage,
  HarnessModelSelection,
} from "@harness-control/protocol";
import { HarnessAdapterError } from "../types.js";
import { adapterMcpServers, nativeInstructions } from "./shared.js";
import { selectedEffort, type NativeTurn } from "./native-turn.js";
import { CodexRpc, type RpcMessage, type RpcRequestHandler } from "./codex-rpc.js";
import { NativeMcpBridge } from "./native-mcp.js";
import { recordMcpContinuation } from "./mcp-continuation.js";
import { NativeInteractions } from "../../native-interactions.js";
import {codexReasoningSummarySchema, updateCodexRootSettings, type CodexSettingsReadback} from "./codex-settings.js";
import {codexApproval} from "./codex-approvals.js";
import type {CodexOwnedWork} from "./codex-work.js";
import type {CodexWorkCallbacks} from "./codex-work-callbacks.js";
import {retainedContent, retainedFinalText, textChunks} from "./content-projection.js";
import {measuredContext, unavailableContext} from "./native-context.js";
import {CodexGoalOwner, readCodexGoal, type CodexGoal} from "./codex-goal.js";
import {projectCodexGoal} from "./codex-goal-controls.js";
import {NativePhaseWaiter} from "./native-phase-waiter.js";

const object = z.record(z.string(), z.unknown());
const idObject = z.object({ id: z.string() });
// Null/omission preserves the previous native summary setting. HCP explicitly
// restores its advertised default when a turn removes an earlier override.
function codexReasoningSummary(selection: HarnessModelSelection) {
  return codexReasoningSummarySchema.parse(selection.options?.find(option => option.id === "reasoningSummary")?.value ?? "auto");
}

function codexServiceTier(selection: HarnessModelSelection): {serviceTier?: string} {
  const tier = selection.options?.find(option => option.id === "serviceTier");
  return tier ? {serviceTier: z.string().min(1).max(128).parse(tier.value)} : {};
}
const startedSchema = z.object({
  thread: idObject,
  sandbox: z.object({
    type: z.string(),
    writableRoots: z.array(z.string()).optional(),
    networkAccess: z.boolean().optional(),
    excludeTmpdirEnvVar: z.boolean().optional(),
    excludeSlashTmp: z.boolean().optional(),
  }),
  approvalPolicy: codexApprovalPolicySchema,
  approvalsReviewer: z.string().optional(),
});
/** A retained transport belongs to one admitted HCP session, never a process-global pool. */
export type CodexRuntimeLease = {
  rpc: CodexRpc;
  initialized: boolean;
  usageFresh?: boolean;
  goalMutationOrigins?: boolean;
  started?: z.infer<typeof startedSchema>;
  work?: CodexOwnedWork;
  callbacks?: CodexWorkCallbacks;
  settings?: CodexSettingsReadback | undefined;
  closeSettings?: () => void;
  goal?: CodexGoalOwner | undefined;
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
    summary: z.unknown().optional(),
    content: z.unknown().optional(),
    phase: z.string().nullable().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    status: z.string().optional(),
    aggregatedOutput: z.string().nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().nonnegative().nullable().optional(),
    changes: z.array(z.json()).optional(),
  }).passthrough(),
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
  const images = nativeTurnImages(input);
  let interactions: NativeInteractions | undefined;
  let nativeTurnId: string | undefined;
  let interrupt: Promise<void> | undefined;
  let interruptDeadline: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  let rejectAdmission: ((error: Error) => void) | undefined;
  let goalOwner: CodexGoalOwner | undefined;
  let goalAdmission: string | undefined;
  const phases = new NativePhaseWaiter();
  let rejectGoalAbort: ((error: Error) => void) | undefined;
  signal.throwIfAborted();
  if (input.payload.action === "compact" && lease?.work?.busy)
    throw new HarnessAdapterError("native_work_active", "Compaction requires resolved native child ownership.");
  const selection =
    input.payload.model_selection ?? input.startPayload.model_selection;
  let observedSelection = selection;
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
    if (goalOwner) {
      interruptDeadline = setTimeout(() => {void rpc.process.stop();}, 10_000);
      interrupt = (async () => {
        await goalOwner!.pause();
        if (lease?.started && nativeTurnId)
          await rpc.request("turn/interrupt", {threadId: lease.started.thread.id, turnId: nativeTurnId});
        else {interrupted = true; rejectGoalAbort?.(new HarnessAdapterError("native_goal_paused", "The native goal was paused before another phase was admitted."));}
      })().catch(async failure => {await rpc.process.stop(); rejectGoalAbort?.(failure); throw failure;});
      void interrupt.catch(() => {});
      return;
    }
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
    const newlyCreatedRoot = !input.mcpContinuation?.native_thread_id && !input.session.native_thread_id && !lease?.started;
    const {started, bridge} = await initializeCodexConversation(input, selection, rpc, lease);
    const threadId = started.thread.id;
    const rootUsage = new CodexRootUsage(threadId, lease?.usageFresh ?? newlyCreatedRoot);
    if (lease) lease.usageFresh = false;
    if (input.persistNativeThread) emit({event_type: "session.configured", data: {native_conversation_ready: true, native_reference: threadId}});
    let nativeAdmission: string | undefined;
    let live = true;
    input.registerActiveTurnControls?.({async steer(text) {
      if (!live || signal.aborted || !nativeTurnId && !goalOwner?.active)
        throw new HarnessAdapterError("active_turn_unavailable", "The native turn is no longer steerable.");
      const expectedTurnId = nativeTurnId ?? await phases.wait(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      if (!live || signal.aborted || nativeTurnId !== expectedTurnId)
        throw new HarnessAdapterError("active_turn_unavailable", "The next owned native phase settled before steering.");
      const response = z.object({turnId: z.string()}).parse(await rpc.request("turn/steer", {threadId, expectedTurnId,
        input: [{type: "text", text, text_elements: []}]}));
      if (response.turnId !== expectedTurnId)
        throw new HarnessAdapterError("native_steer_mismatch", "Codex steering acknowledged a different native execution.");
    }});
    interactions = new NativeInteractions(input.startPayload, input.payload, {threadId, turnId: () => nativeTurnId}, emit);
    input.registerNativeInteractions?.(interactions);
    let admit!: () => void;
    const admission = new Promise<void>((resolve, reject) => {admit = resolve; rejectAdmission = reject;});
    lease?.callbacks?.pendingAdmission(admission);
    void admission.catch(() => {});
    if (input.payload.action === "compact") admit();
    const setTurnRequestHandler = (method: string, handler: RpcRequestHandler): void => {
      rpc.setRequestHandler(method, async (params, requestSignal, context) => {
        await admission; requestSignal.throwIfAborted(); return handler(params, requestSignal, context);
      });
    };
    setTurnRequestHandler("item/commandExecution/requestApproval", (params, requestSignal, context) => codexApproval(interactions!, params, "command", requestSignal, !!lease, context));
    setTurnRequestHandler("item/fileChange/requestApproval", (params, requestSignal, context) => codexApproval(interactions!, params, "file_change", requestSignal, !!lease, context));
    setTurnRequestHandler("item/permissions/requestApproval", async (params, requestSignal, context) => {
      const request = z.object({threadId: z.string(), turnId: z.string(), itemId: z.string(),
        permissions: z.record(z.string(), z.json())}).passthrough().parse(params);
      // This isolated profile never offers session grants or a grant that broadens restricted containment.
      const response = await interactions!.approval({...request, additionalPermissions: request.permissions,
        availableDecisions: ["accept", "decline", "cancel"]}, "permissions", requestSignal, codexRequestIdentity(params, context));
      return {permissions: response.decision === "accept" ? request.permissions : {}, scope: "turn"};
    });
    setTurnRequestHandler("item/tool/requestUserInput", (params, requestSignal, context) => interactions!.questions(params, requestSignal, codexRequestIdentity(params, context)));
    setTurnRequestHandler("item/tool/call", async (params, requestSignal) => {
      if (!nativeTurnId) throw new HarnessAdapterError("codex_turn_missing", "Native tool calls require an active turn.");
      return bridge.call(params, {threadId, turnId: nativeTurnId}, requestSignal);
    });
    let finalText: string | undefined;
    let completedPlan = false;
    let lastCompletedOutput: HarnessTurnFinalOutput | undefined;
    let usage: HarnessUsageSnapshot | undefined;
    let settled = false;
    let resolve!: (output: HarnessTurnFinalOutput) => void;
    let reject!: (error: Error) => void;
    const terminal = new Promise<HarnessTurnFinalOutput>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    rejectGoalAbort = reject;
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
      if (goalOwner?.observe(message)) {
        if (!goalOwner.active && lastCompletedOutput && nativeTurnId === undefined) {
          settled = true; live = false; resolve(lastCompletedOutput);
        }
      } else if (message.method === "turn/started") {
        const event = z
          .object({ threadId: z.string(), turn: idObject })
          .parse(message.params);
        if (event.threadId === threadId && input.payload.action === "compact" && nativeTurnId === undefined) {
          nativeTurnId = event.turn.id;
          if (nativeAdmission) input.confirmNativeExecution?.(nativeAdmission, nativeTurnId);
          lease?.callbacks?.admit(input, threadId, nativeTurnId);
          phases.admit(nativeTurnId);
        } else if (event.threadId === threadId && goalOwner && nativeTurnId === undefined) {
          // The exclusive retained stdio owner sent no other root start. The
          // admitted native goal authorizes the runtime's subsequent phases.
          if (!goalAdmission || !goalOwner.active && !signal.aborted)
            throw new HarnessAdapterError("native_goal_phase_unowned", "A native autonomous phase has no active admitted goal owner.");
          nativeTurnId = event.turn.id;
          const phase = input.beginNativeExecution!(threadId, goalAdmission, true);
          nativeAdmission = phase;
          input.confirmNativeExecution!(phase, nativeTurnId);
          lease?.callbacks?.admit(input, threadId, nativeTurnId);
          phases.admit(nativeTurnId);
          finalText = undefined; completedPlan = false; usage = undefined;
          rootUsage.begin(nativeTurnId);
          context = unavailableContext(observedSelection, "new_native_request");
          emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
        }
      } else if (message.method === "model/rerouted") {
        const event = z.object({threadId: z.string(), turnId: z.string()}).extend({fromModel: z.string().min(1).max(512), toModel: z.string().min(1).max(512), reason: z.string().max(2048)}).parse(message.params);
        if (event.threadId !== threadId || event.turnId !== nativeTurnId) return;
        observedSelection = {model: event.toModel};
        context = unavailableContext(observedSelection, "native_model_changed");
        emit({event_type: "model.rerouted", turn_id: input.payload.turn_id, data: {from_model: event.fromModel, to_model: event.toModel, reason: event.reason}});
        emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
      } else if (message.method === "item/plan/delta") {
        const event = deltaSchema.extend({itemId: z.string().min(1).max(512)}).parse(message.params);
        if (event.threadId !== threadId || !nativeTurnId || event.turnId !== nativeTurnId) return;
        for (const delta of textChunks(event.delta)) emit({event_type: "turn.proposed.delta", turn_id: input.payload.turn_id,
          data: {item_id: event.itemId, native_execution_reference: nativeTurnId, delta}});
      } else if (
        message.method === "item/agentMessage/delta" ||
        message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta"
      ) {
        const event = deltaSchema.extend({summaryIndex: z.number().int().min(0).max(4095).optional(),
          contentIndex: z.number().int().min(0).max(4095).optional()}).parse(message.params);
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
          data: { delta, ...(event.itemId ? {item_id: event.itemId} : {}), ...(nativeTurnId ? {native_execution_reference: nativeTurnId} : {}),
            ...(message.method === "item/reasoning/summaryTextDelta" ? {stream_kind: "reasoning_summary",
              ...(event.itemId && event.summaryIndex !== undefined ? {native_segment: {kind: "summary", index: event.summaryIndex}} : {})}
              : message.method === "item/reasoning/textDelta" ? {stream_kind: "reasoning_content",
                ...(event.itemId && event.contentIndex !== undefined ? {native_segment: {kind: "content", index: event.contentIndex}} : {})} : {}) },
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
            portable: portableItemObservation(event.item, "codex", {native_reference: threadId, native_item_reference: event.item.id,
              native_execution_reference: event.turnId, ...(["mcpToolCall", "dynamicToolCall"].includes(event.item.type) ? {native_call_reference: event.item.id} : {})}, input.publishContent),
            ...(nativeTurnId ? {native_execution_reference: nativeTurnId} : {}),
            item_type: event.item.type === "fileChange" ? "file_change" : event.item.type,
            ...(event.item.text !== undefined
              ? { content: retainedContent(event.item.text, input.publishContent) }
              : event.item.type === "fileChange" ? {content: retainedContent({changes: event.item.changes ?? []}, input.publishContent)}
                : event.item.type === "reasoning" && event.item.summary !== undefined && event.item.content !== undefined
                  ? {content: retainedContent(harnessNativeReasoningContentSchema.parse({summary: event.item.summary, content: event.item.content}), input.publishContent)} : {}),
            ...(event.item.status ? {status: event.item.status} : {}),
          },
        });
        if (message.method === "item/completed" && event.item.type === "plan" && nativeTurnId && event.turnId === nativeTurnId) {
          if (typeof event.item.text !== "string") throw new HarnessAdapterError("native_plan_content_unconfirmed", "The completed native plan omitted its authoritative text.");
          emit({event_type: "turn.proposed.completed", turn_id: input.payload.turn_id,
            data: {item_id: event.item.id, native_execution_reference: nativeTurnId, plan: retainedContent(event.item.text, input.publishContent), status: "completed"}});
          completedPlan = true;
        }
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
        const native_plan = nativePlanObservation("execution_plan", event.plan, {observation: "snapshot", native_reference: threadId,
          native_execution_reference: event.turnId, ...(typeof event.explanation === "string" ? {explanation: event.explanation} : {})}, input.publishContent);
        emit({event_type: "turn.plan.updated", turn_id: input.payload.turn_id,
          data: {plan: retainedContent(event.plan, input.publishContent), ...(native_plan ? {native_plan} : {}),
            ...(event.explanation ? {delta: boundedText(event.explanation)} : {})}});
      } else if (message.method === "turn/diff/updated") {
        const event = z.object({threadId: z.string(), turnId: z.string(), diff: z.string()}).parse(message.params);
        if (event.threadId !== threadId || event.turnId !== nativeTurnId) return;
        emit({event_type: "turn.diff.updated", turn_id: input.payload.turn_id, data: {diff_summary: boundedText(event.diff),
          ...(Buffer.byteLength(event.diff) > 32 * 1024 && input.publishContent ? {content_ref: input.publishContent(event.diff)} : {})}});
      } else if (message.method === "thread/tokenUsage/updated") {
        const binding = z.object({threadId: z.string(), turnId: z.string()}).parse(message.params);
        if (binding.threadId !== threadId || !nativeTurnId || binding.turnId !== nativeTurnId) return;
        rootUsage.begin(nativeTurnId);
        const rawUsage = z.object({tokenUsage: z.object({last: z.unknown(), total: z.unknown()})}).parse(message.params).tokenUsage;
        rootUsage.observe(nativeTurnId, rawUsage.last, rawUsage.total);
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
          context = measuredContext(observedSelection, "codex.thread.tokenUsage.last", event.tokenUsage.last.totalTokens, event.tokenUsage.modelContextWindow);
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
        rootUsage.begin(event.turn.id);
        emit({event_type: "usage.updated", turn_id: input.payload.turn_id, data: {...rootUsage.snapshot(event.turn.status === "completed" && event.turn.error == null)}});
        interrupted = event.turn.status === "interrupted";
        if (nativeAdmission) input.completeNativeExecution?.(nativeAdmission,
          event.turn.status === "completed" && event.turn.error == null ? "completed" : interrupted ? "interrupted" : "failed",
          {...(finalText !== undefined ? retainedFinalText(finalText, input.publishContent) : {}), context, ...(usage ? {usage} : {})});
        if (
          event.turn.status !== "completed" ||
          event.turn.error != null ||
          (finalText === undefined && !completedPlan && input.payload.action !== "compact" && !goalOwner)
        ) {
          settled = true; live = false;
          reject(
            new HarnessAdapterError(
              "codex_turn_failed",
              `Codex ended without a successful final answer (status: ${event.turn.status}).${
                event.turn.error && typeof event.turn.error === "object" && "message" in event.turn.error && typeof event.turn.error.message === "string"
                  ? ` ${boundedText(event.turn.error.message)}` : ""}`,
            ),
          );
        } else {
          lastCompletedOutput = {...(finalText !== undefined || !completedPlan ? retainedFinalText(finalText ?? "", input.publishContent) : {}), context, ...(usage ? {usage} : {})};
          if (goalOwner?.active) {phases.completed(nativeTurnId!); nativeTurnId = undefined; return;}
          settled = true; live = false; resolve(lastCompletedOutput);
        }
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
        ...codexServiceTier(selection), summary: codexReasoningSummary(selection),
        mode: input.payload.mode === "plan" ? "plan" : "default", cwd: input.startPayload.cwd,
        approvalPolicy: started.approvalPolicy, approvalsReviewer: input.startPayload.approval_reviewer === "native_auto" ? "auto_review" : "user", sandbox: started.sandbox}, signal, lease.settings);
      emit({event_type: "settings.effective", turn_id: input.payload.turn_id, data: {scope: "root", source: "native",
        model_selection: {model: settings.model, options: [...(settings.effort ? [{id: "reasoningEffort", value: settings.effort}] : []),
          ...(settings.serviceTier ? [{id: "serviceTier", value: settings.serviceTier}] : []),
          ...(settings.summary ? [{id: "reasoningSummary", value: settings.summary}] : [])]},
        mode: settings.collaborationMode.mode === "plan" ? "plan" : "execute",
        approval_policy: input.startPayload.approval_policy,
        ...(input.startPayload.approval_options ? {approval_options: structuredClone(input.startPayload.approval_options)} : {}), sandbox_mode: input.startPayload.sandbox_mode,
        ...(input.startPayload.sandbox_options ? {sandbox_options: structuredClone(input.startPayload.sandbox_options)} : {}),
        approval_reviewer: input.startPayload.approval_reviewer ?? "user"}});
    }
    const continuation = input.mcpContinuation;
    if (continuation) await recordMcpContinuation(rpc, threadId, continuation);
    if (input.payload.goal) {
      if (!lease || !input.beginNativeGoal || !input.confirmNativeGoal || !input.beginNativeExecution || !input.confirmNativeExecution
        || input.payload.mode === "plan" || input.payload.action === "compact" || continuation)
        throw new HarnessAdapterError("native_goal_unsupported", "Native goals require exclusive interactive execution ownership without compaction or pending tool continuation.");
      const recordGoal = (goal: CodexGoal): void => {
        if (!goalAdmission) throw new HarnessAdapterError("native_goal_fence_missing", "Native goal observation preceded durable reservation.");
        input.confirmNativeGoal!({source: "native", scope: "root", admission_id: goalAdmission, origin_turn_id: input.payload.turn_id,
          native_reference: goal.threadId, objective: goal.objective, native_created_at: goal.createdAt, native_updated_at: goal.updatedAt,
          status: ({active: "active", paused: "paused", blocked: "blocked", usageLimited: "usage_limited", budgetLimited: "budget_limited", complete: "complete"} as const)[goal.status],
          tokens_used: goal.tokensUsed, time_used_seconds: goal.timeUsedSeconds,
          ...(goal.tokenBudget != null ? {token_budget: goal.tokenBudget} : {})});
      };
      goalOwner = new CodexGoalOwner(rpc, threadId, {reserve(prior) {goalAdmission = input.beginNativeGoal!(threadId, input.payload.goal!, prior && projectCodexGoal(prior));},
        confirm: recordGoal, updated: recordGoal}, lease.goalMutationOrigins);
      lease.goal = goalOwner;
      if (input.payload.goal.action === "start") await goalOwner.prepare(input.payload.goal.objective, input.payload.goal.token_budget, signal);
      else await goalOwner.prepareResume(input.payload.goal.expected_native_created_at, signal);
    }
    signal.throwIfAborted();
    nativeAdmission = input.beginNativeExecution?.(threadId, goalAdmission);
    if (input.payload.action === "compact") {
      await rpc.request("thread/compact/start", {threadId});
      return await terminal;
    }
    const turn = z.object({ turn: idObject }).parse(
      await rpc.request("turn/start", {
        threadId,
        model: selection.model,
        serviceTier: codexServiceTier(selection).serviceTier ?? null,
        summary: codexReasoningSummary(selection),
        ...(effort ? { effort } : {}),
        collaborationMode: {mode: input.payload.mode === "plan" ? "plan" : "default",
          settings: {model: selection.model, reasoning_effort: effort ?? null, developer_instructions: null}},
        input: input.payload.goal?.action === "resume" ? [] : [{ type: "text", text: continuation
          ? (continuation.outcome.kind === "declined" ? "The user declined the pending tool call. Continue without executing it."
            : "Continue using the result of the separately approved tool operation recorded above.")
          : input.payload.input, text_elements: [] }, ...images.map(image => ({type: "image", url: `data:${image.mime_type};base64,${image.data_base64}`}))],
      }),
    );
    if (nativeTurnId !== undefined && nativeTurnId !== turn.turn.id)
      throw new HarnessAdapterError(
        "codex_turn_mismatch",
        "Codex returned conflicting turn identities.",
      );
    nativeTurnId = turn.turn.id;
    if (nativeAdmission) input.confirmNativeExecution?.(nativeAdmission, nativeTurnId);
    lease?.callbacks?.admit(input, threadId, nativeTurnId);
    phases.admit(nativeTurnId);
    if (goalOwner) await goalOwner.activate(signal);
    admissionPending = false;
    admit();
    for (const message of pendingNotifications) projectNotification(message);
    const output = await terminal;
    await lease?.work?.settled();
    return output;
  } catch (failure) {
    if (goalOwner) try {await goalOwner.pause();} catch { /* The retained job fence still records the unknown outcome. */ }
    if (lease && !(signal.aborted && interrupted)) await rpc.process.stop();
    throw failure;
  } finally {
    phases.close();
    if (goalOwner && lease?.goal === goalOwner) lease.goal = undefined;
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

type CodexConversationInitializationInput = Pick<Parameters<NativeTurn>[0],
  "startPayload" | "provider" | "mcpServers" | "mcpToolsets" | "reviewMcpTool" | "dispatchMcp" | "mcpContinuation" | "session" | "persistNativeThread">;
/** Fresh native threads defer persistence until a prompt or explicit placement. */
export async function materializeEmptyCodexConversation(rpc: Pick<CodexRpc, "request">, threadId: string, cwd: string): Promise<void> {
  // A new conversation has no section. Confirm its default placement through
  // the native persistence path, without adding model-visible history or a title.
  z.object({}).strict().parse(await rpc.request("thread/section/move", {threadId, sectionId: null, beforeThreadId: null}));
  const readback = z.object({thread: z.object({id: z.string(), cwd: z.string(), path: z.string().min(1), turns: z.array(z.unknown())})})
    .parse(await rpc.request("thread/read", {threadId, includeTurns: true})).thread;
  if (readback.id !== threadId || await realpath(readback.cwd) !== await realpath(cwd) || readback.turns.length !== 0)
    throw new HarnessAdapterError("native_empty_conversation_mismatch", "Codex did not confirm the durable empty conversation and authorized workspace.");
}
/** Start and turn admission share the same native policy, tool inventory and continuation checks. */
export async function initializeCodexConversation(input: CodexConversationInitializationInput,
  selection: Parameters<NativeTurn>[0]["startPayload"]["model_selection"], rpc: CodexRpc, lease?: CodexRuntimeLease) {
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
    const approvalPolicy = codexApprovalPolicy(input.startPayload);
    const resumeThread = input.mcpContinuation?.native_thread_id ?? input.session.native_thread_id;
    if (resumeThread && !lease?.started) {
      const retainedGoal = await readCodexGoal(rpc, resumeThread, AbortSignal.timeout(10_000));
      if (retainedGoal && !["paused", "complete"].includes(retainedGoal.status))
        throw new HarnessAdapterError("native_goal_owner_unavailable", "Pause or finish the existing native goal through its original owner before resuming the conversation.");
    }
    const started = lease?.started ?? startedSchema.parse(
      await rpc.request(resumeThread ? "thread/resume" : "thread/start", {
        ...(resumeThread ? {threadId: resumeThread} : {
          ephemeral: false,
          dynamicTools: bridge.definitions,
        }),
        cwd: input.startPayload.cwd,
        model: selection.model,
        sandbox,
        serviceTier: codexServiceTier(selection).serviceTier ?? null,
        approvalPolicy,
        approvalsReviewer: input.startPayload.approval_reviewer === "native_auto" ? "auto_review" : "user",
        ...(nativeInstructions(input.startPayload).system ? {baseInstructions: nativeInstructions(input.startPayload).system} : {}),
        developerInstructions: nativeInstructions(input.startPayload).developer ?? "",

        config: {
          mcp_servers: servers,
          plugins: Object.fromEntries(
            Object.keys(inheritedPlugins).map((name) => [name, { enabled: false }]),
          ),
          "features.apps": false,
          "tools.update_plan.enabled": true,
          "features.multi_agent": !!lease?.work,
          "sandbox_workspace_write.writable_roots": input.startPayload.sandbox_options?.writable_roots?.map(root => root.path) ?? [],
          ...(input.startPayload.sandbox_options?.network_access === undefined ? {} : {
            "sandbox_workspace_write.network_access": input.startPayload.sandbox_options.network_access}),
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
      !isDeepStrictEqual(started.approvalPolicy, approvalPolicy) || lease && started.approvalsReviewer !== (input.startPayload.approval_reviewer === "native_auto" ? "auto_review" : "user")
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
        JSON.stringify([...new Set([cwd, ...roots])].sort()) !== JSON.stringify([...new Set([cwd,
          ...await Promise.all((input.startPayload.sandbox_options?.writable_roots ?? []).map(root => realpath(root.path)))])].sort()) ||
        (input.startPayload.sandbox_options?.network_access !== undefined && started.sandbox.networkAccess !== input.startPayload.sandbox_options.network_access) ||
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
    if (lease) {if (!lease.started) lease.usageFresh = !resumeThread; lease.started = started;}
    input.session.native_thread_id = threadId;
    input.persistNativeThread?.(threadId);

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
    return {started, bridge};
}
