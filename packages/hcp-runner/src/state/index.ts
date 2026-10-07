import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  HCP_PAYLOAD_MAX_ENCODED_BYTES,
  hcpCommandNackPayloadSchema,
  hcpHarnessEventPayloadSchema,
  hcpSessionSnapshotPayloadSchema,
  localActionErrorPayloadSchema,
  localActionRequestPayloadSchema,
  localActionResponsePayloadSchema,
  type HcpHarnessEventPayload,
  type HcpNackPayload,
  type HcpSessionSnapshotPayload,
  hcpConversationResultPayloadSchema, type HcpConversationResultPayload,
  harnessNativeWorkRecordSchema,
  isNativeWorkTerminal,
  harnessNativeGoalRecordSchema,
  harnessApprovalOptionsSchema,
  harnessNativeGoalResultSchema,
  type HostRetainedEventRanges,
  type LocalActionErrorPayload,
  type LocalActionRequestPayload,
  type LocalActionResponsePayload,
} from "@harness-control/protocol";
import { z } from "zod";
import {nativeWorkCustodySchema} from "./native-work-custody.js";
import {nativePolicyControlReceiptSchema, nativePolicyControlReceiptsSchema, type NativePolicyControlReceipt} from "./native-policy-control.js";
export {nativePolicyControlReceiptSchema, type NativePolicyControlReceipt} from "./native-policy-control.js";
export {nativeWorkCustodySchema, type NativeWorkCustody} from "./native-work-custody.js";
import {isDeepStrictEqual} from "node:util";
import { persistedMcpReviewSchema, validateMcpTransition, type PersistedMcpReview } from "./mcp-review.js";

const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_RETENTION_PER_SESSION = 512;

export type PersistedCommandReceipt =
  | {
      payloadHash: string;
      outcome: "ack";
      settledAt: string;
      snapshotPayload?: HcpSessionSnapshotPayload;
      conversationPayload?: HcpConversationResultPayload;
    }
  | {
      payloadHash: string;
      outcome: "nack";
      settledAt: string;
      nackPayload: HcpNackPayload;
    };

export type PersistedLocalActionReceipt =
  | {
      payloadHash: string;
      requestPayload: LocalActionRequestPayload;
      outcome: "response";
      settledAt: string;
      payload: LocalActionResponsePayload;
    }
  | {
      payloadHash: string;
      requestPayload: LocalActionRequestPayload;
      outcome: "error";
      settledAt: string;
      payload: LocalActionErrorPayload;
    };

type RunnerStateData = {
  version: 1;
  events: Record<string, HcpHarnessEventPayload[]>;
  commandReceipts: Record<string, PersistedCommandReceipt>;
  localActionReceipts: Record<string, PersistedLocalActionReceipt>;
  mcpReviews: Record<string, PersistedMcpReview>;
  nativeConversations: Record<string, NativeConversation>;
  nativeWork: Record<string, NativeWorkState>;
  exitedSessions: Record<string, true>;
};

// Validate every own key without dropping special JavaScript property names.
const nativeWorkDictionarySchema = z.unknown().transform((input, context): Record<string, z.infer<typeof harnessNativeWorkRecordSchema>> => {
  const result = Object.create(null) as Record<string, z.infer<typeof harnessNativeWorkRecordSchema>>;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    context.addIssue({code: "custom", message: "Expected a native-work dictionary."}); return result;
  }
  for (const [key, value] of Object.entries(input)) {
    const parsed = harnessNativeWorkRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.work_id !== key) {
      context.addIssue({code: "custom", path: [key], message: "Invalid native-work dictionary entry."}); continue;
    }
    result[key] = parsed.data;
  }
  return result;
});
const nativeWorkStateSchema = z.object({scope: z.object({provider_instance_id: z.string(), provider_binding_hash: z.string(),
  workspace_id: z.string(), cwd: z.string(), execution_binding_hash: z.string(), execution_profile: z.string().optional(),
  conversation_key: z.string().min(1).max(512).optional()}).strict(),
  items: nativeWorkDictionarySchema, retired: nativeWorkDictionarySchema.default({}),
  /** Earlier admissions retain their exact execution binding when an idle policy changes. */
  execution_bindings: z.array(z.object({kind: z.enum(["root", "work"]), admission_id: z.string().min(1).max(512),
    binding_hash: z.string().min(1).max(512)}).strict()).max(2176)
    .refine(values => new Set(values.map(value => `${value.kind}:${value.admission_id}`)).size === values.length).optional(),
  custody: z.record(z.string(), nativeWorkCustodySchema).optional(),
  goals: z.array(z.object({admission_id: z.string().min(1).max(512), origin_turn_id: z.string().min(1).max(512),
    native_reference: z.string().min(1).max(512), objective: z.string().min(1).max(128 * 1024),
    token_budget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    expected_native_created_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    phase: z.enum(["pending", "confirmed"]), snapshot: harnessNativeGoalRecordSchema.optional()}).strict()).max(128)
    .refine(values => new Set(values.map(value => value.admission_id)).size === values.length && values.every(value =>
      value.phase === "pending" ? !value.snapshot : value.snapshot?.admission_id === value.admission_id
      && value.snapshot.origin_turn_id === value.origin_turn_id && value.snapshot.native_reference === value.native_reference
      && value.snapshot.objective === value.objective && value.snapshot.token_budget === value.token_budget
      && (value.expected_native_created_at === undefined || value.snapshot.native_created_at === value.expected_native_created_at)), "Invalid native goal admission.").optional(),
  root_executions: z.array(z.object({admission_id: z.string().min(1).max(512), origin_turn_id: z.string().min(1).max(512),
    native_reference: z.string().min(1).max(512), goal_admission_id: z.string().min(1).max(512).optional(),
    native_execution_reference: z.string().min(1).max(512).optional(),
    requires_terminal_proof: z.literal(true).optional(), phase_status: z.enum(["completed", "interrupted", "failed"]).optional()}).strict().refine(value => !value.phase_status || !!value.native_execution_reference, "Native completion requires acknowledged execution identity.")).max(1024)
    .refine(values => new Set(values.map(value => value.admission_id)).size === values.length, "Duplicate native execution admission.").optional(),
  reconciliations: z.array(z.object({command_id: z.string().min(1).max(512), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    result: hcpConversationResultPayloadSchema}).strict()).max(1024).refine(values =>
      new Set(values.map(value => value.command_id)).size === values.length && values.every(value =>
        value.result.command_id === value.command_id && value.result.operation === "work" && value.result.work?.action === "reconcile"),
    "Invalid native reconciliation receipt.").optional(),
  forks: z.array(z.object({command_id: z.string().min(1).max(512), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    work_id: z.string().min(1).max(512), phase: z.enum(["pending", "completed"]),
    result: hcpConversationResultPayloadSchema.optional()}).strict()).max(1024).refine(values =>
      new Set(values.map(value => value.command_id)).size === values.length
      && values.every(value => value.phase === "completed" ? value.result?.command_id === value.command_id
        && value.result.operation === "work" && value.result.work?.action === "fork" && value.result.work.work_id === value.work_id : !value.result),
    "Invalid native child fork receipt.").optional(),
  closure_unconfirmed: z.literal(true).optional()}).strict();
export type NativeWorkState = z.infer<typeof nativeWorkStateSchema>;

const nativeConversationSchema = z.object({native_thread_id: z.string().min(1), binding_hash: z.string().regex(/^[a-f0-9]{64}$/),
  policy_controls: nativePolicyControlReceiptsSchema.optional(),
  goal_controls: z.array(z.object({command_id: z.string().min(1).max(512), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_session_id: z.string().min(1).max(512), native_thread_id: z.string().min(1).max(512), action: z.enum(["pause", "clear"]),
    native_created_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), phase: z.enum(["pending", "completed"]),
    result: harnessNativeGoalResultSchema.optional()}).strict().refine(value => value.phase === "pending" ? !value.result
      : value.result?.action === value.action && value.result.native_reference === value.native_thread_id
        && value.result.target_native_created_at === value.native_created_at,
    "Invalid native goal control receipt.")).max(1024).refine(values => new Set(values.map(value => value.command_id)).size === values.length,
      "Native goal controls require unique command identities.").optional(),
  feedback_submissions: z.array(z.object({command_id: z.string().min(1).max(512), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_session_id: z.string().min(1).max(512), native_thread_id: z.string().min(1).max(512),
    classification: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), include_diagnostics: z.boolean(),
    phase: z.enum(["pending", "completed"]), result: z.object({source: z.literal("native"), feedback_id: z.string().min(1).max(512),
      classification: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), diagnostics_requested: z.boolean()}).strict().optional(),
  }).strict().refine(value => value.phase === "completed" ? value.result?.classification === value.classification
    && value.result.diagnostics_requested === value.include_diagnostics : value.result === undefined, "Invalid feedback dispatch receipt."))
    .max(1024).refine(value => new Set(value.map(item => item.command_id)).size === value.length, "Feedback dispatch identities must be unique.").optional(),
  configuration_base_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  configuration_authority_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  configuration_transitions: z.array(z.object({transition_id: z.string().min(1).max(512),
    change: z.enum(["policy", "mcp_catalog"]).optional(),
    source_binding_hash: z.string().regex(/^[a-f0-9]{64}$/), target_binding_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_history_hash: z.string().regex(/^[a-f0-9]{64}$/), target_session_id: z.string().min(1).max(512),
    phase: z.enum(["pending", "completed"])}).strict()).max(1024).refine(value => new Set(value.map(item => item.transition_id)).size === value.length,
      "Configuration transitions must have unique identities.").optional(),
  updated_at: z.string().datetime({offset: true}), last_session_id: z.string(), provider_instance_id: z.string(), provider_binding_hash: z.string(), workspace_id: z.string(), cwd: z.string(),
  fresh: z.literal(true).optional(),
  approval_policy: z.enum(["ask", "auto_edits", "full_access"]).optional(),
  approval_reviewer: z.enum(["user", "native_auto"]).optional(),
  approval_options: harnessApprovalOptionsSchema.optional(),
  injections: z.array(z.discriminatedUnion("phase", [
    z.object({command_id: z.string().min(1).max(512), request_hash: z.string().regex(/^[a-f0-9]{64}$/), phase: z.literal("pending")}).strict(),
    z.object({command_id: z.string().min(1).max(512), request_hash: z.string().regex(/^[a-f0-9]{64}$/), phase: z.literal("completed"), result: hcpConversationResultPayloadSchema}).strict(),
  ])).max(1024).superRefine((value, context) => {
    const commands = new Set<string>();
    for (const [index, receipt] of value.entries()) {
      if (commands.has(receipt.command_id)) context.addIssue({code: "custom", path: [index], message: "Injection commands must be unique."});
      commands.add(receipt.command_id);
      if (receipt.phase === "completed" && (receipt.result.command_id !== receipt.command_id || receipt.result.operation !== "inject"))
        context.addIssue({code: "custom", path: [index], message: "Completed injection evidence must match its dispatch command."});
    }
  }).optional(),
  rollback: z.object({command_id: z.string(), source_hash: z.string(), target_hash: z.string(), phase: z.enum(["pending", "completed"]),
    replacement_native_thread_id: z.string().optional(), native_fresh: z.literal(true).optional()}).strict().optional(),
  fork: z.object({command_id: z.string(), target_key: z.string(), target_session_id: z.string(), phase: z.enum(["pending", "completed"]),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    result: hcpConversationResultPayloadSchema.optional()}).strict().optional()}).strict();
export type NativeConversation = z.infer<typeof nativeConversationSchema>;

const persistedCommandReceiptSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      payloadHash: z.string().min(1),
      outcome: z.literal("ack"),
      settledAt: z.string().datetime({ offset: true }),
      snapshotPayload: hcpSessionSnapshotPayloadSchema.optional(),
      conversationPayload: hcpConversationResultPayloadSchema.optional(),
    })
    .strict(),
  z
    .object({
      payloadHash: z.string().min(1),
      outcome: z.literal("nack"),
      settledAt: z.string().datetime({ offset: true }),
      nackPayload: hcpCommandNackPayloadSchema,
    })
    .strict(),
]);

const persistedLocalActionReceiptSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      payloadHash: z.string().min(1),
      requestPayload: localActionRequestPayloadSchema,
      outcome: z.literal("response"),
      settledAt: z.string().datetime({ offset: true }),
      payload: localActionResponsePayloadSchema,
    })
    .strict(),
  z
    .object({
      payloadHash: z.string().min(1),
      requestPayload: localActionRequestPayloadSchema,
      outcome: z.literal("error"),
      settledAt: z.string().datetime({ offset: true }),
      payload: localActionErrorPayloadSchema,
    })
    .strict(),
]);

const runnerStateDataSchema = z
  .object({
    version: z.literal(1),
    events: z.record(z.string(), z.array(hcpHarnessEventPayloadSchema)),
    commandReceipts: z.record(z.string(), persistedCommandReceiptSchema),
    localActionReceipts: z.record(z.string(), persistedLocalActionReceiptSchema),
    mcpReviews: z.record(z.string(), persistedMcpReviewSchema).default({}),
    nativeConversations: z.record(z.string(), nativeConversationSchema).default({}),
    nativeWork: z.record(z.string(), nativeWorkStateSchema).default({}),
    exitedSessions: z.record(z.string(), z.literal(true)).default({}),
  })
  .strict();

export type RunnerStateStoreOptions = {
  eventRetentionPerSession?: number;
  receiptRetentionMs?: number;
  now?: () => Date;
};

export interface RunnerStateStore {
  hasSessionExit(sessionId: string): boolean;
  nativeWorkState(sessionId: string): NativeWorkState | undefined;
  saveNativeWorkState(sessionId: string, state: NativeWorkState, event?: HcpHarnessEventPayload): void;
  removeEmptyNativeWorkState(sessionId: string): void;
  readonly contentDirectory?: string;
  getNativeConversation(key: string): NativeConversation | undefined;
  saveNativeConversation(key: string, conversation: NativeConversation): void;
  beginNativePolicyControl(key: string, receipt: NativePolicyControlReceipt): void;
  completeNativePolicyControl(key: string, sessionId: string, commandId: string, result: HcpConversationResultPayload, event?: HcpHarnessEventPayload): void;
  nativeConversationForSession(sessionId: string): {key: string; conversation: NativeConversation} | undefined;
  retireNativeConversation(key: string): void;
  getMcpReview(sessionId: string): PersistedMcpReview | undefined;
  pendingMcpReviews(): PersistedMcpReview[];
  saveMcpReview(review: PersistedMcpReview, event?: HcpHarnessEventPayload): void;
  clearMcpReview(sessionId: string, requestId: string, events?: HcpHarnessEventPayload[]): void;
  nextEventSequence(sessionId: string): number;
  appendEvent(event: HcpHarnessEventPayload): void;
  hasSessionEvents(sessionId: string): boolean;
  retainedEventRanges(): HostRetainedEventRanges | undefined;
  replayEventsAfter(sessionId: string, lastEventSequence: number): HcpHarnessEventPayload[] | undefined;
  sessionSnapshot(commandId: string, sessionId: string): HcpSessionSnapshotPayload | undefined;
  getCommandReceipt(commandId: string): PersistedCommandReceipt | undefined;
  setCommandReceipt(commandId: string, receipt: PersistedCommandReceipt): void;
  getLocalActionReceipt(requestId: string): PersistedLocalActionReceipt | undefined;
  setLocalActionReceipt(requestId: string, receipt: PersistedLocalActionReceipt): void;
}

abstract class BaseRunnerStateStore implements RunnerStateStore {
  readonly #eventRetentionPerSession: number;
  readonly #receiptRetentionMs: number;
  readonly #now: () => Date;
  protected data: RunnerStateData;

  constructor(data: RunnerStateData, options: RunnerStateStoreOptions) {
    this.data = data;
    // External IDs are dictionary keys, including Object.prototype names.
    for (const key of ["events", "commandReceipts", "localActionReceipts", "mcpReviews", "nativeConversations", "nativeWork", "exitedSessions"] as const)
      this.data[key] = Object.assign(Object.create(null), this.data[key]);
    for (const [id, events] of Object.entries(data.events))
      if (events.some(event => event.event_type === "session.exited")) this.data.exitedSessions[id] = true;
    this.#eventRetentionPerSession = options.eventRetentionPerSession ?? DEFAULT_EVENT_RETENTION_PER_SESSION;
    this.#receiptRetentionMs = options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.#eventRetentionPerSession) || this.#eventRetentionPerSession < 1) {
      throw new Error("eventRetentionPerSession must be a positive integer.");
    }
    if (!Number.isFinite(this.#receiptRetentionMs) || this.#receiptRetentionMs <= 0) {
      throw new Error("receiptRetentionMs must be positive.");
    }
    this.#pruneExpiredReceipts();
  }

  abstract persist(): void;

  getNativeConversation(key: string): NativeConversation | undefined {
    const conversation = this.data.nativeConversations[key];
    return conversation ? structuredClone(conversation) : undefined;
  }

  hasSessionExit(sessionId: string): boolean {return this.data.exitedSessions[sessionId] === true;}

  nativeWorkState(sessionId: string): NativeWorkState | undefined {
    const state = this.data.nativeWork[sessionId];
    if (!state) return undefined;
    const copy = structuredClone(state);
    copy.items = Object.assign(Object.create(null), copy.items);
    copy.retired = Object.assign(Object.create(null), copy.retired);
    return copy;
  }

  saveNativeWorkState(sessionId: string, input: NativeWorkState, event?: HcpHarnessEventPayload): void {
    const state = nativeWorkStateSchema.parse(input);
    if (Object.keys(state.items).length !== Object.keys(input.items).length || Object.keys(state.retired).length !== Object.keys(input.retired).length)
      throw new Error("Native work dictionary keys were not preserved by validation.");
    state.items = Object.assign(Object.create(null), state.items);
    state.retired = Object.assign(Object.create(null), state.retired);
    const previous = this.data.nativeWork[sessionId];
    if (previous?.closure_unconfirmed && !state.closure_unconfirmed) throw new Error("Unconfirmed native closure requires authoritative reconciliation; it cannot be cleared by metadata updates.");
    if (!previous && Object.keys(this.data.nativeWork).length >= 1024) throw new Error("Native work session capacity exceeded.");
    if (Object.keys(state.items).length > 128) throw new Error("Native work capacity exceeded; retire completed work before admitting another child.");
    if (Object.keys(state.retired).length > 1024) throw new Error("Native work tombstone capacity exceeded; close the execution lease before retiring further work.");
    if (Object.entries(state.items).some(([key, work]) => key !== work.work_id)) throw new Error("Native work identity mismatch.");
    if (previous && JSON.stringify(previous.scope) !== JSON.stringify(state.scope)) throw new Error("Native work execution scope changed.");
    for (const binding of state.execution_bindings ?? []) {
      const exists = binding.kind === "root" ? state.root_executions?.some(root => root.admission_id === binding.admission_id)
        : !!(state.items[binding.admission_id] ?? state.retired[binding.admission_id]);
      const prior = previous?.execution_bindings?.find(value => value.kind === binding.kind && value.admission_id === binding.admission_id);
      if (!exists || !prior && binding.binding_hash !== state.scope.execution_binding_hash)
        throw new Error("Native execution policy history must belong to its admitted configuration.");
    }
    for (const binding of previous?.execution_bindings ?? []) if (!isDeepStrictEqual(binding,
      state.execution_bindings?.find(value => value.kind === binding.kind && value.admission_id === binding.admission_id)))
      throw new Error("Native execution policy history cannot be erased or replaced.");
    if (Object.keys(state.custody ?? {}).length > 1152) throw new Error("Native work custody capacity exceeded.");
    for (const [id, proof] of Object.entries(state.custody ?? {})) {
      const work = state.items[id] ?? state.retired[id];
      if (!work || id !== proof.work_id || work.native_reference !== proof.native_reference
        || work.origin_turn_id !== proof.origin_turn_id || work.parent_work_id !== proof.parent_work_id || work.kind !== "agent")
        throw new Error("Native work custody does not match its admitted child.");
    }
    for (const [id, proof] of Object.entries(previous?.custody ?? {})) {
      const next = state.custody?.[id];
      const {native_execution_reference: _newExecution, ...nextAdmission} = next ?? {};
      const {native_execution_reference: _oldExecution, ...admission} = proof;
      if (!next || !isDeepStrictEqual(nextAdmission, admission) || proof.native_execution_reference && next.native_execution_reference !== proof.native_execution_reference)
        throw new Error("Native work custody cannot be replaced or removed.");
    }
    for (const receipt of previous?.forks ?? []) {
      const next = state.forks?.find(value => value.command_id === receipt.command_id);
      if (!next || next.work_id !== receipt.work_id || next.request_hash !== receipt.request_hash
        || receipt.phase === "completed" && !isDeepStrictEqual(next, receipt))
        throw new Error("Native child fork dispatch receipts cannot be removed or replaced.");
    }
    for (const receipt of previous?.reconciliations ?? []) {
      if (!isDeepStrictEqual(state.reconciliations?.find(value => value.command_id === receipt.command_id), receipt))
        throw new Error("Native reconciliation receipts cannot be removed or replaced.");
    }
    for (const execution of previous?.root_executions ?? []) {
      const next = state.root_executions?.find(value => value.admission_id === execution.admission_id);
      if (!next || next.origin_turn_id !== execution.origin_turn_id || next.native_reference !== execution.native_reference
        || next.goal_admission_id !== execution.goal_admission_id || next.requires_terminal_proof !== execution.requires_terminal_proof
        || execution.native_execution_reference && next.native_execution_reference !== execution.native_execution_reference
        || execution.phase_status && next.phase_status !== execution.phase_status)
        throw new Error("Native root execution admissions cannot be removed or replaced.");
    }
    for (const execution of state.root_executions ?? []) if (execution.goal_admission_id && !state.goals?.some(goal =>
      goal.admission_id === execution.goal_admission_id && goal.phase === "confirmed"
      && goal.origin_turn_id === execution.origin_turn_id && goal.native_reference === execution.native_reference))
      throw new Error("Native autonomous execution requires its confirmed original goal admission.");
    for (const goal of previous?.goals ?? []) {
      const next = state.goals?.find(value => value.admission_id === goal.admission_id);
      if (!next || next.origin_turn_id !== goal.origin_turn_id || next.native_reference !== goal.native_reference
        || next.objective !== goal.objective || next.token_budget !== goal.token_budget || next.expected_native_created_at !== goal.expected_native_created_at
        || goal.phase === "confirmed" && next.phase !== "confirmed"
        || goal.snapshot && (!next.snapshot || next.snapshot.native_created_at !== goal.snapshot.native_created_at
          || next.snapshot.native_updated_at < goal.snapshot.native_updated_at || next.snapshot.tokens_used < goal.snapshot.tokens_used
          || next.snapshot.time_used_seconds < goal.snapshot.time_used_seconds))
        throw new Error("Native goal admissions cannot be removed, replaced or regressed.");
    }
    if (event && event.session_id !== sessionId) throw new Error("Native work event targets another session.");
    const previousEvents = this.data.events[sessionId];
    this.data.nativeWork[sessionId] = state;
    try {
      if (event) this.#appendEvent(hcpHarnessEventPayloadSchema.parse(event) as HcpHarnessEventPayload);
      this.persist();
    } catch (error) {
      if (previous) this.data.nativeWork[sessionId] = previous; else delete this.data.nativeWork[sessionId];
      if (previousEvents) this.data.events[sessionId] = previousEvents; else delete this.data.events[sessionId];
      throw error;
    }
  }

  removeEmptyNativeWorkState(sessionId: string): void {
    const previous = this.data.nativeWork[sessionId];
    if (!previous || previous.closure_unconfirmed || Object.keys(previous.items).length || Object.keys(previous.retired).length
      || previous.root_executions?.length || previous.goals?.length || previous.forks?.length || previous.reconciliations?.length
      || Object.keys(previous.custody ?? {}).length) return;
    delete this.data.nativeWork[sessionId];
    try {this.persist();} catch (error) {this.data.nativeWork[sessionId] = previous; throw error;}
  }

  beginNativePolicyControl(key: string, input: NativePolicyControlReceipt): void {
    const receipt = nativePolicyControlReceiptSchema.parse(input), previous = this.data.nativeConversations[key];
    const work = this.data.nativeWork[receipt.source_session_id];
    if (receipt.phase !== "pending" || !previous || !work || previous.last_session_id !== receipt.source_session_id
      || previous.native_thread_id !== receipt.native_reference || previous.binding_hash !== receipt.source_binding_hash
      || work.scope.conversation_key !== key || work.scope.execution_binding_hash !== receipt.source_binding_hash
      || work.scope.provider_binding_hash !== previous.provider_binding_hash || work.scope.workspace_id !== previous.workspace_id || work.scope.cwd !== previous.cwd)
      throw new Error("Native policy dispatch requires its original conversation and execution owner.");
    if (work.closure_unconfirmed || Object.values(work.items).some(item => !isNativeWorkTerminal(item.status))
      || work.root_executions?.some(root => !root.native_execution_reference || root.requires_terminal_proof && !root.phase_status)
      || work.goals?.some(goal => goal.phase === "pending" || goal.snapshot?.status === "active")
      || work.forks?.some(fork => fork.phase === "pending") || this.data.mcpReviews[receipt.source_session_id]
      || previous.policy_controls?.some(control => control.phase === "pending")
      || previous.configuration_transitions?.some(control => control.phase === "pending")
      || previous.injections?.some(control => control.phase === "pending") || previous.fork?.phase === "pending" || previous.rollback?.phase === "pending"
      || previous.goal_controls?.some(control => control.phase === "pending") || previous.feedback_submissions?.some(control => control.phase === "pending"))
      throw new Error("Native policy dispatch cannot bypass outstanding work, callbacks or uncertain mutations.");
    const inventoryHash = createHash("sha256").update(JSON.stringify(work)).digest("hex");
    if (receipt.execution_inventory_hash && receipt.execution_inventory_hash !== inventoryHash)
      throw new Error("Native policy dispatch inventory changed before its durable fence.");
    const next = nativeConversationSchema.parse({...previous, policy_controls: [...(previous.policy_controls ?? []),
      {...receipt, execution_inventory_hash: inventoryHash}]});
    this.data.nativeConversations[key] = next;
    try {this.persist();} catch (failure) {this.data.nativeConversations[key] = previous; throw failure;}
  }

  completeNativePolicyControl(key: string, sessionId: string, commandId: string, input: HcpConversationResultPayload, event?: HcpHarnessEventPayload): void {
    const previous = this.data.nativeConversations[key], work = this.data.nativeWork[sessionId];
    const receipt = previous?.policy_controls?.find(control => control.command_id === commandId);
    if (!previous || !work || !receipt || receipt.phase !== "pending" || receipt.source_session_id !== sessionId
      || previous.last_session_id !== sessionId || previous.native_thread_id !== receipt.native_reference
      || previous.binding_hash !== receipt.source_binding_hash || work.scope.execution_binding_hash !== receipt.source_binding_hash
      || work.scope.conversation_key !== key || work.closure_unconfirmed || this.data.mcpReviews[sessionId]
      || receipt.execution_inventory_hash !== createHash("sha256").update(JSON.stringify(work)).digest("hex"))
      throw new Error("Native policy confirmation requires its retained original dispatch fence.");
    const result = hcpConversationResultPayloadSchema.parse(input);
    const completed = nativePolicyControlReceiptSchema.parse({...receipt, phase: "completed", result});
    const bindings = [...(work.execution_bindings ?? [])];
    const retain = (kind: "root" | "work", admission_id: string) => {
      if (!bindings.some(binding => binding.kind === kind && binding.admission_id === admission_id))
        bindings.push({kind, admission_id, binding_hash: work.scope.execution_binding_hash});
    };
    for (const root of work.root_executions ?? []) retain("root", root.admission_id);
    for (const id of new Set([...Object.keys(work.items), ...Object.keys(work.retired)])) retain("work", id);
    const nextWork = nativeWorkStateSchema.parse({...work, execution_bindings: bindings,
      scope: {...work.scope, execution_binding_hash: receipt.target_binding_hash}});
    const nextConversation = nativeConversationSchema.parse({...previous, binding_hash: receipt.target_binding_hash,
      approval_policy: receipt.selection.approval_policy, approval_reviewer: receipt.selection.approval_reviewer,
      updated_at: this.#now().toISOString(), policy_controls: previous.policy_controls!.map(control => control.command_id === commandId ? completed : control)});
    if (event && (event.session_id !== sessionId || event.event_type !== "session.configured"))
      throw new Error("Native policy configuration events require the same physical owner's session.");
    const events = this.data.events[sessionId];
    this.data.nativeConversations[key] = nextConversation; this.data.nativeWork[sessionId] = nextWork;
    try {if (event) this.#appendEvent(hcpHarnessEventPayloadSchema.parse(event) as HcpHarnessEventPayload); this.persist();}
    catch (failure) {
      this.data.nativeConversations[key] = previous; this.data.nativeWork[sessionId] = work;
      if (events) this.data.events[sessionId] = events; else delete this.data.events[sessionId];
      throw failure;
    }
  }

  saveNativeConversation(key: string, input: NativeConversation): void {
    if (!key || key.length > 512) throw new Error("Invalid native conversation key.");
    const conversation = nativeConversationSchema.parse(input);
    const previous = this.data.nativeConversations[key];
    if (!isDeepStrictEqual(previous?.policy_controls ?? [], conversation.policy_controls ?? []))
      throw new Error("Native policy control evidence requires its dedicated atomic dispatch and confirmation path.");
    for (const receipt of previous?.goal_controls ?? []) {
      const next = conversation.goal_controls?.find(item => item.command_id === receipt.command_id);
      const {result: _previousResult, phase: _previousPhase, ...intent} = receipt;
      const {result: _nextResult, phase: _nextPhase, ...nextIntent} = next ?? {};
      if (!next || !isDeepStrictEqual(intent, nextIntent) || receipt.phase === "completed" && !isDeepStrictEqual(next, receipt))
        throw new Error("Native goal control dispatch evidence cannot be removed or rewritten.");
    }
    if (conversation.goal_controls?.some(receipt => receipt.phase === "completed"
      && !previous?.goal_controls?.some(prior => prior.command_id === receipt.command_id)))
      throw new Error("Native goal control completion requires its prior durable dispatch fence.");
    for (const receipt of previous?.feedback_submissions ?? []) {
      const next = conversation.feedback_submissions?.find(item => item.command_id === receipt.command_id);
      if (!next) throw new Error("Native feedback dispatch evidence cannot be erased.");
      const {result: ignored, ...nextIntent} = next;
      const {result: priorResult, ...priorIntent} = receipt;
      if (JSON.stringify({...nextIntent, phase: receipt.phase}) !== JSON.stringify(priorIntent)
        || receipt.phase === "completed" && JSON.stringify(next) !== JSON.stringify(receipt))
        throw new Error("Native feedback dispatch evidence cannot be rewritten.");
    }
    if (conversation.feedback_submissions?.some(receipt => receipt.phase === "completed"
      && !previous?.feedback_submissions?.some(prior => prior.command_id === receipt.command_id)))
      throw new Error("Native feedback completion requires its prior durable dispatch fence.");
    const provenReplacement = previous?.rollback?.phase === "completed" &&
      previous.rollback.replacement_native_thread_id === conversation.native_thread_id &&
      JSON.stringify(previous.rollback) === JSON.stringify(conversation.rollback) && previous.rollback.native_fresh === conversation.fresh;
    const provenTransition = previous?.configuration_base_hash !== undefined
      && previous.configuration_transitions?.some(receipt => receipt.phase === "pending" && receipt.source_binding_hash === previous.binding_hash
        && (previous.configuration_base_hash === conversation.configuration_base_hash
          || receipt.change === "mcp_catalog" && previous.configuration_authority_hash !== undefined
            && previous.configuration_authority_hash === conversation.configuration_authority_hash)
        && receipt.target_binding_hash === conversation.binding_hash && receipt.target_session_id === conversation.last_session_id
        && conversation.configuration_transitions?.some(next => next.phase === "completed"
          && JSON.stringify({...next, phase: "pending"}) === JSON.stringify(receipt))) === true;
    if (previous?.configuration_base_hash && previous.configuration_base_hash !== conversation.configuration_base_hash && !provenTransition)
      throw new Error("Native conversation configuration base changed.");
    if (previous?.configuration_authority_hash && previous.configuration_authority_hash !== conversation.configuration_authority_hash)
      throw new Error("Native conversation authority cannot change through catalog replacement.");
    for (const receipt of previous?.configuration_transitions ?? []) {
      const next = conversation.configuration_transitions?.find(item => item.transition_id === receipt.transition_id);
      if (!next || JSON.stringify({...next, phase: receipt.phase}) !== JSON.stringify(receipt)
        || receipt.phase === "completed" && next.phase !== "completed" || receipt.phase === "pending" && next.phase === "completed" && !provenTransition)
        throw new Error("Native configuration transition evidence cannot be erased or rewritten.");
    }
    if (previous && conversation.configuration_transitions?.some(receipt => receipt.phase === "completed"
      && !previous.configuration_transitions?.some(prior => prior.transition_id === receipt.transition_id)))
      throw new Error("Native configuration completion requires its prior durable dispatch fence.");
    if (previous && ((!provenTransition && previous.binding_hash !== conversation.binding_hash) ||
        previous.provider_binding_hash !== conversation.provider_binding_hash || previous.provider_instance_id !== conversation.provider_instance_id ||
        previous.workspace_id !== conversation.workspace_id || previous.cwd !== conversation.cwd ||
        (!provenTransition && previous.approval_policy !== undefined && previous.approval_policy !== conversation.approval_policy) ||
        (!provenTransition && (previous.approval_reviewer ?? "user") !== (conversation.approval_reviewer ?? "user")) ||
        (previous.native_thread_id !== conversation.native_thread_id && !provenReplacement)))
      throw new Error("Native conversation identity or execution scope changed.");
    if (!previous && Object.keys(this.data.nativeConversations).length >= 1024)
      throw new Error("Native conversation capacity exceeded; retire old runner conversations before starting another.");
    this.data.nativeConversations[key] = conversation;
    try {this.persist();} catch (error) {
      if (previous) this.data.nativeConversations[key] = previous; else delete this.data.nativeConversations[key];
      throw error;
    }
  }

  nativeConversationForSession(sessionId: string): {key: string; conversation: NativeConversation} | undefined {
    const entry = Object.entries(this.data.nativeConversations).find(([, conversation]) => conversation.last_session_id === sessionId);
    return entry ? {key: entry[0], conversation: structuredClone(entry[1])} : undefined;
  }

  retireNativeConversation(key: string): void {
    const prior = this.data.nativeConversations[key];
    if (prior?.policy_controls?.some(receipt => receipt.phase === "pending"))
      throw new Error("An uncertain native policy dispatch cannot be erased by retirement.");
    delete this.data.nativeConversations[key];
    try {this.persist();} catch (error) {if (prior) this.data.nativeConversations[key] = prior; throw error;}
  }

  nextEventSequence(sessionId: string): number {
    return (this.data.events[sessionId]?.at(-1)?.sequence ?? 0) + 1;
  }

  appendEvent(event: HcpHarnessEventPayload): void {
    const previous = this.data.events[event.session_id];
    const exited = this.data.exitedSessions[event.session_id];
    try {this.#appendEvent(event); this.persist();} catch (error) {
      if (previous) this.data.events[event.session_id] = previous; else delete this.data.events[event.session_id];
      if (exited) this.data.exitedSessions[event.session_id] = true; else delete this.data.exitedSessions[event.session_id];
      throw error;
    }
  }

  #appendEvent(event: HcpHarnessEventPayload): void {
    const expectedSequence: number = this.nextEventSequence(event.session_id);
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Event sequence ${event.sequence} for session '${event.session_id}' does not match expected sequence ${expectedSequence}.`,
      );
    }
    const events: HcpHarnessEventPayload[] = [...(this.data.events[event.session_id] ?? [])];
    events.push(event);
    while (events.length > this.#eventRetentionPerSession) {
      events.shift();
    }
    this.data.events[event.session_id] = events;
    if (event.event_type === "session.exited") this.data.exitedSessions[event.session_id] = true;
  }

  getMcpReview(sessionId: string): PersistedMcpReview | undefined {
    const review = this.data.mcpReviews[sessionId];
    return review ? structuredClone(review) : undefined;
  }

  pendingMcpReviews(): PersistedMcpReview[] {
    return structuredClone(Object.values(this.data.mcpReviews));
  }

  saveMcpReview(input: PersistedMcpReview, event?: HcpHarnessEventPayload): void {
    const review = persistedMcpReviewSchema.parse(input);
    const sessionId = review.start.session_id;
    const previous = this.data.mcpReviews[sessionId];
    if (!previous && Object.keys(this.data.mcpReviews).length >= 16) throw new Error("Pending MCP continuation capacity exceeded.");
    if (previous && previous.request_id !== review.request_id) throw new Error("A pending MCP continuation cannot be replaced.");
    if (createHash("sha256").update(review.action_json).digest("hex") !== review.action_hash) throw new Error("MCP review action hash changed.");
    validateMcpTransition(previous, review, event);
    this.#persistMcpChange(sessionId, () => {
      this.data.mcpReviews[sessionId] = review;
      if (event) {
        hcpHarnessEventPayloadSchema.parse(event);
        this.#appendEvent(structuredClone(event));
      }
    });
  }

  clearMcpReview(sessionId: string, requestId: string, events: HcpHarnessEventPayload[] = []): void {
    const review = this.data.mcpReviews[sessionId];
    if (!review || review.request_id !== requestId) throw new Error("MCP continuation identity changed.");
    this.#persistMcpChange(sessionId, () => {
      for (const event of events) {
        if (event.session_id !== sessionId) throw new Error("MCP cleanup event has another session binding.");
        hcpHarnessEventPayloadSchema.parse(event);
        this.#appendEvent(structuredClone(event));
      }
      delete this.data.mcpReviews[sessionId];
    });
  }

  #persistMcpChange(sessionId: string, change: () => void): void {
    const review = this.data.mcpReviews[sessionId];
    const events = this.data.events[sessionId];
    const exited = this.data.exitedSessions[sessionId];
    try {change(); this.persist();} catch (error: unknown) {
      if (review) this.data.mcpReviews[sessionId] = review; else delete this.data.mcpReviews[sessionId];
      if (events) this.data.events[sessionId] = events; else delete this.data.events[sessionId];
      if (exited) this.data.exitedSessions[sessionId] = true; else delete this.data.exitedSessions[sessionId];
      throw error;
    }
  }

  hasSessionEvents(sessionId: string): boolean {
    return (this.data.events[sessionId]?.length ?? 0) > 0;
  }

  retainedEventRanges(): HostRetainedEventRanges | undefined {
    const sessions: HostRetainedEventRanges["sessions"] = Object.entries(this.data.events)
      .map(([sessionId, events]) => {
        const firstEvent: HcpHarnessEventPayload | undefined = events[0];
        const lastEvent: HcpHarnessEventPayload | undefined = events.at(-1);
        return firstEvent && lastEvent
          ? {
              session_id: sessionId,
              first_event_sequence: firstEvent.sequence,
              last_event_sequence: lastEvent.sequence,
            }
          : undefined;
      })
      .filter((range): range is HostRetainedEventRanges["sessions"][number] => range !== undefined)
      .sort((left, right): number => left.session_id.localeCompare(right.session_id));
    return sessions.length > 0 ? { sessions } : undefined;
  }

  replayEventsAfter(sessionId: string, lastEventSequence: number): HcpHarnessEventPayload[] | undefined {
    const events: HcpHarnessEventPayload[] | undefined = this.data.events[sessionId];
    const firstSequence: number | undefined = events?.[0]?.sequence;
    const finalSequence: number | undefined = events?.at(-1)?.sequence;
    if (
      !events ||
      firstSequence === undefined ||
      finalSequence === undefined ||
      lastEventSequence < firstSequence - 1 ||
      lastEventSequence > finalSequence
    ) {
      return undefined;
    }
    return events.filter((event: HcpHarnessEventPayload): boolean => event.sequence > lastEventSequence);
  }

  sessionSnapshot(commandId: string, sessionId: string): HcpSessionSnapshotPayload | undefined {
    const events: HcpHarnessEventPayload[] | undefined = this.data.events[sessionId];
    if (!events || events.length === 0) {
      return undefined;
    }
    const generatedAt: string = this.#now().toISOString();
    const retainedStartsAtOne: boolean = events[0]?.sequence === 1;
    const selectedEvents: HcpHarnessEventPayload[] = [...events];
    while (selectedEvents.length > 0) {
      const firstEvent: HcpHarnessEventPayload = selectedEvents[0]!;
      const finalEvent: HcpHarnessEventPayload = selectedEvents.at(-1)!;
      const base = {
        command_id: commandId,
        session_id: sessionId,
        generated_at: generatedAt,
        from_sequence: firstEvent.sequence,
        through_sequence: finalEvent.sequence,
        events: [...selectedEvents],
        tombstones: [],
      };
      const complete: boolean = retainedStartsAtOne && selectedEvents.length === events.length;
      const snapshot: HcpSessionSnapshotPayload = complete
        ? { ...base, completeness: "complete", omission_semantics: "replace", from_sequence: 1 }
        : {
            ...base,
            completeness: "partial",
            omission_semantics: "preserve",
            reason: retainedStartsAtOne ? "size_limit" : "retention_gap",
          };
      if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= HCP_PAYLOAD_MAX_ENCODED_BYTES) {
        return snapshot;
      }
      selectedEvents.shift();
    }
    return undefined;
  }

  getCommandReceipt(commandId: string): PersistedCommandReceipt | undefined {
    if (this.#pruneExpiredReceipts()) {
      this.persist();
    }
    return this.data.commandReceipts[commandId];
  }

  setCommandReceipt(commandId: string, receipt: PersistedCommandReceipt): void {
    this.data.commandReceipts[commandId] = receipt;
    this.#pruneExpiredReceipts();
    this.persist();
  }

  getLocalActionReceipt(requestId: string): PersistedLocalActionReceipt | undefined {
    if (this.#pruneExpiredReceipts()) {
      this.persist();
    }
    return this.data.localActionReceipts[requestId];
  }

  setLocalActionReceipt(requestId: string, receipt: PersistedLocalActionReceipt): void {
    this.data.localActionReceipts[requestId] = receipt;
    this.#pruneExpiredReceipts();
    this.persist();
  }

  #pruneExpiredReceipts(): boolean {
    const cutoff: number = this.#now().getTime() - this.#receiptRetentionMs;
    let changed = false;
    for (const [commandId, receipt] of Object.entries(this.data.commandReceipts)) {
      if (new Date(receipt.settledAt).getTime() < cutoff) {
        delete this.data.commandReceipts[commandId];
        changed = true;
      }
    }
    for (const [requestId, receipt] of Object.entries(this.data.localActionReceipts)) {
      if (new Date(receipt.settledAt).getTime() < cutoff) {
        delete this.data.localActionReceipts[requestId];
        changed = true;
      }
    }
    return changed;
  }
}

export class MemoryRunnerStateStore extends BaseRunnerStateStore {
  constructor(options: RunnerStateStoreOptions = {}) {
    super(emptyRunnerState(), options);
  }

  persist(): void {}
}

export class JsonRunnerStateStore extends BaseRunnerStateStore {
  readonly #path: string;
  readonly contentDirectory: string;

  constructor(path: string, options: RunnerStateStoreOptions = {}) {
    super(readRunnerState(path), options);
    this.#path = path;
    this.contentDirectory = `${path}.content`;
  }

  persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.#path);
  }
}

export function defaultRunnerStatePath(runnerId: string): string {
  const safeRunnerId: string = runnerId.replace(/[^A-Za-z0-9_-]/g, "-");
  return join(homedir(), ".hcp-runner", "state", `${safeRunnerId}.json`);
}

function emptyRunnerState(): RunnerStateData {
  return {
    version: 1,
    events: {},
    commandReceipts: {},
    localActionReceipts: {},
    mcpReviews: {},
    nativeConversations: {},
    nativeWork: {},
    exitedSessions: {},
  };
}

function readRunnerState(path: string): RunnerStateData {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyRunnerState();
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  return runnerStateDataSchema.parse(parsed) as RunnerStateData;
}
