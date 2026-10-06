import type { HarnessMcpToolset, HarnessMcpContinuation, HarnessNativeInteractions, HarnessActiveTurnControls } from "./adapters/types.js";
import { harnessPromptContextSchema, harnessNativePolicyReadbackSchema, nativeConversationHistorySchema, hcpConversationResultPayloadSchema, hcpHarnessEventPayloadSchema, type HcpConversationRequestPayload, type HcpConversationResultPayload } from "@harness-control/protocol";
import {harnessNativeFeedbackCapabilitiesSchema, harnessNativeFeedbackOperationSchema, harnessNativeFeedbackResultSchema} from "@harness-control/protocol";
import {harnessNativeWorkObservationSchema, harnessNativeWorkRecordSchema, isNativeWorkTerminal,
  type HarnessNativeWorkRecord} from "@harness-control/protocol";
import type {NativeWorkState} from "../state/index.js";
import {nativeWorkPage} from "./native-work-page.js";
import { HarnessMcpReview } from "./mcp-review.js";
import {HarnessMcpDispatchQueue} from "./mcp-dispatch.js";
import {BoundedHarnessContentStore, type HarnessContentStore, type HarnessContentScope} from "./content-store.js";
import {OwnedHarnessInputFileStore, type HarnessInputFileScope} from "./input-files.js";
export {OwnedHarnessInputFileStore, type HarnessInputFileScope} from "./input-files.js";
export {BoundedHarnessContentStore, type HarnessContentStore, type HarnessContentScope} from "./content-store.js";
import type { PersistedMcpReview } from "../state/mcp-review.js";
import type { McpInputReply } from "../mcp/input-required.js";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import { isAbsolute, relative, resolve } from "node:path";
import {validateConfigurationInheritance, validateInstructionRoles} from "./adapters/providers/shared.js";

import type {
  HcpHarnessEventPayload,
  HcpApprovalResponsePayload,
  HcpInputResponsePayload,
  HcpHostReplayUnavailablePayload,
  HcpSessionSnapshotPayload,
  HostResumeCursor,
  HostRetainedEventRanges,
  HcpSessionStartPayload,
  HcpTurnSendPayload,
  LocalActionRequestPayload,
  LocalCapabilityLease,
  McpServerAttachment,
  StreamableHttpMcpServerAttachment,
} from "@harness-control/protocol";

import type { AuditLogger } from "../audit/index.js";
import type { McpStdioProfileConfig, ProviderInstanceConfig, RunnerConfig } from "../config/index.js";
import type { ProviderDriverStatus } from "../host/provider-registry.js";
import {
  LocalCapabilityEngine,
  LocalCapabilityLeaseManager,
  LocalCapabilityPolicyError,
} from "../local-actions/index.js";
import type {
  LocalCapabilityExecutionContext,
  LocalCapabilityExecutionEvent,
} from "../local-actions/executors.js";
import { McpAttachmentClient, mcpReviewActionSchema, mcpToolCallResultSchema, type McpProofSigner, type McpToolDescriptor, type McpToolCallArguments, type McpToolCallResult, type McpReviewGrant } from "../mcp/McpAttachmentClient.js";
import { McpProxyServer } from "../mcp/McpProxyServer.js";
import { McpStdioProfileClient } from "../mcp/McpStdioProfileClient.js";
import { MemoryRunnerStateStore, type RunnerStateStore } from "../state/index.js";
import {
  HarnessAdapterError,
  HarnessAdapterRegistry,
  createDefaultHarnessAdapterRegistry,
  type HarnessAdapter,
  type HarnessAdapterEvent,
  type HarnessAdapterMcpServer,
  type HarnessAdapterSession,
} from "./adapters.js";

export type HarnessLaunchRequest = {
  sessionId: string;
  providerInstanceId: string;
  cwd: string;
};

export type HarnessDriver = {
  kind: string;
  launch(request: HarnessLaunchRequest): Promise<void>;
};

export type HarnessSession = {
  inputFileScope: HarnessInputFileScope;
  sessionId: string;
  cancelRequested: boolean;
  nativeWorkOwnerAvailable?: boolean;
  nativeWorkClosureUnconfirmed?: true;
  nativeWorkCancellation?: AbortController;
  workspaceId: string;
  providerInstanceId: string;
  driverKind: string;
  cwd: string;
  startPayload: HcpSessionStartPayload;
  adapter: HarnessAdapter;
  adapterSession: HarnessAdapterSession;
  localCapabilityLease?: LocalCapabilityLease;
  mcpClients: HarnessMcpClient[];
  mcpServers: HarnessAdapterMcpServer[];
  mcpToolsets: HarnessMcpToolset[];
  nativeBindingHash?: string;
};

export type HarnessMcpClient = {
  readonly adapterAttachment?: HarnessAdapterMcpServer | undefined;
  connect(): Promise<void>;
  listTools?(): Promise<McpToolDescriptor[]>;
  callTool?(name: string, arguments_: McpToolCallArguments, grant?: McpReviewGrant, continuation?: McpInputReply): Promise<McpToolCallResult>;
  close(): Promise<void>;
};

export type HarnessMcpClientRequest = {
  attachment: StreamableHttpMcpServerAttachment;
  sessionId: string;
  hostId: string;
  providerInstanceId: string;
  workspaceId: string;
  driverKind: string;
  proofSigner?: McpProofSigner;
};

export type HarnessMcpClientFactory = (request: HarnessMcpClientRequest) => HarnessMcpClient;

export type HarnessMcpAttachmentResult = {
  clients: HarnessMcpClient[];
  adapterAttachments: HarnessAdapterMcpServer[];
  discoveredTools: HarnessMcpToolDiscovery[];
  toolsets: HarnessMcpToolset[];
};

export type HarnessMcpToolDiscovery = {
  attachmentName: string;
  tools: McpToolDescriptor[];
};

export type HarnessSessionManagerOptions = {
  hostId?: string;
  mcpProofSigner?: McpProofSigner;
  mcpClientFactory?: HarnessMcpClientFactory;
  auditLogger?: AuditLogger;
  replayRetentionEventsPerSession?: number;
  stateStore?: RunnerStateStore;
  adapterRegistry?: HarnessAdapterRegistry;
  contentStore?: HarnessContentStore;
  inputFileStore?: OwnedHarnessInputFileStore;
};

export type HarnessReplayResult = {
  events: HcpHarnessEventPayload[];
  unavailable: HcpHostReplayUnavailablePayload[];
};

export class HarnessSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessSessionError";
  }
}

class SessionStartCleanedError extends Error {
  constructor(readonly originalError: unknown, readonly reason: "mcp_start_failed" | "adapter_start_failed") {
    super("Session startup cleanup completed.");
  }
}

const terminalTurnEvents = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"]);
const memoryInputFiles = new WeakMap<RunnerStateStore, OwnedHarnessInputFileStore>();

export class HarnessSessionManager {
  readonly #nativeInteractions = new Map<string, HarnessNativeInteractions>();
  readonly #sessionInteractions = new Map<string, HarnessNativeInteractions>();
  readonly #activeTurnControls = new Map<string, {turnId: string; controls: HarnessActiveTurnControls}>();
  readonly #liveNativeWork = new Map<string, Set<string>>();
  readonly #config: RunnerConfig;
  readonly #hostId: string;
  readonly #localCapabilities: LocalCapabilityLeaseManager;
  readonly #localCapabilityEngine: LocalCapabilityEngine;
  readonly #mcpProofSigner: McpProofSigner | undefined;
  readonly #mcpClientFactory: HarnessMcpClientFactory;
  readonly #auditLogger: AuditLogger | undefined;
  readonly #stateStore: RunnerStateStore;
  readonly #contentStore: HarnessContentStore;
  #inputFiles: OwnedHarnessInputFileStore | undefined;
  readonly #adapterRegistry: HarnessAdapterRegistry;
  readonly #sessions = new Map<string, HarnessSession>();
  readonly #eventListeners = new Map<(event: HcpHarnessEventPayload) => void, ((error: unknown) => void) | undefined>();
  readonly #publicationQueue: HcpHarnessEventPayload[] = [];
  #publishing = false;
  #publicationAdmissions = 0;
  readonly #mcpReviews = new Map<string, HarnessMcpReview>();
  readonly #mcpWorkReviews = new Map<string, Map<string, HarnessMcpReview>>();
  readonly #runningTurns = new Map<string, string>();
  readonly #mcpDispatch = new Map<string, HarnessMcpDispatchQueue>();
  readonly #mcpResumes = new Set<string>();
  #restoredMcpReviews = false;
  readonly #turnIdsBySession = new Map<string, Set<string>>();
  readonly #startingSessions = new Map<string, { cancelled: boolean; firstTurnId?: string }>();

  constructor(config: RunnerConfig, options: string | HarnessSessionManagerOptions = {}) {
    const resolvedOptions: HarnessSessionManagerOptions = typeof options === "string" ? { hostId: options } : options;
    this.#config = config;
    this.#hostId = resolvedOptions.hostId ?? config.host_id ?? config.runner_id;
    this.#localCapabilities = new LocalCapabilityLeaseManager(config, this.#hostId);
    this.#localCapabilityEngine = new LocalCapabilityEngine(this.#localCapabilities);
    this.#mcpProofSigner = resolvedOptions.mcpProofSigner;
    this.#mcpClientFactory = resolvedOptions.mcpClientFactory ?? defaultMcpClientFactory;
    this.#auditLogger = resolvedOptions.auditLogger;
    this.#stateStore =
      resolvedOptions.stateStore ??
      new MemoryRunnerStateStore(
        resolvedOptions.replayRetentionEventsPerSession === undefined
          ? {}
          : { eventRetentionPerSession: resolvedOptions.replayRetentionEventsPerSession },
      );
    this.#adapterRegistry = resolvedOptions.adapterRegistry ?? createDefaultHarnessAdapterRegistry();
    this.#contentStore = resolvedOptions.contentStore ?? new BoundedHarnessContentStore(this.#stateStore.contentDirectory);
    this.#inputFiles = resolvedOptions.inputFileStore;
  }

  #inputFileStore(): OwnedHarnessInputFileStore {
    if (!this.#inputFiles) {
      this.#inputFiles = memoryInputFiles.get(this.#stateStore) ?? new OwnedHarnessInputFileStore(
        this.#stateStore.contentDirectory ? `${this.#stateStore.contentDirectory}.inputs` : undefined);
      memoryInputFiles.set(this.#stateStore, this.#inputFiles);
    }
    return this.#inputFiles;
  }

  #workspaceQueue: Promise<unknown> = Promise.resolve();

  #serializeWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#workspaceQueue.then(operation);
    this.#workspaceQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  updateWorkspaceConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serializeWorkspace(async () => {
      if (this.activeSessionCount() > 0) throw new HarnessSessionError("workspace_busy", "Stop active sessions before changing workspaces.");
      return operation();
    });
  }

  async #nativeFeedbackOperation(commandId: string, request: HcpConversationRequestPayload & {operation: Extract<HcpConversationRequestPayload["operation"], {kind: "feedback"}>}): Promise<HcpConversationResultPayload> {
    const binding = this.#stateStore.nativeConversationForSession(request.session_id);
    if (!binding) throw new HarnessAdapterError("native_feedback_binding", "Feedback requires a retained native conversation binding.");
    const {key, conversation} = binding;
    await this.#assertWorkspaceAllowed(conversation.workspace_id, conversation.cwd);
    const provider = this.#requireProvider(conversation.provider_instance_id);
    if (nativeProviderHash(provider) !== conversation.provider_binding_hash)
      throw new HarnessAdapterError("native_feedback_binding", "Feedback belongs to the original provider configuration.");
    const operation = harnessNativeFeedbackOperationSchema.parse(request.operation);
    const requestHash = createHash("sha256").update(JSON.stringify({session_id: request.session_id, operation, native_thread_id: conversation.native_thread_id,
      provider_binding_hash: conversation.provider_binding_hash})).digest("hex");
    const result = (feedback: NonNullable<HcpConversationResultPayload["feedback"]>): HcpConversationResultPayload =>
      ({command_id: commandId, session_id: request.session_id, operation: "feedback", filesystem_undo: false, feedback});
    const receipt = conversation.feedback_submissions?.find(item => item.command_id === commandId);
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new HarnessAdapterError("command_conflict", "This feedback identity has different submission parameters.");
      if (receipt.phase === "completed" && receipt.result) return result(harnessNativeFeedbackResultSchema.parse(receipt.result));
      throw new HarnessAdapterError("native_feedback_unknown", "The prior feedback submission has no confirmed outcome; it will not be repeated.");
    }
    const session = this.#sessions.get(request.session_id);
    const declared = session?.adapter.executionProfiles?.find(profile => profile.id === session.startPayload.execution_profile)?.native_feedback;
    if (!session || session.cancelRequested || !declared || !session.adapter.submitNativeFeedback
      || session.adapterSession.native_thread_id !== conversation.native_thread_id || session.nativeBindingHash !== conversation.binding_hash
      || session.nativeWorkOwnerAvailable === false || session.nativeWorkClosureUnconfirmed)
      throw new HarnessAdapterError("native_feedback_owner_unavailable", "Feedback requires its declared live native conversation owner.");
    const capability = harnessNativeFeedbackCapabilitiesSchema.parse(declared);
    if (!capability.classifications.includes(operation.classification) || operation.include_diagnostics && !capability.diagnostics)
      throw new HarnessAdapterError("native_feedback_unsupported", "This native owner does not support the requested feedback classification or diagnostics.");
    if ((conversation.feedback_submissions?.length ?? 0) >= 1024)
      throw new HarnessAdapterError("native_feedback_limit", "This conversation reached its bounded native feedback receipt limit.");
    const intent = {command_id: commandId, request_hash: requestHash, source_session_id: request.session_id,
      native_thread_id: conversation.native_thread_id, classification: operation.classification,
      include_diagnostics: operation.include_diagnostics, phase: "pending" as const};
    this.#stateStore.saveNativeConversation(key, {...conversation, feedback_submissions: [...(conversation.feedback_submissions ?? []), intent]});
    if (this.#stateStore.getNativeConversation(key)?.feedback_submissions?.find(item => item.command_id === commandId)?.request_hash !== requestHash)
      throw new HarnessAdapterError("native_feedback_fence_missing", "Feedback dispatch ownership was not retained.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const submitted = await Promise.race([session.adapter.submitNativeFeedback({sessionId: session.sessionId,
        nativeThreadId: conversation.native_thread_id, provider, startPayload: session.startPayload, request: operation, signal: controller.signal}),
      new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new Error("Feedback acknowledgement deadline expired."));}, 30_000);})]);
      const feedback = harnessNativeFeedbackResultSchema.parse({source: "native", feedback_id: submitted.feedback_id,
        classification: operation.classification, diagnostics_requested: operation.include_diagnostics});
      const current = this.#stateStore.getNativeConversation(key);
      if (!current || current.native_thread_id !== conversation.native_thread_id || current.provider_binding_hash !== conversation.provider_binding_hash)
        throw new Error("Feedback owner changed during acknowledgement.");
      this.#stateStore.saveNativeConversation(key, {...current, feedback_submissions: current.feedback_submissions!.map(item =>
        item.command_id === commandId ? {...item, phase: "completed" as const, result: feedback} : item)});
      if (this.#stateStore.getNativeConversation(key)?.feedback_submissions?.find(item => item.command_id === commandId)?.phase !== "completed")
        throw new Error("Feedback acknowledgement was not retained.");
      return result(feedback);
    } catch {throw new HarnessAdapterError("native_feedback_unknown", "Feedback dispatch has an unknown outcome; the retained command identity will not be resubmitted.");}
    finally {if (timer) clearTimeout(timer); controller.abort();}
  }

  async #nativeWorkOperation(commandId: string, request: HcpConversationRequestPayload & {operation: Extract<HcpConversationRequestPayload["operation"], {kind: "work"}>}): Promise<HcpConversationResultPayload> {
    let state = this.#stateStore.nativeWorkState(request.session_id);
    if (!state) throw new HarnessAdapterError("native_work_unavailable", "This session has no retained native-work contract.");
    await this.#assertWorkspaceAllowed(state.scope.workspace_id, state.scope.cwd);
    state = this.#stateStore.nativeWorkState(request.session_id);
    if (!state) throw new HarnessAdapterError("native_work_unavailable", "Native work was retired during authorization.");
    const provider = this.#requireProvider(state.scope.provider_instance_id);
    if (nativeProviderHash(provider) !== state.scope.provider_binding_hash)
      throw new HarnessAdapterError("native_work_binding", "Native work belongs to the original provider configuration.");
    const session = this.#sessions.get(request.session_id);
    const operation = request.operation;
    const result = (work: NonNullable<HcpConversationResultPayload["work"]>): HcpConversationResultPayload =>
      ({command_id: commandId, session_id: request.session_id, operation: "work", filesystem_undo: false, work});
    if (operation.action === "read") return result(nativeWorkPage(request.session_id, session?.nativeWorkClosureUnconfirmed ? {...state, closure_unconfirmed: true} : state,
      session?.nativeWorkOwnerAvailable === true, this.#liveNativeWork.get(request.session_id) ?? new Set(), operation));
    const work = state.items[operation.work_id];
    if (!work) throw new HarnessAdapterError("native_work_not_found", "Native work is not owned by this session.");
    if (operation.action === "history") {
      if (work.revision !== operation.expected_revision)
        throw new HarnessAdapterError("native_work_changed", "Read the current native-work revision before reading its history.");
      const profile = session?.adapter.executionProfiles?.find(value => value.id === session.startPayload.execution_profile);
      if (!session?.nativeWorkOwnerAvailable || !session.adapter.readNativeWorkHistory || profile?.native_work_history !== "live_owner"
        || !this.#liveNativeWork.get(request.session_id)?.has(work.work_id))
        throw new HarnessAdapterError("native_work_history_unavailable", "This work has no declared live native history owner.");
      if (nativeBindingHash(session.startPayload, provider, session.mcpToolsets) !== state.scope.execution_binding_hash)
        throw new HarnessAdapterError("native_work_binding", "The execution binding no longer owns this native work.");
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const history = await Promise.race([
          session.adapter.readNativeWorkHistory({commandId, sessionId: request.session_id, work: structuredClone(work), provider,
            startPayload: session.startPayload, page: {...(operation.cursor ? {cursor: operation.cursor} : {}),
              ...(operation.limit ? {limit: operation.limit} : {})}, signal: abort.signal,
            publishContent: value => this.#contentStore.publish({session_id: request.session_id, provider_instance_id: provider.id,
              provider_binding_hash: state!.scope.provider_binding_hash, workspace_id: state!.scope.workspace_id, cwd: state!.scope.cwd}, value)}),
          new Promise<never>((_, reject) => {timer = setTimeout(() => {
            const failure = new HarnessAdapterError("native_work_history_timeout", "Native work history exceeded its deadline.");
            abort.abort(failure); reject(failure);
          }, 30_000);}),
        ]);
        if (!session.nativeWorkOwnerAvailable || this.#sessions.get(request.session_id) !== session)
          throw new HarnessAdapterError("native_work_history_unavailable", "The native history owner was lost during the read.");
        if (this.#stateStore.nativeWorkState(request.session_id)?.items[work.work_id]?.revision !== work.revision)
          throw new HarnessAdapterError("native_work_changed", "Native work changed during its history snapshot; read it again.");
        return result({action: "history", work_id: work.work_id, revision: work.revision, source: "native", owner_status: "active", history: nativeConversationHistorySchema.parse(history)});
      } finally {if (timer) clearTimeout(timer); abort.abort();}
    }
    const requestHash = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(operation).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
    const priorCommand = [...Object.values(state.items), ...Object.values(state.retired)].find(item => item.control?.command_id === commandId);
    if (priorCommand && (priorCommand.work_id !== work.work_id || priorCommand.control?.request_hash !== requestHash))
      throw new HarnessAdapterError("native_work_control_conflict", "This native-work command has different parameters.");
    if (operation.action === "cancel" && work.control?.command_id === commandId) {
      if (work.control.phase === "accepted") return result({action: "cancel", work_id: work.work_id, accepted: true});
      if (isNativeWorkTerminal(work.status)) return result({action: "cancel", work_id: work.work_id, accepted: true, already_terminal: true});
      throw new HarnessAdapterError("native_work_cancel_unknown", "The earlier native cancellation has no confirmed outcome and will not be repeated.");
    }
    if (work.revision !== operation.expected_revision)
      throw new HarnessAdapterError("native_work_changed", "Read the current native-work revision before controlling it.");
    if (operation.action === "retire") {
      if (!isNativeWorkTerminal(work.status)) throw new HarnessAdapterError("native_work_pending", "Only completed native work may be retired.");
      const next = this.#stateStore.nativeWorkState(request.session_id)!; delete next.items[work.work_id]; next.retired[work.work_id] = work;
      this.#event(request.session_id, undefined, "native.work.retired", {work_id: work.work_id, revision: work.revision + 1}, next);
      this.#liveNativeWork.get(request.session_id)?.delete(work.work_id);
      return result({action: "retire", work_id: work.work_id, retired: true});
    }
    if (isNativeWorkTerminal(work.status)) return result({action: "cancel", work_id: work.work_id, accepted: true, already_terminal: true});
    if (work.control?.phase === "pending") throw new HarnessAdapterError("native_work_cancel_unknown", "An earlier native cancellation requires reconciliation.");
    if (!session?.nativeWorkOwnerAvailable || !session.adapter.cancelNativeWork || !work.supports_cancel || !this.#liveNativeWork.get(request.session_id)?.has(work.work_id))
      throw new HarnessAdapterError("native_work_cancel_unsupported", "This work has no live native cancellation owner.");
    if (nativeBindingHash(session.startPayload, provider, session.mcpToolsets) !== state.scope.execution_binding_hash)
      throw new HarnessAdapterError("native_work_binding", "The execution binding no longer owns this native work.");
    const fenced = this.#stateStore.nativeWorkState(request.session_id)!;
    fenced.items[work.work_id] = {...work, revision: work.revision + 1,
      control: {command_id: commandId, request_hash: requestHash, action: "cancel", phase: "pending"}};
    this.#event(request.session_id, undefined, "native.work.updated", {work: fenced.items[work.work_id]}, fenced);
    // Publication can synchronously deliver terminal proof before native dispatch.
    if (isNativeWorkTerminal(this.#stateStore.nativeWorkState(request.session_id)!.items[work.work_id]!.status))
      return result({action: "cancel", work_id: work.work_id, accepted: true, already_terminal: true});
    if (!session.nativeWorkOwnerAvailable)
      throw new HarnessAdapterError("native_work_cancel_unknown", "Native ownership was lost before cancellation dispatch; reconcile retained observations.");
    const abort = new AbortController();
    session.nativeWorkCancellation = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted!: () => void;
    try {
      await Promise.race([
        session.adapter.cancelNativeWork({commandId, sessionId: request.session_id, work: structuredClone(work), provider, startPayload: session.startPayload, signal: abort.signal}),
        new Promise<never>((_, reject) => {timer = setTimeout(() => {abort.abort(); reject(new Error("Native cancellation timed out."));}, 30_000);}),
        new Promise<never>((_, reject) => {
          aborted = () => reject(new Error("Native cancellation owner was lost."));
          abort.signal.addEventListener("abort", aborted, {once: true});
          if (abort.signal.aborted) aborted();
        }),
      ]);
    } catch {throw new HarnessAdapterError("native_work_cancel_unknown", "Native cancellation has an unknown outcome; reconcile observations before trying again.");}
    finally {
      if (timer) clearTimeout(timer);
      if (aborted) abort.signal.removeEventListener("abort", aborted);
      if (session.nativeWorkCancellation === abort) delete session.nativeWorkCancellation;
    }
    const accepted = this.#stateStore.nativeWorkState(request.session_id)!;
    const current = accepted.items[work.work_id]!;
    accepted.items[work.work_id] = {...current, revision: current.revision + 1, control: {...current.control!, phase: "accepted"}};
    this.#event(request.session_id, undefined, "native.work.updated", {work: accepted.items[work.work_id]}, accepted);
    return result({action: "cancel", work_id: work.work_id, accepted: true});
  }

  activeSessionCount(): number {
    return this.#sessions.size;
  }

  /** Observes newly committed events in sequence order. Replay and durable consumption remain explicit. */
  subscribeEvents(listener: (event: HcpHarnessEventPayload) => void, onError?: (error: unknown) => void): () => void {
    this.#eventListeners.set(listener, onError);
    return () => {this.#eventListeners.delete(listener);};
  }

  providerDriverStatuses(): Promise<ProviderDriverStatus[]> {
    return this.#adapterRegistry.probeProviders(this.#config.provider_instances);
  }

  localCapabilityEngine(): LocalCapabilityEngine {
    return this.#localCapabilityEngine;
  }

  stateStore(): RunnerStateStore {
    return this.#stateStore;
  }

  retainedEventRanges(): HostRetainedEventRanges | undefined {
    return this.#stateStore.retainedEventRanges();
  }

  replayEventsAfter(cursor: HostResumeCursor): HarnessReplayResult {
    const events: HcpHarnessEventPayload[] = [];
    const unavailable: HcpHostReplayUnavailablePayload[] = [];
    const retainedRanges: HostRetainedEventRanges = this.#stateStore.retainedEventRanges() ?? { sessions: [] };
    for (const sessionCursor of cursor.sessions) {
      const replayed: HcpHarnessEventPayload[] | undefined = this.#stateStore.replayEventsAfter(
        sessionCursor.session_id,
        sessionCursor.last_event_sequence,
      );
      if (!replayed) {
        const retainedRange = retainedRanges.sessions.find(
          (range): boolean => range.session_id === sessionCursor.session_id,
        );
        unavailable.push({
          session_id: sessionCursor.session_id,
          requested_after_sequence: sessionCursor.last_event_sequence,
          reason: retainedRange ? "cursor_outside_retention" : "no_retained_events",
          ...(retainedRange
            ? {
                retained_range: {
                  first_event_sequence: retainedRange.first_event_sequence,
                  last_event_sequence: retainedRange.last_event_sequence,
                },
              }
            : {}),
        });
        continue;
      }
      events.push(...replayed);
    }
    return { events, unavailable };
  }

  sessionSnapshot(commandId: string, sessionId: string): HcpSessionSnapshotPayload {
    const snapshot: HcpSessionSnapshotPayload | undefined = this.#stateStore.sessionSnapshot(commandId, sessionId);
    if (!snapshot) {
      throw new HarnessSessionError(
        "session_snapshot_unavailable",
        `Session '${sessionId}' has no retained events from which to build a snapshot.`,
      );
    }
    return snapshot;
  }

  conversationOperation(commandId: string, request: HcpConversationRequestPayload): Promise<HcpConversationResultPayload> {
    return this.#serializeWorkspace(async () => {
      if (request.operation.kind === "input_file") {
        const session = this.#sessions.get(request.session_id);
        if (!session) throw new HarnessAdapterError("input_file_owner_unavailable", "Input uploads require an active authorized HCP session.");
        await this.#assertWorkspaceAllowed(session.workspaceId, session.cwd);
        if (nativeProviderHash(this.#requireProvider(session.providerInstanceId, session.driverKind)) !== session.inputFileScope.provider_binding_hash)
          throw new HarnessAdapterError("input_file_binding_changed", "The original input-file provider identity changed.");
        return {command_id: commandId, session_id: request.session_id, operation: "input_file", filesystem_undo: false,
          input_file: this.#inputFileStore().operation(session.inputFileScope, commandId, request.operation)};
      }
      if (request.operation.kind === "feedback") return this.#nativeFeedbackOperation(commandId, request as HcpConversationRequestPayload & {operation: Extract<HcpConversationRequestPayload["operation"], {kind: "feedback"}>});
      if (request.operation.kind === "work") return this.#nativeWorkOperation(commandId, request as HcpConversationRequestPayload & {operation: Extract<HcpConversationRequestPayload["operation"], {kind: "work"}>});
      if (request.operation.kind === "content") {
        const scope = this.#contentStore.scope(request.session_id, request.operation.content_id);
        await this.#assertWorkspaceAllowed(scope.workspace_id, scope.cwd);
        if (nativeProviderHash(this.#requireProvider(scope.provider_instance_id)) !== scope.provider_binding_hash)
          throw new HarnessAdapterError("content_binding_changed", "Retained output belongs to the original provider identity.");
        return {command_id: commandId, session_id: request.session_id, operation: "content", filesystem_undo: false,
          content: this.#contentStore.read(request.session_id, request.operation.content_id, request.operation.offset, request.operation.limit)};
      }
      if (request.operation.kind === "steer") {
        const session = this.#sessions.get(request.session_id);
        const active = this.#activeTurnControls.get(request.session_id);
        if (!session || !active || active.turnId !== request.operation.turn_id || session.cancelRequested)
          throw new HarnessAdapterError("active_turn_unavailable", "Steering requires the exact active turn with a live native control.");
        await this.#assertWorkspaceAllowed(session.workspaceId, session.cwd);
        this.#requireProvider(session.providerInstanceId, session.driverKind);
        await active.controls.steer(request.operation.input);
        return {command_id: commandId, session_id: request.session_id, operation: "steer", turn_id: request.operation.turn_id, filesystem_undo: false};
      }
      const binding = this.#stateStore.nativeConversationForSession(request.session_id);
      const liveOwner = binding ? [...this.#sessions.values()].find(session => session.startPayload.continuation_group_key === binding.key) : undefined;
      if (!binding) throw new HarnessAdapterError("native_conversation_unavailable", "No durable native conversation binding exists for this session.");
      const {key, conversation} = binding;
      await this.#assertWorkspaceAllowed(conversation.workspace_id, conversation.cwd);
      const provider = this.#requireProvider(conversation.provider_instance_id);
      if (nativeProviderHash(provider) !== conversation.provider_binding_hash)
        throw new HarnessAdapterError("native_continuation_binding", "The native provider identity changed; retained history belongs to the original provider.");
      const injectionHash = request.operation.kind === "inject" ? createHash("sha256").update(JSON.stringify({session_id: request.session_id, kind: "inject",
        expected_history_hash: request.operation.expected_history_hash,
        messages: request.operation.messages.map(({role, content}) => ({role, content}))})).digest("hex") : undefined;
      const injectionReceipt = conversation.injections?.find(receipt => receipt.command_id === commandId);
      if (request.operation.kind === "inject" && injectionReceipt) {
        if (injectionReceipt.request_hash !== injectionHash) throw new HarnessAdapterError("command_conflict", "The original injection has different parameters.");
        if (injectionReceipt.phase === "completed" && injectionReceipt.result) return injectionReceipt.result;
      }
      if (liveOwner && (request.operation.kind !== "read" || !liveOwner.adapter.liveHistoryRead))
        throw new HarnessAdapterError("native_conversation_unavailable", "Live history requires explicit read support; conversation changes require an idle retained owner.");
      if (request.operation.kind !== "read" && Object.values(conversation.injections ?? {}).some(receipt => receipt.phase === "pending"))
        throw new HarnessAdapterError("native_injection_unknown", "An earlier context injection may have dispatched; automatic repetition or another mutation is forbidden.");
      if (request.operation.kind !== "read" && conversation.configuration_transitions?.some(receipt => receipt.phase === "pending"))
        throw new HarnessAdapterError("native_configuration_unknown", "A configuration transition requires reconciliation before another mutation or retirement.");
      if (request.operation.kind !== "read" && conversation.fork?.phase === "pending")
        throw new HarnessAdapterError("native_fork_unknown", "A prior native fork may have dispatched; automatic repetition, mutation and retirement require reconciliation.");
      if (request.operation.kind !== "read" && conversation.rollback?.phase === "pending" &&
          !(request.operation.kind === "rollback" && conversation.rollback.command_id === commandId))
        throw new HarnessAdapterError("native_rollback_unknown", "A prior rollback needs reconciliation before another mutation or retirement.");
      const retainedWork = this.#stateStore.nativeWorkState(conversation.last_session_id);
      if (request.operation.kind !== "read" && (retainedWork?.closure_unconfirmed || Object.values(retainedWork?.items ?? {}).some(work => !isNativeWorkTerminal(work.status))))
        throw new HarnessAdapterError("native_work_shutdown_unknown", "Native work closure is unconfirmed; retained conversation mutations require authoritative reconciliation.");
      if (request.operation.kind === "retire") {
        this.#stateStore.retireNativeConversation(key);
        this.#inputFileStore().retire({owner: `conversation:${key}`, provider_instance_id: conversation.provider_instance_id,
          provider_binding_hash: conversation.provider_binding_hash, workspace_id: conversation.workspace_id, cwd: conversation.cwd});
        return {command_id: commandId, session_id: request.session_id, operation: "retire", filesystem_undo: false};
      }
      const adapter = this.#adapterRegistry.require(provider.driver_kind);
      if (!adapter.conversationOperation || !adapter.conversationOperations?.includes(request.operation.kind))
        throw new HarnessAdapterError("conversation_operation_unsupported", `Provider '${provider.driver_kind}' does not support '${request.operation.kind}'.`);
      if (request.operation.kind === "inject" && (conversation.injections?.length ?? 0) >= 1024)
        throw new HarnessAdapterError("native_injection_receipt_limit", "Context injection receipts reached their bounded retention limit; begin an independent conversation.");
      if (request.operation.kind === "fork") {
        const prior = conversation.fork;
        if (prior?.command_id === commandId && prior.phase === "completed" && prior.result) {
          if (prior.request_hash !== createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(request.operation).sort(([a], [b]) => a.localeCompare(b))))).digest("hex"))
            throw new HarnessAdapterError("command_conflict", "The original fork has different parameters.");
          return prior.result;
        }
        if (prior?.phase === "pending")
          throw new HarnessAdapterError("native_fork_unknown", "A prior native fork may have dispatched; automatic repetition is forbidden.");
        if (request.operation.target_session_id === request.session_id || this.#stateStore.hasSessionEvents(request.operation.target_session_id) ||
            this.#stateStore.nativeConversationForSession(request.operation.target_session_id) ||
            this.#stateStore.getNativeConversation(request.operation.continuation_group_key))
          throw new HarnessAdapterError("fork_destination_exists", "Fork requires a fresh session identity and conversation key.");
      }
      let forkStarted = false;
      let injectionStarted = false;
      const result = hcpConversationResultPayloadSchema.parse(await adapter.conversationOperation({
        commandId, request, conversation: structuredClone(conversation), provider,
        publishContent: value => this.#contentStore.publish({session_id: request.session_id, provider_instance_id: provider.id,
          provider_binding_hash: nativeProviderHash(provider), workspace_id: conversation.workspace_id, cwd: conversation.cwd}, value),
        ...(request.operation.kind === "fork" ? {beginMutation: () => {
          if (request.operation.kind !== "fork" || forkStarted)
            throw new HarnessAdapterError("native_fork_unknown", "Native fork dispatch can be fenced only once.");
          forkStarted = true;
          this.#stateStore.saveNativeConversation(key, {...conversation, fork: {command_id: commandId,
            request_hash: createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(request.operation).sort(([a], [b]) => a.localeCompare(b))))).digest("hex"),
            target_key: request.operation.continuation_group_key, target_session_id: request.operation.target_session_id, phase: "pending"}});
          this.#inputFileStore().fork({owner: `conversation:${key}`, provider_instance_id: conversation.provider_instance_id,
            provider_binding_hash: conversation.provider_binding_hash, workspace_id: conversation.workspace_id, cwd: conversation.cwd},
            `conversation:${request.operation.continuation_group_key}`);
        }} : request.operation.kind === "inject" ? {beginMutation: () => {
          if (injectionStarted) throw new HarnessAdapterError("native_injection_unknown", "Context injection dispatch can be fenced only once.");
          injectionStarted = true;
          this.#stateStore.saveNativeConversation(key, {...conversation, injections: [...(conversation.injections ?? []),
            {command_id: commandId, request_hash: injectionHash!, phase: "pending"}]});
          const persisted = this.#stateStore.getNativeConversation(key)?.injections?.find(receipt => receipt.command_id === commandId);
          if (persisted?.phase !== "pending" || persisted.request_hash !== injectionHash)
            throw new HarnessAdapterError("native_mutation_fence_missing", "The context injection dispatch fence was not retained; native dispatch is forbidden.");
        }} : {}),
        save: updated => {
          if (request.operation.kind === "fork" || request.operation.kind === "inject") throw new HarnessAdapterError("native_history_binding", "Mutation dispatch state is owned by the runner's fence.");
          // Native mutation evidence cannot change the authorized conversation's identity or scope.
          const {rollback: _priorRollback, updated_at: _priorTime, ...original} = conversation;
          const {rollback: _nextRollback, updated_at: _nextTime, ...next} = updated;
          if (!isDeepStrictEqual(original, next))
            throw new HarnessAdapterError("native_history_binding", "An adapter cannot replace the retained conversation binding.");
          this.#stateStore.saveNativeConversation(key, updated);
        },
      }));
      if (result.command_id !== commandId || result.session_id !== request.session_id || result.operation !== request.operation.kind)
        throw new HarnessAdapterError("native_history_binding", "Conversation result targets another command, session, or operation.");
      if (request.operation.kind === "inject") {
        if (!injectionStarted || !result.injection || result.injection.outcome === "applied" && result.injection.message_count !== request.operation.messages.length)
          throw new HarnessAdapterError("native_injection_unknown", "Context injection did not confirm its fenced request.");
        this.#stateStore.saveNativeConversation(key, {...conversation, injections: [...(conversation.injections ?? []),
          {command_id: commandId, request_hash: injectionHash!, phase: "completed", result}]});
      }
      if (adapter.portableHistory && result.history?.turns.some(turn => turn.portable_fidelity === undefined || turn.portable_items === undefined && turn.portable_items_ref === undefined))
        throw new HarnessAdapterError("portable_history_missing", "This adapter did not supply its declared portable history contract.");
      if (request.operation.kind === "rollback" && result.native_reference) {
        const saved = this.#stateStore.getNativeConversation(key)!;
        if (saved.rollback?.command_id !== commandId || saved.rollback.phase !== "completed" ||
            saved.rollback.replacement_native_thread_id !== result.native_reference || saved.rollback.target_hash !== result.history?.history_hash ||
            saved.rollback.native_fresh !== result.native_fresh)
          throw new HarnessAdapterError("native_rollback_unknown", "A replacement conversation requires matching durable rollback evidence.");
        const {fresh: _priorFresh, ...original} = saved;
        this.#stateStore.saveNativeConversation(key, {...original, native_thread_id: result.native_reference,
          ...(result.native_fresh ? {fresh: true} : {}), updated_at: new Date().toISOString()});
      }
      if (request.operation.kind === "fork") {
        const target = result.fork;
        if (!forkStarted || !target || target.session_id !== request.operation.target_session_id || target.continuation_group_key !== request.operation.continuation_group_key ||
            target.native_reference === conversation.native_thread_id)
          throw new HarnessAdapterError("native_history_binding", "Native fork did not confirm an independent destination.");
        const {rollback: _rollback, fork: _fork, injections: _injections, configuration_transitions: _transitions,
          feedback_submissions: _feedback, ...bindingFields} = conversation;
        this.#stateStore.saveNativeConversation(target.continuation_group_key, {...bindingFields, ...(result.native_fresh ? {fresh: true} : {}), native_thread_id: target.native_reference,
          last_session_id: target.session_id, updated_at: new Date().toISOString()});
        this.#stateStore.saveNativeConversation(key, {...conversation, fork: {command_id: commandId, target_key: target.continuation_group_key,
          request_hash: createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(request.operation).sort(([a], [b]) => a.localeCompare(b))))).digest("hex"),
          target_session_id: target.session_id, phase: "completed", result}});
      }
      return result;
    });
  }

  async resolveLocalActionContext(payload: LocalActionRequestPayload): Promise<LocalCapabilityExecutionContext> {
    const session: HarnessSession | undefined = this.#sessions.get(payload.attribution.session_id);
    if (!session) {
      throw new LocalCapabilityPolicyError(
        "local_capability_lease_missing",
        `Session '${payload.attribution.session_id}' does not have an active local capability lease.`,
      );
    }

    if (session.workspaceId !== payload.attribution.workspace_id) {
      throw new LocalCapabilityPolicyError(
        "local_capability_workspace_mismatch",
        `Local action workspace '${payload.attribution.workspace_id}' does not match active session workspace '${session.workspaceId}'.`,
      );
    }
    if (session.providerInstanceId !== payload.attribution.provider_instance_id) {
      throw new LocalCapabilityPolicyError(
        "local_capability_provider_mismatch",
        `Local action provider '${payload.attribution.provider_instance_id}' does not match active session provider '${session.providerInstanceId}'.`,
      );
    }

    const lease: LocalCapabilityLease | undefined = session.localCapabilityLease;
    if (!lease) {
      throw new LocalCapabilityPolicyError(
        "local_capability_lease_missing",
        `Session '${session.sessionId}' was not started with a local capability lease.`,
      );
    }
    assertRequestLeaseMatchesActiveLease(payload, lease);

    const workspaceRoot: string = this.#requireWorkspaceRoot(session.workspaceId);
    await assertSandboxMatchesSession(payload, session, workspaceRoot);
    return {
      session_id: session.sessionId,
      turn_id: payload.attribution.turn_id,
      workspace_id: session.workspaceId,
      provider_instance_id: session.providerInstanceId,
      workspace_root: workspaceRoot,
      sandbox_mode: session.startPayload.sandbox_mode,
      lease,
    };
  }

  recordLocalActionEvents(
    sessionId: string,
    turnId: string,
    events: LocalCapabilityExecutionEvent[],
  ): HcpHarnessEventPayload[] {
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      throw new LocalCapabilityPolicyError("local_capability_lease_missing", `Session '${sessionId}' is not active.`);
    }
    return events.map((event: LocalCapabilityExecutionEvent): HcpHarnessEventPayload =>
      this.#event(sessionId, turnId, event.event_type, event.data),
    );
  }

  startSession(payload: HcpSessionStartPayload): Promise<HcpHarnessEventPayload[]> {
    if (this.#startingSessions.has(payload.session_id)) {
      throw new HarnessSessionError("session_exists", "Session startup is already in progress.");
    }
    const startup = { cancelled: false, ...(payload.first_turn ? {firstTurnId: payload.first_turn.turn_id} : {}) };
    this.#startingSessions.set(payload.session_id, startup);
    return this.#serializeWorkspace(async () => {
      try {
        if (payload.first_turn && Date.parse(payload.first_turn.not_after) <= Date.now()) {
          throw new HarnessSessionError("startup_expired", "First-turn authorization expired before session startup.");
        }
        const events = await this.#startSession(payload);
        if (startup.cancelled && payload.first_turn) {
          const session = this.#sessions.get(payload.session_id)!;
          session.cancelRequested = true;
        }
        return events;
      } finally {
        this.#startingSessions.delete(payload.session_id);
      }
    });
  }

  /** Called locally after session initialization, before acknowledging the one startup command. */
  sendFirstTurn(payload: HcpSessionStartPayload, onEvent: (event: HcpHarnessEventPayload) => void): Promise<HcpHarnessEventPayload[]> {
    const first = payload.first_turn;
    if (!first) throw new HarnessSessionError("first_turn_missing", "Combined startup needs an admitted first turn.");
    const session = this.#sessions.get(payload.session_id);
    if (!session) {
      if (this.#stateStore.hasSessionExit(payload.session_id)) return Promise.resolve([]);
      throw new HarnessSessionError("session_not_found", "Session startup did not finish.");
    }
    if (session.cancelRequested || Date.parse(first.not_after) <= Date.now()) {
      const cancelled = this.#event(payload.session_id, first.turn_id, "turn.cancelled", {
        status: "cancelled", final_output: {exit_reason: session.cancelRequested ? "cancel_requested" : "authorization_expired"},
      });
      onEvent(cancelled);
      return this.stopSession(payload.session_id, "Combined startup cancelled before turn dispatch");
    }
    return this.sendTurn({session_id: payload.session_id, turn_id: first.turn_id, input: first.input, ...(first.mode ? {mode: first.mode} : {}), ...(first.images ? {images: first.images} : {}), ...(first.files ? {files: first.files} : {}), ...(first.context ? {context: first.context} : {})}, onEvent);
  }

  async #startSession(payload: HcpSessionStartPayload): Promise<HcpHarnessEventPayload[]> {
    if (payload.workspace_preflight !== undefined) {
      throw new HarnessSessionError("preflight_unsupported", "Workspace preflight expectations are not implemented by this runner.");
    }
    if (this.#sessions.has(payload.session_id) || this.#stateStore.hasSessionEvents(payload.session_id)) {
      throw new HarnessSessionError("session_exists", `Session '${payload.session_id}' already exists.`);
    }

    let prepared: {session: HarnessSession; discoveredTools: HarnessMcpToolDiscovery[]; activateEvents: () => HcpHarnessEventPayload[]};
    try {
      prepared = await this.#prepareSession(payload);
    } catch (error: unknown) {
      if (error instanceof SessionStartCleanedError) {
        this.#event(payload.session_id, undefined, "session.exited", {
          provider_instance_id: payload.provider_instance_id, reason: error.reason,
        });
        throw error.originalError;
      }
      throw error;
    }
    const {session, discoveredTools} = prepared;
    const localCapabilityLease = session.localCapabilityLease;
    const provider = this.#requireProvider(session.providerInstanceId, session.driverKind);
    const configuredAdapter = this.#adapterRegistry.require(provider.driver_kind);
    const configuredInheritance = validateConfigurationInheritance(payload, configuredAdapter.configurationInheritance, configuredAdapter.configurationInheritanceOptions);
    this.#sessions.set(payload.session_id, session);
    this.#turnIdsBySession.set(payload.session_id, new Set<string>());
    const events: HcpHarnessEventPayload[] = [
      this.#event(payload.session_id, undefined, "session.started", {
        provider_instance_id: provider.id,
        driver_kind: provider.driver_kind,
        workspace_id: payload.workspace_id,
        cwd: payload.cwd,
        sandbox_mode: payload.sandbox_mode,
      }),
      this.#event(payload.session_id, undefined, "workspace.preflight.completed", {
        workspace_id: payload.workspace_id,
        cwd: payload.cwd,
        result: "passed",
      }),
      this.#event(payload.session_id, undefined, "session.configured", {
        ...(session.adapterSession.native_policy_readback ? {native_policy_readback: session.adapterSession.native_policy_readback} : {}),
        execution_profile: payload.execution_profile ?? "isolated",
        ...(configuredAdapter.emptyConversation || configuredAdapter.executionProfiles?.find(profile => profile.id === (payload.execution_profile ?? "isolated"))?.empty_conversation
          ? {native_conversation_ready: true} : {}),
        ...(configuredInheritance ? {configuration_inheritance: configuredInheritance} : {}),
        model_selection: payload.model_selection,
        mcp_server_count: payload.mcp_servers.length,
        local_capabilities: localCapabilityLease?.capabilities.map((capability) => capability.id) ?? [],
      }),
    ];
    events.push(...prepared.activateEvents());

    if (localCapabilityLease) {
      events.push(
        this.#event(payload.session_id, undefined, "local_capability.lease.created", {
          lease_id: localCapabilityLease.lease_id,
          workspace_id: localCapabilityLease.workspace_id,
          provider_instance_id: localCapabilityLease.provider_instance_id,
          status: "started",
        }),
      );
    }
    for (const attachment of payload.mcp_servers) {
      events.push(
        this.#event(payload.session_id, undefined, "mcp.status.updated", {
          attachment: attachment.name,
          status: "connected",
        }),
      );
    }
    for (const discovery of discoveredTools) {
      events.push(
        this.#event(payload.session_id, undefined, "mcp.status.updated", {
          attachment: discovery.attachmentName,
          status: "tools_discovered",
          message: `allowed tools: ${discovery.tools.map((tool: McpToolDescriptor): string => tool.name).join(", ")}`,
        }),
      );
    }

    await this.#recordAudit({
      event: "session.started",
      session_id: payload.session_id,
      provider_instance_id: provider.id,
      workspace_id: payload.workspace_id,
      data: {
        driver_kind: provider.driver_kind,
        cwd: payload.cwd,
        sandbox_mode: payload.sandbox_mode,
        approval_policy: payload.approval_policy,
        mcp_servers: payload.mcp_servers.map((attachment: McpServerAttachment): string => attachment.name),
        local_capabilities: localCapabilityLease?.capabilities.map((capability) => capability.id) ?? [],
      },
    });

    return events;
  }

  async #prepareSession(payload: HcpSessionStartPayload): Promise<{session: HarnessSession; discoveredTools: HarnessMcpToolDiscovery[]; activateEvents: () => HcpHarnessEventPayload[]}> {
    if (payload.conversation_transition && (!payload.continue_session || !payload.continuation_group_key || payload.first_turn))
      throw new HarnessAdapterError("native_configuration_transition_invalid", "A transition requires explicit continuation without a model turn.");
    const provider: ProviderInstanceConfig = this.#requireProvider(payload.provider_instance_id, payload.driver_kind);
    await this.#assertWorkspaceAllowed(payload.workspace_id, payload.cwd);
    payload = {...payload, cwd: await realpath(payload.cwd)};
    const localCapabilityLease: LocalCapabilityLease | undefined = this.#localCapabilities.validateSessionLease(
      payload,
      provider,
    );
    const adapter: HarnessAdapter = this.#adapterRegistry.require(provider.driver_kind);
    const profile = adapter.executionProfiles?.find(profile => profile.id === (payload.execution_profile ?? "isolated"));
    if (payload.conversation_transition && !profile?.idle_configuration_transition)
      throw new HarnessAdapterError("native_configuration_transition_unsupported", "The target execution profile does not declare confirmed idle configuration replacement.");
    if (payload.execution_profile && !profile)
      throw new HarnessAdapterError("execution_profile_unsupported", "This adapter has not declared the selected execution profile.");
    if (profile?.native_work && (!adapter.nativeWork || !adapter.sessionEvents || !adapter.cancelNativeWork
      || profile.runtime_lifetime !== "session" || !profile.session_events))
      throw new HarnessAdapterError("execution_profile_contract_invalid", "Native work requires a retained runtime, observations and cancellation controls.");
    if (profile?.required_configuration_inheritance && Object.entries(profile.required_configuration_inheritance)
      .some(([key,value]) => payload.configuration_inheritance?.[key as keyof typeof profile.required_configuration_inheritance] !== value))
      throw new HarnessAdapterError("execution_profile_configuration_required", "The selected profile requires its advertised explicit configuration inheritance.");
    if (profile?.mcp_attachments === false && payload.mcp_servers.length)
      throw new HarnessAdapterError("execution_profile_mcp_unsupported", "The selected profile does not support MCP attachments.");
    const configuredInheritance = validateConfigurationInheritance(payload, adapter.configurationInheritance, adapter.configurationInheritanceOptions);
    validateInstructionRoles(payload, adapter.instructionRoles);
    await adapter.validateStart({ payload, provider });
    if (payload.continuation_group_key && [...this.#sessions.values()].some(session => session.startPayload.continuation_group_key === payload.continuation_group_key))
      throw new HarnessAdapterError("native_conversation_busy", "This native conversation already has an active session.");
    const mcpAttachments: HarnessMcpAttachmentResult = await this.#attachMcpServers(payload, provider);
    const adapterStartPayload: HcpSessionStartPayload = payload;
    const eventProviderHash = nativeProviderHash(provider);
    const bufferedEvents: HarnessAdapterEvent[] = [];
    let eventsActive = false;
    let eventsClosed = false;
    let eventOwner: HarnessSession | undefined;
    const emitSessionEvent = (event: HarnessAdapterEvent): void => {
      if (eventsClosed || (eventsActive && this.#sessions.get(payload.session_id) !== eventOwner))
        throw new HarnessAdapterError("native_session_event_closed", "The native event owner is no longer active.");
      if (nativeProviderHash(this.#requireProvider(provider.id)) !== eventProviderHash)
        throw new HarnessAdapterError("native_session_event_binding", "Native observations belong to the original provider configuration.");
      const interaction = ["approval.requested", "approval.resolved", "user_input.requested", "user_input.resolved", "native.request.lost"].includes(event.event_type);
      const sessionInput = interaction && event.data.request_scope === "session"
        && ["user_input.requested", "user_input.resolved", "native.request.lost"].includes(event.event_type);
      if (interaction && event.data.native_work_id !== undefined) {
        const workId = event.data.native_work_id;
        const state = this.#stateStore.nativeWorkState(payload.session_id);
        const work = typeof workId === "string" ? state?.items[workId] ?? state?.retired[workId] : undefined;
        if (!work || !adapter.nativeWork || work.origin_turn_id !== event.turn_id
          || ["approval.requested", "user_input.requested"].includes(event.event_type)
            && (isNativeWorkTerminal(work.status) || eventOwner?.nativeWorkOwnerAvailable === false))
          throw new HarnessAdapterError("native_work_request_binding", "Native work callbacks require their confirmed live work and original root origin.");
      }
      if (interaction && ((sessionInput ? event.turn_id !== undefined || event.data.turn_id !== undefined :
          !event.turn_id || !this.#turnIdsBySession.get(payload.session_id)?.has(event.turn_id) || event.data.turn_id !== event.turn_id)
          || event.data.session_id !== payload.session_id
          || typeof event.data.request_id !== "string" || !this.#sessionInteractions.get(payload.session_id)?.owns(event.data.request_id)))
        throw new HarnessAdapterError("native_session_request_binding", "Session interactions require an admitted origin and their registered native request owner.");
      if (event.event_type === "account.rate_limits.updated" && (
        adapter.executionProfiles?.find(profile => profile.id === payload.execution_profile)?.account_limit_observations !== "native_session"
        || event.data.provider_instance_id !== provider.id || !event.data.observation || !eventOwner?.adapterSession.native_thread_id))
        throw new HarnessAdapterError("native_account_observation_binding", "Native quota observations require their declared initialized provider session owner.");
      if (event.event_type === "native.output.updated" && (
        adapter.executionProfiles?.find(profile => profile.id === payload.execution_profile)?.native_async_output !== "session"
        || !eventOwner?.adapterSession.native_thread_id || eventOwner.nativeWorkOwnerAvailable === false))
        throw new HarnessAdapterError("native_output_owner_unavailable", "Asynchronous native output requires its declared initialized live session owner.");
      if (!interaction && (event.turn_id || !["runtime.warning", "runtime.error", "config.warning", "deprecation.notice", "native.work.updated", "native.work.owner_lost", "account.rate_limits.updated", "native.output.updated"].includes(event.event_type)
          && !event.event_type.startsWith("provider.") && !event.event_type.startsWith("extension."))
        )
        throw new HarnessAdapterError("native_session_event_unsupported", "Session observations cannot publish root turns or interaction requests.");
      let validationData = event.data;
      if (event.event_type === "native.work.owner_lost" && !adapter.nativeWork)
        throw new HarnessAdapterError("native_work_unsupported", "Native owner loss requires its declared adapter contract.");
      if (event.event_type === "native.work.updated") {
        if (!adapter.nativeWork || Object.keys(event.data).some(key => key !== "work"))
          throw new HarnessAdapterError("native_work_unsupported", "Native work requires its declared adapter contract.");
        const work = harnessNativeWorkObservationSchema.parse(event.data.work);
        const workState = this.#stateStore.nativeWorkState(payload.session_id);
        const current = workState?.items[work.work_id];
        if (current && JSON.stringify(harnessNativeWorkObservationSchema.parse(Object.fromEntries(Object.entries(current).filter(([key]) => key !== "revision" && key !== "control")))) === JSON.stringify(work)) return;
        const retired = workState?.retired[work.work_id];
        if (retired && isNativeWorkTerminal(work.status) && retired.native_reference === work.native_reference
            && retired.origin_turn_id === work.origin_turn_id && retired.parent_work_id === work.parent_work_id && retired.kind === work.kind) return;
        validationData = {work: {...work, revision: 1}};
      }
      const validated = hcpHarnessEventPayloadSchema.parse({session_id: payload.session_id, sequence: 1,
        event_type: event.event_type, created_at: new Date().toISOString(), data: validationData});
      if (Buffer.byteLength(JSON.stringify(validated.data)) > 64 * 1024)
        throw new HarnessAdapterError("native_session_event_limit", "Session observations require bounded data or a retained-content reference.");
      event = {event_type: validated.event_type, ...(event.turn_id ? {turn_id: event.turn_id} : {}), data: structuredClone(event.data)};
      if (!eventsActive) {
        if (bufferedEvents.length >= 128) throw new HarnessAdapterError("native_session_event_limit", "Native startup observations exceeded their bounded buffer.");
        bufferedEvents.push(structuredClone(event));
      } else this.#event(payload.session_id, event.turn_id, event.event_type, event.data);
    };

    let adapterSession: HarnessAdapterSession;
    let createdWorkState = false;
    try {
      if (!adapter.durableMcpContinuation && mcpAttachments.toolsets.some(set => set.tools.some(tool => tool.review_policy))) {
        throw new HarnessAdapterError("mcp_review_unavailable", "This adapter does not support durable MCP review.");
      }
      let retainedConversation: import("../state/index.js").NativeConversation | undefined;
      if (payload.continue_session) {
        const conversation = this.#stateStore.getNativeConversation(payload.continuation_group_key!);
        if (!conversation || conversation.provider_binding_hash !== eventProviderHash || conversation.provider_instance_id !== provider.id
          || conversation.workspace_id !== payload.workspace_id || conversation.cwd !== payload.cwd)
          throw new HarnessAdapterError("native_continuation_binding", "The original provider and canonical workspace must own this continuation.");
        if (conversation.configuration_transitions?.some(receipt => receipt.phase === "pending"))
          throw new HarnessAdapterError("native_configuration_unknown", "A prior configuration transition has no confirmed outcome; it cannot be repeated by starting another owner.");
        if (conversation.configuration_base_hash && conversation.configuration_base_hash !== nativeConfigurationBaseHash(payload, provider, mcpAttachments.toolsets, configuredInheritance))
          throw new HarnessAdapterError("native_configuration_transition_binding", "Retained instructions, inheritance, tools and local authority must remain in the original configuration scope.");
        if (!payload.conversation_transition && conversation.binding_hash !== nativeBindingHash(payload, provider, mcpAttachments.toolsets))
          throw new HarnessAdapterError("native_continuation_binding", "Native conversation is missing or its workspace, provider, tools, instructions, or policy changed.");
        if (conversation.rollback?.phase === "pending") throw new HarnessAdapterError("native_rollback_unknown", "The previous rollback needs reconciliation; starting another turn is unsafe.");
        if (conversation.fork?.phase === "pending") throw new HarnessAdapterError("native_fork_unknown", "A previous fork has an unknown outcome; reconcile it before resuming.");
        if (Object.values(conversation.injections ?? {}).some(receipt => receipt.phase === "pending"))
          throw new HarnessAdapterError("native_injection_unknown", "An earlier context injection has an unknown outcome; resuming cannot redeliver it.");
        const priorWork = this.#stateStore.nativeWorkState(conversation.last_session_id);
        if (priorWork?.closure_unconfirmed || Object.values(priorWork?.items ?? {}).some(work => !isNativeWorkTerminal(work.status)))
          throw new HarnessAdapterError("native_work_shutdown_unknown", "Earlier native work has unconfirmed closure; resuming cannot reclaim its execution owner.");
        retainedConversation = conversation;
        if (payload.conversation_transition) {
          const transition = payload.conversation_transition;
          if (!payload.continuation_group_key || payload.first_turn || !profile?.idle_configuration_transition
            || !adapter.liveHistoryRead || !adapter.conversationOperation || !adapter.conversationOperations?.includes("read"))
            throw new HarnessAdapterError("native_configuration_transition_unsupported", "An explicit no-model transition requires a declared confirmed native continuation owner.");
          if (this.#lastSavedEvent(conversation.last_session_id)?.event_type !== "session.exited")
            throw new HarnessAdapterError("native_configuration_transition_busy", "The original execution lease must confirm shutdown before configuration replacement.");
          const base = nativeConfigurationBaseHash(payload, provider, mcpAttachments.toolsets, configuredInheritance);
          if (!conversation.configuration_base_hash || conversation.configuration_base_hash !== base)
            throw new HarnessAdapterError("native_configuration_transition_binding", "Only policy and execution profile may change; retain the verified provider, workspace, instructions, inheritance and tools.");
          if (conversation.configuration_transitions?.some(receipt => receipt.transition_id === transition.transition_id))
            throw new HarnessAdapterError("native_configuration_transition_exists", "This transition identity is already retained; inspect its target instead of repeating startup.");
          if ((conversation.configuration_transitions?.length ?? 0) >= 1024)
            throw new HarnessAdapterError("native_configuration_transition_limit", "The conversation reached its bounded transition receipt limit.");
          const source = await adapter.conversationOperation({commandId: transition.transition_id,
            request: {session_id: conversation.last_session_id, operation: {kind: "read"}}, conversation: structuredClone(conversation), provider,
            save: () => {throw new HarnessAdapterError("native_history_read_only", "Transition preflight cannot mutate history.");}});
          if (source.history?.history_hash !== transition.expected_history_hash)
            throw new HarnessAdapterError("native_history_changed", "Read current native history before changing the execution configuration.");
          retainedConversation = {...conversation, configuration_transitions: [...(conversation.configuration_transitions ?? []), {
            transition_id: transition.transition_id, source_binding_hash: conversation.binding_hash,
            target_binding_hash: nativeBindingHash(payload, provider, mcpAttachments.toolsets), expected_history_hash: transition.expected_history_hash,
            target_session_id: payload.session_id, phase: "pending"}]};
          this.#stateStore.saveNativeConversation(payload.continuation_group_key, retainedConversation);
          const fenced = this.#stateStore.getNativeConversation(payload.continuation_group_key)?.configuration_transitions?.at(-1);
          if (fenced?.phase !== "pending" || fenced.transition_id !== transition.transition_id || fenced.target_session_id !== payload.session_id)
            throw new HarnessAdapterError("native_configuration_fence_missing", "The configuration dispatch fence was not retained.");
        }
      } else if (payload.continuation_group_key && this.#stateStore.getNativeConversation(payload.continuation_group_key)) {
        throw new HarnessAdapterError("native_continuation_exists", "An existing native conversation requires explicit continuation.");
      }
      if (adapter.nativeWork && (!adapter.executionProfiles || profile?.native_work)) {
        createdWorkState = !this.#stateStore.nativeWorkState(payload.session_id);
        const existing = this.#stateStore.nativeWorkState(payload.session_id);
        if (existing?.closure_unconfirmed) throw new HarnessAdapterError("native_work_shutdown_unknown", "Earlier native work has unconfirmed closure; restarting cannot reclaim its execution owner.");
        this.#stateStore.saveNativeWorkState(payload.session_id, {scope: {provider_instance_id: provider.id, provider_binding_hash: eventProviderHash,
          workspace_id: payload.workspace_id, cwd: payload.cwd, execution_binding_hash: nativeBindingHash(payload, provider, mcpAttachments.toolsets)},
          items: existing?.items ?? {}, retired: existing?.retired ?? {}});
      }
      adapterSession = await adapter.startSession({
        payload: adapterStartPayload,
        provider,
        mcpServers: mcpAttachments.adapterAttachments,
        mcpToolsets: mcpAttachments.toolsets,
        ...(adapter.sessionEvents ? {emitSessionEvent} : {}),
        ...(adapter.sessionEvents ? {registerSessionInteractions: (owner: HarnessNativeInteractions | undefined) => {
          if (eventsClosed || eventsActive && this.#sessions.get(payload.session_id) !== eventOwner)
            throw new HarnessAdapterError("native_session_event_closed", "The native interaction owner is no longer active.");
          if (owner && eventsActive && eventOwner?.nativeWorkOwnerAvailable === false)
            throw new HarnessAdapterError("native_owner_unavailable", "A lost native owner cannot register replacement callbacks.");
          if (owner && nativeProviderHash(this.#requireProvider(provider.id)) !== eventProviderHash)
            throw new HarnessAdapterError("native_session_event_binding", "Native interactions belong to the original provider configuration.");
          if (owner) this.#sessionInteractions.set(payload.session_id, owner);
          else this.#sessionInteractions.delete(payload.session_id);
        }} : {}),
        publishContent: value => this.#contentStore.publish({session_id: payload.session_id, provider_instance_id: provider.id,
          provider_binding_hash: eventProviderHash, workspace_id: payload.workspace_id, cwd: payload.cwd}, value),
        ...(retainedConversation ? {nativeConversation: structuredClone(retainedConversation)} : {}),
      });
      if (retainedConversation) {
        if (adapterSession.native_thread_id && adapterSession.native_thread_id !== retainedConversation.native_thread_id)
          throw new HarnessAdapterError("native_continuation_binding", "The adapter resumed another native conversation.");
        adapterSession.native_thread_id = retainedConversation.native_thread_id;
        if (retainedConversation.fresh) adapterSession.native_fresh = true;
      }
      if (adapterSession.native_policy_readback) {
        const observed = harnessNativePolicyReadbackSchema.parse(adapterSession.native_policy_readback);
        if (observed.approval_policy !== payload.approval_policy || observed.sandbox_mode !== payload.sandbox_mode
          || observed.execution_profile !== (payload.execution_profile ?? "isolated"))
          throw new HarnessAdapterError("native_policy_unconfirmed", "Native startup policy differs from the authorized execution configuration.");
      }
      if (payload.conversation_transition) {
        if (!adapterSession.native_policy_readback || !retainedConversation || !adapter.conversationOperation)
          throw new HarnessAdapterError("native_policy_unconfirmed", "The transition has no effective native policy evidence.");
        const verified = await adapter.conversationOperation({commandId: payload.conversation_transition.transition_id,
          request: {session_id: payload.session_id, operation: {kind: "read"}},
          conversation: structuredClone({...retainedConversation, approval_policy: adapterSession.native_policy_readback.approval_policy}), provider,
          save: () => {throw new HarnessAdapterError("native_history_read_only", "Transition verification cannot mutate history.");}});
        if (verified.history?.history_hash !== payload.conversation_transition.expected_history_hash)
          throw new HarnessAdapterError("native_configuration_history_unknown", "The resumed native owner did not preserve the selected conversation history.");
        retainedConversation = {...retainedConversation, configuration_transitions: retainedConversation.configuration_transitions!.map(receipt =>
          receipt.transition_id === payload.conversation_transition!.transition_id ? {...receipt, phase: "completed" as const} : receipt)};
      }
      // A lazy resumed owner can retain its already verified conversation mapping
      // before the next prompt. This does not certify a fresh empty conversation
      // or effective root settings; those remain separate adapter proofs.
      if (adapter.emptyConversation || profile?.empty_conversation || payload.conversation_transition
        || retainedConversation && adapterSession.native_thread_id === retainedConversation.native_thread_id) {
        if (!adapterSession.native_thread_id)
          throw new HarnessAdapterError("native_conversation_unconfirmed", "The adapter did not establish its advertised empty native conversation.");
        if (payload.continuation_group_key) {
          const binding = {...(retainedConversation ?? {}), native_thread_id: adapterSession.native_thread_id,
            configuration_base_hash: nativeConfigurationBaseHash(payload, provider, mcpAttachments.toolsets, configuredInheritance),
            binding_hash: nativeBindingHash(payload, provider, mcpAttachments.toolsets), updated_at: new Date().toISOString(),
            approval_policy: payload.approval_policy, last_session_id: payload.session_id, provider_instance_id: provider.id,
            workspace_id: payload.workspace_id, cwd: payload.cwd, provider_binding_hash: eventProviderHash};
          this.#stateStore.saveNativeConversation(payload.continuation_group_key, binding);
          const persisted = this.#stateStore.getNativeConversation(payload.continuation_group_key);
          if (persisted?.native_thread_id !== binding.native_thread_id || persisted.binding_hash !== binding.binding_hash ||
            persisted.last_session_id !== payload.session_id || persisted.configuration_base_hash !== binding.configuration_base_hash
            || payload.conversation_transition && (persisted.configuration_transitions?.at(-1)?.phase !== "completed"
              || persisted.configuration_transitions.at(-1)?.transition_id !== payload.conversation_transition.transition_id))
            throw new HarnessAdapterError("native_conversation_fence_missing", "The empty native conversation binding was not retained.");
        }
      }
    } catch (error: unknown) {
      eventsClosed = true;
      this.#sessionInteractions.delete(payload.session_id);
      await cleanupAdapterSessionStartFailure(adapter, payload.session_id, mcpAttachments.clients, "adapter_start_failed", error);
      if (createdWorkState) this.#stateStore.removeEmptyNativeWorkState(payload.session_id);
      throw new SessionStartCleanedError(error, "adapter_start_failed");
    }

    const session: HarnessSession = {
      inputFileScope: {owner: payload.continuation_group_key ? `conversation:${payload.continuation_group_key}` : `session:${payload.session_id}`,
        provider_instance_id: provider.id, provider_binding_hash: nativeProviderHash(provider), workspace_id: payload.workspace_id, cwd: payload.cwd},
      sessionId: payload.session_id,
      cancelRequested: false,
      ...(adapter.nativeWork && (!adapter.executionProfiles || profile?.native_work) ? {nativeWorkOwnerAvailable: true} : {}),
      workspaceId: payload.workspace_id,
      providerInstanceId: provider.id,
      driverKind: provider.driver_kind,
      cwd: payload.cwd,
      startPayload: adapterStartPayload,
      adapter,
      adapterSession,
      ...(localCapabilityLease ? { localCapabilityLease } : {}),
      mcpClients: mcpAttachments.clients,
      mcpServers: mcpAttachments.adapterAttachments,
      mcpToolsets: mcpAttachments.toolsets,
      ...(payload.continuation_group_key ? {nativeBindingHash: nativeBindingHash(payload, provider, mcpAttachments.toolsets)} : {}),
    };
    if (adapter.nativeWork) this.#liveNativeWork.set(payload.session_id, new Set());
    return {session, discoveredTools: mcpAttachments.discoveredTools, activateEvents: () => {
      eventOwner = session;
      eventsActive = true;
      const events = bufferedEvents.map(event => this.#event(payload.session_id, event.turn_id, event.event_type, event.data));
      bufferedEvents.length = 0;
      return events;
    }};
  }

  sendTurn(
    payload: HcpTurnSendPayload,
    onEvent?: (event: HcpHarnessEventPayload) => void,
  ): Promise<HcpHarnessEventPayload[]> {
    const session: HarnessSession | undefined = this.#sessions.get(payload.session_id);
    if (!session) {
      throw new HarnessSessionError("session_not_found", `Session '${payload.session_id}' is not active.`);
    }

    const turnIds: Set<string> = this.#turnIdsBySession.get(payload.session_id) ?? new Set<string>();
    if (this.#runningTurns.has(payload.session_id))
      throw new HarnessSessionError("turn_in_progress", "This session already has an admitted root turn.");
    if (turnIds.has(payload.turn_id)) {
      throw new HarnessSessionError(
        "turn_exists",
        `Turn '${payload.turn_id}' already exists in session '${payload.session_id}'.`,
      );
    }
    session.cancelRequested = false;
    turnIds.add(payload.turn_id);
    this.#turnIdsBySession.set(payload.session_id, turnIds);
    return this.#runTurn(payload, session, onEvent);
  }

  async respondToMcpReview(response: HcpApprovalResponsePayload, onEvent: (event: HcpHarnessEventPayload) => void): Promise<
    {kind: "live"} | {kind: "resumed"; completion: Promise<HcpHarnessEventPayload[]>}
  > {
    const native = [this.#nativeInteractions.get(response.session_id), this.#sessionInteractions.get(response.session_id)].find(owner => owner?.owns(response.request_id));
    if (native?.owns(response.request_id)) {native.respondApproval(response); return {kind: "live"};}
    const retainedOwner = this.#stateStore.getMcpReview(response.session_id);
    const live = retainedOwner?.native_work_id ? this.#mcpWorkReviews.get(response.session_id)?.get(retainedOwner.native_work_id)
      : this.#mcpReviews.get(response.session_id);
    if (live) {live.decide(response); return {kind: "live"};}
    const retained = this.#stateStore.getMcpReview(response.session_id);
    if (retained?.native_work_id) throw new HarnessAdapterError("native_work_callback_lost", "No live native work MCP owner exists; callbacks cannot be resumed through a root turn.");
    if (!retained || retained.turn.turn_id !== response.turn_id) {
      throw new HarnessAdapterError("mcp_review_unavailable", "No durable MCP review belongs to this turn.");
    }
    const reviewer = new HarnessMcpReview(this.#stateStore, retained.start, retained.turn, onEvent);
    reviewer.validateDecision(response);
    return this.#resumeMcpOperation(retained, reviewer, () => reviewer.decide(response), onEvent);
  }

  async respondToMcpInput(response: HcpInputResponsePayload, onEvent: (event: HcpHarnessEventPayload) => void): Promise<
    {kind: "live"} | {kind: "resumed"; completion: Promise<HcpHarnessEventPayload[]>}
  > {
    const native = [this.#nativeInteractions.get(response.session_id), this.#sessionInteractions.get(response.session_id)].find(owner => owner?.owns(response.request_id));
    if (native?.owns(response.request_id)) {native.respondInput(response); return {kind: "live"};}
    if (response.request_scope === "session") throw new HarnessAdapterError("native_input_unavailable", "No live native session input owner exists; callbacks cannot be replayed.");
    const retainedOwner = this.#stateStore.getMcpReview(response.session_id);
    const live = retainedOwner?.native_work_id ? this.#mcpWorkReviews.get(response.session_id)?.get(retainedOwner.native_work_id)
      : this.#mcpReviews.get(response.session_id);
    if (live) {live.respondToInput(response); return {kind: "live"};}
    const retained = this.#stateStore.getMcpReview(response.session_id);
    if (retained?.native_work_id) throw new HarnessAdapterError("native_work_callback_lost", "No live native work MCP owner exists; callbacks cannot be resumed through a root turn.");
    if (!retained || retained.turn.turn_id !== response.turn_id || retained.outcome.phase !== "input_waiting") {
      throw new HarnessAdapterError("mcp_input_unavailable", "No waiting MCP input belongs to this turn; dispatched input is not replayed.");
    }
    const owner = new HarnessMcpReview(this.#stateStore, retained.start, retained.turn, onEvent);
    owner.validateInputResponse(response);
    return this.#resumeMcpOperation(retained, owner, () => owner.respondToInput(response), onEvent);
  }

  async #resumeMcpOperation(retained: PersistedMcpReview, owner: HarnessMcpReview,
    decide: () => PersistedMcpReview, onEvent: (event: HcpHarnessEventPayload) => void,
  ): Promise<{kind: "resumed"; completion: Promise<HcpHarnessEventPayload[]>}> {
    const sessionId = retained.start.session_id;
    if (!this.#adapterRegistry.require(retained.start.driver_kind).durableMcpContinuation) {
      throw new HarnessAdapterError("mcp_continuation_unavailable", "This adapter does not support durable MCP continuation.");
    }
    if (this.#mcpResumes.has(sessionId)) throw new HarnessAdapterError("mcp_resume_pending", "The MCP operation is already resuming.");
    this.#mcpResumes.add(sessionId);
    try {
      const {session, activateEvents} = await this.#prepareSession(retained.start);
      let decided: PersistedMcpReview;
      try {decided = decide();} catch (error: unknown) {
        await cleanupAdapterSessionStartFailure(session.adapter, sessionId, session.mcpClients, "mcp_resume_failed", error);
        throw error;
      }
      this.#sessions.set(session.sessionId, session);
      this.#turnIdsBySession.set(session.sessionId, new Set([retained.turn.turn_id]));
      this.#mcpReviews.set(session.sessionId, owner);
      for (const event of activateEvents()) onEvent(event);
      return {kind: "resumed", completion: this.#continueMcpReview(session, retained, decided, owner, onEvent)};
    } catch (error: unknown) {
      throw error instanceof SessionStartCleanedError ? error.originalError : error;
    } finally {this.#mcpResumes.delete(sessionId);}
  }

  async recoverMcpReviews(onEvent: (event: HcpHarnessEventPayload) => void,
    watchTurn: (completion: Promise<HcpHarnessEventPayload[]>, sessionId: string, turnId: string) => void): Promise<void> {
    if (this.#restoredMcpReviews) return;
    this.#restoredMcpReviews = true;

    for (const review of this.#stateStore.pendingMcpReviews()) {
      if (review.native_work_id) {
        if (this.#mcpWorkReviews.get(review.start.session_id)?.has(review.native_work_id)) continue;
        const phase = review.outcome;
        const input = phase.phase === "input_waiting" || phase.phase === "input_resuming";
        const requestId = "input_request_id" in phase ? phase.input_request_id : review.request_id;
        const lost = this.#event(review.start.session_id, review.turn.turn_id, "native.request.lost", {
          request_id: requestId, session_id: review.start.session_id, turn_id: review.turn.turn_id,
          native_work_id: review.native_work_id, request_kind: input ? "input" : "approval", reason: "owner_closed", lost_at: new Date().toISOString(),
        });
        onEvent(lost);
        // Preserve the receipt, including possible dispatched effects. Never recreate a child callback or replay its root.
        continue;
      }
      const last = this.#lastSavedEvent(review.start.session_id);
      if (this.#stateStore.hasSessionExit(review.start.session_id)) {
        this.#stateStore.clearMcpReview(review.start.session_id, review.request_id);
        continue;
      }
      if (last && terminalTurnEvents.has(last.event_type)) {
        for (const event of this.#retireSavedReview(review, {kind: "closed"})) onEvent(event);
        continue;
      }
      if (this.#sessions.has(review.start.session_id) || review.outcome.phase === "waiting" || review.outcome.phase === "input_waiting" || review.outcome.phase === "review_waiting") continue;
      if (review.outcome.phase === "dispatching" || review.outcome.phase === "input_resuming" || review.outcome.phase === "review_resuming" || review.outcome.phase === "expiry_resuming") {
        for (const event of this.#retireSavedReview(review, {kind: "failed", code: "mcp_review_outcome_unknown",
          message: "The reviewed call may have dispatched before the runner stopped; automatic retry is forbidden."})) onEvent(event);
        continue;
      }
      try {
        const resolution = review.outcome.phase === "expiry_completed"
          ? await this.#resumeMcpOperation(review, new HarnessMcpReview(this.#stateStore, review.start, review.turn, onEvent), () => review, onEvent)
          : await this.respondToMcpReview({session_id: review.start.session_id, turn_id: review.turn.turn_id,
          request_id: review.request_id, action_hash: review.action_hash, actor_id: review.outcome.actor_id,
          decision: review.outcome.phase === "declined" ? "decline" : "accept"}, onEvent);
        if (resolution.kind === "resumed") watchTurn(resolution.completion, review.start.session_id, review.turn.turn_id);
      } catch (error: unknown) {
        for (const event of this.#retireSavedReview(review, {kind: "failed", code: "mcp_review_recovery_failed",
          message: error instanceof Error ? error.message : "MCP continuation could not resume."})) onEvent(event);
      }
    }
  }

  #lastSavedEvent(sessionId: string): HcpHarnessEventPayload | undefined {
    const lastSequence = this.#stateStore.nextEventSequence(sessionId) - 1;
    return this.#stateStore.replayEventsAfter(sessionId, lastSequence - 1)?.[0];
  }

  #retireSavedReview(review: PersistedMcpReview, outcome: {kind: "closed"} | {kind: "cancelled"} | {kind: "failed"; code: string; message: string}): HcpHarnessEventPayload[] {
    const sessionId = review.start.session_id;
    const sequence = this.#stateStore.nextEventSequence(sessionId);
    const createdAt = new Date().toISOString();
    const events: HcpHarnessEventPayload[] = [];
    if (outcome.kind !== "closed") events.push({session_id: sessionId, turn_id: review.turn.turn_id, sequence,
      created_at: createdAt, event_type: outcome.kind === "cancelled" ? "turn.cancelled" : "turn.failed",
      data: outcome.kind === "cancelled" ? {status: "cancelled", final_output: {exit_reason: "cancel_requested"}}
        : {status: "failed", final_output: {exit_reason: outcome.code}, error: {code: outcome.code, message: outcome.message, retryable: false}}});
    events.push({session_id: sessionId, sequence: sequence + events.length, created_at: createdAt, event_type: "session.exited",
      data: {provider_instance_id: review.start.provider_instance_id, reason: outcome.kind}});
    this.#stateStore.clearMcpReview(sessionId, review.request_id, events);
    return events;
  }

  async #continueMcpReview(session: HarnessSession, previous: PersistedMcpReview, decided: PersistedMcpReview,
    reviewer: HarnessMcpReview, onEvent: (event: HcpHarnessEventPayload) => void): Promise<HcpHarnessEventPayload[]> {
    try {
    if (session.cancelRequested) return [];
    const action = mcpReviewActionSchema.parse(JSON.parse(decided.action_json));
    let outcome: HarnessMcpContinuation["outcome"];
    if (decided.outcome.phase === "declined") outcome = {kind: "declined"};
    else if (decided.outcome.phase === "completed" || decided.outcome.phase === "expiry_completed") {
      outcome = {kind: "completed", result: mcpToolCallResultSchema.parse(JSON.parse(decided.outcome.result_json))};
    } else if ((decided.outcome.phase === "dispatching" && previous.outcome.phase === "waiting") ||
        (decided.outcome.phase === "input_resuming" && previous.outcome.phase === "input_waiting") ||
        (decided.outcome.phase === "review_resuming" && previous.outcome.phase === "review_waiting")) {
      const toolset = session.mcpToolsets.find(item => item.name === action.attachment_name);
      if (!toolset || !toolset.tools.some(tool => tool.name === action.tool_name)) {
        throw new HarnessAdapterError("mcp_review_selection_changed", "The reviewed tool is no longer selected.");
      }
      const grant = decided.outcome.phase === "dispatching" || decided.outcome.review_actor_id !== undefined
        ? {request_id: decided.request_id, action_json: decided.action_json} : undefined;
      const result = await reviewer.invoke({attachment_name: action.attachment_name, tool_name: action.tool_name,
        arguments: action.arguments, native_thread_id: decided.native_thread_id, native_turn_id: decided.native_turn_id,
        native_call_id: decided.native_call_id}, toolset.callTool.bind(toolset), new AbortController().signal, grant,
        decided.outcome.phase === "input_resuming" || decided.outcome.phase === "review_resuming" ? decided.outcome.reply : undefined);
      outcome = {kind: "completed", result};
    } else {
      throw new HarnessAdapterError("mcp_review_outcome_unknown", "The reviewed call may already have dispatched; automatic retry is forbidden.");
    }
    if (session.cancelRequested) return [];
    return await this.#runTurn(decided.turn, session, onEvent, {native_thread_id: decided.native_thread_id,
      request_id: decided.request_id, attachment_name: action.attachment_name, tool_name: action.tool_name, arguments: action.arguments, outcome});
    } catch (error: unknown) {
      if (session.cancelRequested) return [];
      throw error;
    }
  }

  async #runTurn(
    payload: HcpTurnSendPayload,
    session: HarnessSession,
    onEvent: ((event: HcpHarnessEventPayload) => void) | undefined,
    continuation?: HarnessMcpContinuation,
  ): Promise<HcpHarnessEventPayload[]> {
    if (this.#runningTurns.has(payload.session_id)) throw new HarnessSessionError("turn_in_progress", "This session already has an admitted root turn.");
    this.#runningTurns.set(payload.session_id, payload.turn_id);
    try {
    await Promise.resolve();
    let nativeInput = payload.input;
    let contextInput: {source: "app"; delivery: "prompt_context"; message_count: number; byte_length: number; context_hash: string} | undefined;
    if (payload.context) {
      if (payload.action === "compact" || !session.adapter.promptContextInputs)
        throw new HarnessAdapterError("prompt_context_unsupported", "This execution path does not declare application-supplied prompt context.");
      const context = harnessPromptContextSchema.parse(payload.context);
      const encoded = JSON.stringify(context.messages.map(({role, content}) => ({role, content})));
      nativeInput = `Conversation context supplied by the application:\n${encoded}\n\nCurrent user request:\n${nativeInput}`;
      contextInput = {source: "app", delivery: "prompt_context", message_count: context.messages.length,
        byte_length: Buffer.byteLength(encoded, "utf8"), context_hash: createHash("sha256").update(encoded).digest("hex")};
    }
    if (payload.files?.length) {
      if (payload.action === "compact" || !session.adapter.fileContextInputs)
        throw new HarnessAdapterError("input_file_delivery_unsupported", "This execution path does not declare file-context input.");
      await this.#assertWorkspaceAllowed(session.workspaceId, session.cwd);
      if (nativeProviderHash(this.#requireProvider(session.providerInstanceId, session.driverKind)) !== session.inputFileScope.provider_binding_hash)
        throw new HarnessAdapterError("input_file_binding_changed", "The original input-file provider identity changed.");
      nativeInput += this.#inputFileStore().materialize(session.inputFileScope, payload.files);
    }
    const events: HcpHarnessEventPayload[] = [];
    if (!continuation) {
      const startedEvent: HcpHarnessEventPayload = this.#event(payload.session_id, payload.turn_id, "turn.started", {
      provider_instance_id: session.providerInstanceId,
      input_length: payload.input.length,
      model_selection: payload.model_selection ?? session.startPayload.model_selection,
    });
      if (onEvent) onEvent(startedEvent);
      else events.push(startedEvent);
    }
    if (session.cancelRequested) {
      const last = this.#lastSavedEvent(payload.session_id);
      if (last?.turn_id === payload.turn_id && terminalTurnEvents.has(last.event_type)) return events;
      const cancelled = this.#event(payload.session_id, payload.turn_id, "turn.cancelled", {status: "cancelled", final_output: {exit_reason: "cancel_requested"}});
      if (onEvent) onEvent(cancelled); else events.push(cancelled);
      return events;
    }

    let terminalEventType: string | undefined;
    const emitAdapterEvent = (adapterEvent: HarnessAdapterEvent): void => {
      if (adapterEvent.event_type === "turn.started") {
        return;
      }
      if (terminalTurnEvents.has(adapterEvent.event_type)) {
        terminalEventType = adapterEvent.event_type;
      }
      const event: HcpHarnessEventPayload = this.#event(
        payload.session_id,
        adapterEvent.turn_id ?? payload.turn_id,
        adapterEvent.event_type,
        adapterEvent.data,
      );
      if (onEvent) {
        onEvent(event);
      } else {
        events.push(event);
      }
    };
    const reviewer = session.adapter.durableMcpContinuation ? new HarnessMcpReview(this.#stateStore, session.startPayload, payload, event => {
      if (onEvent) onEvent(event); else events.push(event);
    }) : undefined;
    if (reviewer) this.#mcpReviews.set(payload.session_id, reviewer);
    let dispatch = this.#mcpDispatch.get(payload.session_id);
    if (!dispatch) {
      dispatch = new HarnessMcpDispatchQueue(() => {
        if (this.#sessions.get(payload.session_id) !== session || session.nativeWorkOwnerAvailable === false)
          throw new HarnessAdapterError("mcp_dispatch_owner_lost", "The MCP session owner is unavailable.");
        const retained = this.#stateStore.getMcpReview(payload.session_id);
        if (retained && !["completed", "expiry_completed", "declined"].includes(retained.outcome.phase))
          throw new HarnessAdapterError("mcp_review_pending", "A retained MCP operation has an unresolved outcome; dispatch is fenced.");
      });
      this.#mcpDispatch.set(payload.session_id, dispatch);
    }
    if (contextInput && !continuation) {
      const prepared = this.#event(payload.session_id, payload.turn_id, "context.input.prepared", contextInput);
      if (onEvent) onEvent(prepared); else events.push(prepared);
    }
    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.sendTurn({
      payload: {...payload, input: nativeInput},
      session: session.adapterSession,
      startPayload: session.startPayload,
      provider: this.#requireProvider(session.providerInstanceId, session.driverKind),
      mcpServers: session.mcpServers,
      mcpToolsets: session.mcpToolsets,
      dispatchMcp: dispatch.dispatch,
      ...(reviewer ? {reviewMcpTool: reviewer} : {}),
      ...(session.adapter.nativeWork && session.adapter.durableMcpContinuation ? {reviewNativeWorkMcp: (workId: string) => {
        const work = this.#stateStore.nativeWorkState(payload.session_id)?.items[workId];
        if (this.#sessions.get(payload.session_id) !== session || session.nativeWorkOwnerAvailable === false
          || !this.#liveNativeWork.get(payload.session_id)?.has(workId) || !work || isNativeWorkTerminal(work.status)
          || work.origin_turn_id !== payload.turn_id)
          throw new HarnessAdapterError("native_work_request_binding", "Native work MCP review requires its confirmed live work and original root.");
        let owners = this.#mcpWorkReviews.get(payload.session_id);
        if (!owners) {owners = new Map(); this.#mcpWorkReviews.set(payload.session_id, owners);}
        let owner = owners.get(workId);
        if (!owner) {
          if (owners.size >= 128) throw new HarnessAdapterError("native_work_request_limit", "Native work MCP review exceeded its bounded ownership registry.");
          owner = new HarnessMcpReview(this.#stateStore, session.startPayload, payload, event => this.#publishPersistedEvent(event), workId);
          owners.set(workId, owner);
        }
        return owner;
      }} : {}),
      ...(continuation ? {mcpContinuation: continuation} : {}),
      registerNativeInteractions: owner => {
        if (owner) this.#nativeInteractions.set(payload.session_id, owner);
        else this.#nativeInteractions.delete(payload.session_id);
      },
      registerActiveTurnControls: controls => {
        if (controls) this.#activeTurnControls.set(payload.session_id, {turnId: payload.turn_id, controls});
        else if (this.#activeTurnControls.get(payload.session_id)?.turnId === payload.turn_id)
          this.#activeTurnControls.delete(payload.session_id);
      },
      publishContent: value => this.#contentStore.publish({session_id: session.sessionId, provider_instance_id: session.providerInstanceId,
        provider_binding_hash: nativeProviderHash(this.#requireProvider(session.providerInstanceId, session.driverKind)), workspace_id: session.workspaceId, cwd: session.cwd}, value),
      ...(session.startPayload.continuation_group_key ? {persistNativeThread: (threadId: string) => {
        const previous = this.#stateStore.getNativeConversation(session.startPayload.continuation_group_key!);
        this.#stateStore.saveNativeConversation(session.startPayload.continuation_group_key!, {
          ...(previous?.rollback ? {rollback: previous.rollback} : {}),
          ...(previous?.fork ? {fork: previous.fork} : {}),
          ...(previous?.injections ? {injections: previous.injections} : {}),
          ...(previous?.configuration_transitions ? {configuration_transitions: previous.configuration_transitions} : {}),
          ...(previous?.feedback_submissions ? {feedback_submissions: previous.feedback_submissions} : {}),
          configuration_base_hash: nativeConfigurationBaseHash(session.startPayload, this.#requireProvider(session.providerInstanceId, session.driverKind), session.mcpToolsets,
            validateConfigurationInheritance(session.startPayload, session.adapter.configurationInheritance, session.adapter.configurationInheritanceOptions)),
          native_thread_id: threadId, binding_hash: session.nativeBindingHash!, updated_at: new Date().toISOString(),
          approval_policy: session.startPayload.approval_policy,
          last_session_id: session.sessionId, provider_instance_id: session.providerInstanceId, workspace_id: session.workspaceId, cwd: session.cwd,
          provider_binding_hash: nativeProviderHash(this.#requireProvider(session.providerInstanceId, session.driverKind)),
        });
      }} : {}),
      emitEvent: emitAdapterEvent,
    }).finally(() => {
      if (this.#activeTurnControls.get(payload.session_id)?.turnId === payload.turn_id)
        this.#activeTurnControls.delete(payload.session_id);
    });
    for (const adapterEvent of adapterEvents) {
      emitAdapterEvent(adapterEvent);
    }

    if (terminalEventType) await this.#recordAudit({
      event: terminalEventType,
      session_id: payload.session_id,
      turn_id: payload.turn_id,
      provider_instance_id: session.providerInstanceId,
      workspace_id: session.workspaceId,
      data: {
        input_length: payload.input.length,
      },
    });
    return events;
    } finally {
      if (this.#runningTurns.get(payload.session_id) === payload.turn_id) this.#runningTurns.delete(payload.session_id);
    }
  }

  recordTurnFailure(sessionId: string, turnId: string, error: unknown): HcpHarnessEventPayload {
    const message: string = error instanceof Error ? error.message : "Harness turn failed.";
    const code: string =
      error instanceof HarnessSessionError || error instanceof HarnessAdapterError ? error.code : "harness_turn_failed";
    return this.#event(sessionId, turnId, "turn.failed", {
      status: "failed",
      final_output: { exit_reason: code },
      error: { code, message, retryable: false },
    });
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<HcpHarnessEventPayload[]> {
    const startup = this.#startingSessions.get(sessionId);
    if (startup) {
      if (startup.firstTurnId !== undefined && startup.firstTurnId !== turnId) {
        throw new HarnessSessionError("turn_mismatch", "Cancellation targets another startup turn.");
      }
      startup.cancelled = true; return [];
    }
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      const review = this.#stateStore.getMcpReview(sessionId);
      if (review?.turn.turn_id === turnId) return this.#retireSavedReview(review, {kind: "cancelled"});
      if (this.#stateStore.hasSessionExit(sessionId)) return [];
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

    const retained = this.#stateStore.getMcpReview(sessionId);
    if (this.#runningTurns.get(sessionId) !== turnId &&
        !(this.#mcpResumes.has(sessionId) && retained?.turn.turn_id === turnId && !retained.native_work_id)) return [];
    session.cancelRequested = true;
    const rootReview = this.#mcpReviews.get(sessionId);
    const graceful = session.nativeWorkOwnerAvailable === true;
    if (!graceful) rootReview?.interrupt();
    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.cancelTurn({ sessionId, turnId });
    rootReview?.interrupt();
    const last = this.#lastSavedEvent(sessionId);
    if (adapterEvents.length === 0 && this.#mcpReviews.has(sessionId) &&
        (!last || !terminalTurnEvents.has(last.event_type))) {
      return [this.#event(sessionId, turnId, "turn.cancelled", {status: "cancelled", final_output: {exit_reason: "cancel_requested"}})];
    }
    return adapterEvents.map((event: HarnessAdapterEvent): HcpHarnessEventPayload =>
      this.#event(sessionId, event.turn_id ?? turnId, event.event_type, event.data),
    );
  }

  stopSession(sessionId: string, reason: string | undefined): Promise<HcpHarnessEventPayload[]> {
    const startup = this.#startingSessions.get(sessionId);
    if (startup) startup.cancelled = true;
    return this.#serializeWorkspace(() => this.#stopSession(sessionId, reason));
  }

  async #stopSession(sessionId: string, reason: string | undefined): Promise<HcpHarnessEventPayload[]> {
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      const review = this.#stateStore.getMcpReview(sessionId);
      if (review) return this.#retireSavedReview(review, {kind: "cancelled"});
      if (this.#stateStore.hasSessionExit(sessionId)) return [];
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

    session.cancelRequested = true;
    const rootReview = this.#mcpReviews.get(sessionId);
    const graceful = session.nativeWorkOwnerAvailable === true;
    if (!graceful) rootReview?.interrupt();
    const events: HcpHarnessEventPayload[] = [];
    const first = session.startPayload.first_turn;
    if (first && !this.#turnIdsBySession.get(sessionId)?.has(first.turn_id)
        && this.#lastSavedEvent(sessionId)?.event_type !== "turn.cancelled") {
      events.push(this.#event(sessionId, first.turn_id, "turn.cancelled", {
        status: "cancelled", final_output: {exit_reason: "cancel_requested"},
      }));
    }
    session.nativeWorkOwnerAvailable = false;
    session.nativeWorkCancellation?.abort();
    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.stopSession({ sessionId, ...(reason ? { reason } : {}) });
    rootReview?.interrupt();
    events.push(
      ...adapterEvents.map((event: HarnessAdapterEvent): HcpHarnessEventPayload =>
        this.#event(sessionId, event.turn_id, event.event_type, event.data),
      ),
    );
    const pendingWork = Object.values(this.#stateStore.nativeWorkState(sessionId)?.items ?? {}).filter(work => !isNativeWorkTerminal(work.status));
    if (pendingWork.length || session.nativeWorkClosureUnconfirmed || this.#stateStore.nativeWorkState(sessionId)?.closure_unconfirmed)
      throw new HarnessAdapterError("native_work_shutdown_unknown", "Native work closure is unconfirmed; the execution lease remains retained.");
    if (!session.startPayload.continuation_group_key) this.#inputFiles?.retire(session.inputFileScope);
    await this.#closeMcpClients(session);
    if (session.localCapabilityLease) {
      this.#localCapabilities.revokeLease(session.localCapabilityLease.lease_id);
      events.push(
        this.#event(sessionId, undefined, "local_capability.lease.revoked", {
          lease_id: session.localCapabilityLease.lease_id,
          workspace_id: session.workspaceId,
          provider_instance_id: session.providerInstanceId,
          status: "revoked",
        }),
      );
    }

    events.push(
      this.#event(sessionId, undefined, "session.exited", {
        provider_instance_id: session.providerInstanceId,
        reason: reason ?? "stopped",
      }),
    );
    this.#sessions.delete(sessionId);
    this.#sessionInteractions.delete(sessionId);
    this.#liveNativeWork.delete(sessionId);
    this.#mcpReviews.delete(sessionId);
    for (const owner of this.#mcpWorkReviews.get(sessionId)?.values() ?? []) owner.interrupt();
    this.#mcpWorkReviews.delete(sessionId);
    this.#mcpDispatch.delete(sessionId);
    const review = this.#stateStore.getMcpReview(sessionId);
    if (review) this.#stateStore.clearMcpReview(sessionId, review.request_id);
    this.#turnIdsBySession.delete(sessionId);
    await this.#recordAudit({
      event: "session.exited",
      session_id: sessionId,
      provider_instance_id: session.providerInstanceId,
      workspace_id: session.workspaceId,
      data: {
        reason: reason ?? "stopped",
      },
    });
    return events;
  }

  #requireProvider(providerInstanceId: string, driverKind?: string): ProviderInstanceConfig {
    const provider: ProviderInstanceConfig | undefined = this.#config.provider_instances.find(
      (candidate: ProviderInstanceConfig): boolean => candidate.id === providerInstanceId,
    );
    if (!provider) {
      throw new HarnessSessionError("provider_not_found", `Provider '${providerInstanceId}' is not configured.`);
    }

    if (!provider.enabled) {
      throw new HarnessSessionError("provider_disabled", `Provider '${providerInstanceId}' is disabled.`);
    }

    if (driverKind !== undefined && provider.driver_kind !== driverKind) {
      throw new HarnessSessionError(
        "provider_driver_mismatch",
        `Provider '${providerInstanceId}' is configured for '${provider.driver_kind}', not '${driverKind}'.`,
      );
    }

    return provider;
  }

  async #assertWorkspaceAllowed(workspaceId: string, cwd: string): Promise<void> {
    if (this.#config.workspaces.length === 0) {
      throw new HarnessSessionError(
        "workspace_not_configured",
        "Runner config has no workspaces configured; refusing to start a local harness session.",
      );
    }

    const workspace = this.#config.workspaces.find((candidate): boolean => candidate.id === workspaceId);
    if (!workspace) {
      throw new HarnessSessionError("workspace_not_allowed", `Workspace '${workspaceId}' is not configured by runner config.`);
    }

    const resolvedCwd: string = await realpathOrWorkspaceError(cwd);
    const resolvedWorkspace: string = await realpathOrWorkspaceError(workspace.path);
    const pathFromWorkspace: string = relative(resolvedWorkspace, resolvedCwd);
    const allowed: boolean =
      pathFromWorkspace === "" || (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace));

    if (!allowed) {
      throw new HarnessSessionError("workspace_not_allowed", `Workspace '${cwd}' is not allowed by runner config.`);
    }
  }

  #requireWorkspaceRoot(workspaceId: string): string {
    const workspace = this.#config.workspaces.find((candidate): boolean => candidate.id === workspaceId);
    if (!workspace) {
      throw new LocalCapabilityPolicyError(
        "local_capability_workspace_mismatch",
        `Workspace '${workspaceId}' is not configured by runner config.`,
      );
    }
    return workspace.path;
  }

  async #attachMcpServers(payload: HcpSessionStartPayload, provider: ProviderInstanceConfig): Promise<HarnessMcpAttachmentResult> {
    const clients: HarnessMcpClient[] = [];
    const adapterAttachments: HarnessAdapterMcpServer[] = [];
    const discoveredTools: HarnessMcpToolDiscovery[] = [];
    const toolsets: HarnessMcpToolset[] = [];
    try {
      for (const attachment of payload.mcp_servers) {
        const client: HarnessMcpClient =
          attachment.transport === "runner_stdio_profile"
            ? await this.#createStdioProfileProxy(attachment, payload, provider)
            : this.#mcpClientFactory({
                attachment,
                sessionId: payload.session_id,
                hostId: this.#hostId,
                providerInstanceId: payload.provider_instance_id,
                workspaceId: payload.workspace_id,
                driverKind: provider.driver_kind,
                ...(this.#mcpProofSigner ? { proofSigner: this.#mcpProofSigner } : {}),
              });
        clients.push(client);
        await client.connect();
        if (provider.driver_kind === "codex" && (!client.listTools || !client.callTool)) {
          throw new HarnessAdapterError("mcp_bridge_missing", "Codex attachments require tool discovery and invocation through the runner client.");
        }
        if (client.listTools !== undefined) {
          const tools: McpToolDescriptor[] = await client.listTools();
          discoveredTools.push({ attachmentName: attachment.name, tools });
          if (client.callTool) {
            const call = client.callTool.bind(client);
            toolsets.push({ name: attachment.name, tools, callTool: call });
          }
        }
        if (client.adapterAttachment) {
          adapterAttachments.push(client.adapterAttachment);
        } else if (attachment.transport === "streamable_http") {
          adapterAttachments.push(toAdapterMcpServer(attachment));
        }
      }
    } catch (error: unknown) {
      await closeMcpClientsBestEffort(clients);
      throw new SessionStartCleanedError(error, "mcp_start_failed");
    }

    return { clients, adapterAttachments, discoveredTools, toolsets };
  }

  async #createStdioProfileProxy(
    attachment: Extract<McpServerAttachment, { transport: "runner_stdio_profile" }>,
    payload: HcpSessionStartPayload,
    provider: ProviderInstanceConfig,
  ): Promise<HarnessMcpClient> {
    const profile: McpStdioProfileConfig | undefined = this.#config.mcp_stdio_profiles.find(
      (candidate: McpStdioProfileConfig): boolean => candidate.id === attachment.profile_id,
    );
    if (!profile) {
      throw new HarnessSessionError(
        "mcp_stdio_profile_not_found",
        `Runner MCP profile '${attachment.profile_id}' is not configured on this host.`,
      );
    }
    if (profile.provider_instance_ids.length > 0 && !profile.provider_instance_ids.includes(provider.id)) {
      throw new HarnessSessionError(
        "mcp_stdio_profile_provider_denied",
        `Runner MCP profile '${profile.id}' is not allowed for provider '${provider.id}'.`,
      );
    }
    if (isAbsolute(profile.workspace_relative_cwd)) {
      throw new HarnessSessionError(
        "mcp_stdio_profile_cwd_invalid",
        `Runner MCP profile '${profile.id}' must use a workspace-relative cwd.`,
      );
    }
    const workspaceRoot: string = await realpathOrWorkspaceError(this.#requireWorkspaceRoot(payload.workspace_id));
    const profileCwd: string = await realpathOrWorkspaceError(resolve(workspaceRoot, profile.workspace_relative_cwd));
    const relativeCwd: string = relative(workspaceRoot, profileCwd);
    if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
      throw new HarnessSessionError(
        "mcp_stdio_profile_cwd_invalid",
        `Runner MCP profile '${profile.id}' resolves outside workspace '${payload.workspace_id}'.`,
      );
    }
    const allowedTools: string[] | undefined = intersectAllowedTools(profile.allowed_tools, attachment.allowed_tools);
    const deniedTools: string[] = [...new Set([...profile.denied_tools, ...(attachment.denied_tools ?? [])])];
    const upstream = new McpStdioProfileClient({
      name: attachment.name,
      command: profile.command,
      args: profile.args,
      cwd: profileCwd,
      env: profile.env,
      ...(allowedTools ? { allowedTools } : {}),
      deniedTools,
    });
    return new McpProxyServer({
      attachment: {
        name: attachment.name,
        ...(allowedTools ? { allowed_tools: allowedTools } : {}),
        ...(deniedTools.length > 0 ? { denied_tools: deniedTools } : {}),
      },
      upstream,
    });
  }

  async #closeMcpClients(session: HarnessSession): Promise<void> {
    await closeMcpClientsBestEffort(session.mcpClients);
  }

  #event(
    sessionId: string,
    turnId: string | undefined,
    eventType: HcpHarnessEventPayload["event_type"],
    data: Record<string, unknown>,
    nativeWorkState?: NativeWorkState,
  ): HcpHarnessEventPayload {
    if (eventType === "native.work.owner_lost") {
      const owner = this.#sessions.get(sessionId);
      if (turnId || !owner?.adapter.nativeWork)
        throw new HarnessAdapterError("native_work_unsupported", "Native owner loss requires its session-owned native-work contract.");
      hcpHarnessEventPayloadSchema.parse({session_id: sessionId, sequence: 1, event_type: eventType, created_at: new Date().toISOString(), data});
      // Loss of physical ownership must fence controls even when journaling fails.
      owner.nativeWorkOwnerAvailable = false;
      owner.nativeWorkCancellation?.abort();
      this.#sessionInteractions.delete(sessionId);
      this.#nativeInteractions.delete(sessionId);
      for (const review of this.#mcpWorkReviews.get(sessionId)?.values() ?? []) review.interrupt();
      this.#mcpWorkReviews.delete(sessionId);
      if (data.closure_unconfirmed === true) {
        owner.nativeWorkClosureUnconfirmed = true;
        const state = this.#stateStore.nativeWorkState(sessionId);
        if (!state) throw new HarnessAdapterError("native_work_unavailable", "Native closure uncertainty requires its owning inventory.");
        nativeWorkState = {...state, closure_unconfirmed: true};
      }
    }
    if (this.#publishing && this.#publicationAdmissions >= 128)
      throw new HarnessSessionError("event_publication_backpressure", "Reentrant event observations exceeded their bounded publication queue.");
    if (eventType === "native.work.updated" && !nativeWorkState) {
      const session = this.#sessions.get(sessionId);
      const state = this.#stateStore.nativeWorkState(sessionId);
      if (!session?.adapter.nativeWork || !state || Object.keys(data).some(key => key !== "work"))
        throw new HarnessAdapterError("native_work_unsupported", "Native work requires the owning adapter's declared contract.");
      const observation = harnessNativeWorkObservationSchema.parse(data.work);
      const previous = state.items[observation.work_id];
      if (!session.nativeWorkOwnerAvailable && (!previous || !isNativeWorkTerminal(observation.status) && observation.status !== "unknown"))
        throw new HarnessAdapterError("native_work_owner_unavailable", "A lost native owner may only reconcile retained work; it cannot admit active work.");
      const parent = observation.parent_work_id ? state.items[observation.parent_work_id] ?? state.retired[observation.parent_work_id] : undefined;
      if (state.retired[observation.work_id]) throw new HarnessAdapterError("native_work_retired", "A retired native execution cannot be reopened.");
      if ((!previous && !this.#turnIdsBySession.get(sessionId)?.has(observation.origin_turn_id) && parent?.origin_turn_id !== observation.origin_turn_id)
          || (turnId && turnId !== observation.origin_turn_id) || (observation.parent_work_id && (!parent || observation.parent_work_id === observation.work_id)))
        throw new HarnessAdapterError("native_work_binding", "Native work requires an admitted origin and an owned parent.");
      if (previous && (previous.native_reference !== observation.native_reference || previous.origin_turn_id !== observation.origin_turn_id
          || previous.parent_work_id !== observation.parent_work_id || previous.kind !== observation.kind))
        throw new HarnessAdapterError("native_work_binding", "A native execution's identity and origin cannot change.");
      if (previous && isNativeWorkTerminal(previous.status) && previous.status !== observation.status)
        throw new HarnessAdapterError("native_work_terminal", "Completed native work cannot return to an active state.");
      if (observation.background && !session.adapter.sessionEvents || observation.supports_cancel && !session.adapter.cancelNativeWork)
        throw new HarnessAdapterError("native_work_unsupported", "Native work cannot advertise unimplemented observation or cancellation ownership.");
      const work = harnessNativeWorkRecordSchema.parse({...observation, revision: (previous?.revision ?? 0) + 1,
        ...(previous?.control ? {control: previous.control} : {})});
      state.items[work.work_id] = work;
      nativeWorkState = state;
      data = {work};
    }
    if (eventType === "native.work.retired" && !nativeWorkState)
      throw new HarnessAdapterError("native_work_retirement_owned", "Native work retirement is owned by the runner.");
    const sequence: number = this.#stateStore.nextEventSequence(sessionId);
    const payload: HcpHarnessEventPayload = {
      session_id: sessionId,
      sequence,
      event_type: eventType,
      created_at: new Date().toISOString(),
      data: structuredClone(data),
    };
    if (turnId) {
      payload.turn_id = turnId;
    }

    const retained = this.#stateStore.getMcpReview(sessionId);
    if (nativeWorkState) {
      this.#stateStore.saveNativeWorkState(sessionId, nativeWorkState, payload);
      if (eventType === "native.work.updated") this.#liveNativeWork.get(sessionId)?.add((data.work as HarnessNativeWorkRecord).work_id);
    } else if (terminalTurnEvents.has(eventType) && (!retained || retained.turn.turn_id === turnId) && !retained?.native_work_id) {
      if (retained) this.#stateStore.clearMcpReview(sessionId, retained.request_id, [payload]);
      else this.#stateStore.appendEvent(payload);
      this.#mcpReviews.delete(sessionId);
    } else {
      this.#stateStore.appendEvent(payload);
    }
    if (terminalTurnEvents.has(eventType) && this.#runningTurns.get(sessionId) === turnId) this.#runningTurns.delete(sessionId);
    this.#publishPersistedEvent(payload);
    return payload;
  }

  #publishPersistedEvent(payload: HcpHarnessEventPayload): void {
    hcpHarnessEventPayloadSchema.parse(payload);
    if (this.#publishing && this.#publicationAdmissions >= 128)
      throw new HarnessAdapterError("native_session_event_limit", "Native event publication exceeded its bounded admission queue.");
    this.#publicationQueue.push(payload);
    this.#publicationAdmissions++;
    if (!this.#publishing) {
      this.#publishing = true;
      try {
        while (this.#publicationQueue.length) {
          const next = this.#publicationQueue.shift()!;
          for (const [listener, onError] of [...this.#eventListeners]) {
            try {listener(structuredClone(next));} catch (error) {
              this.#eventListeners.delete(listener);
              try {onError?.(error);} catch { /* Subscriber failure cannot undo a committed native observation. */ }
            }
          }
        }
      } finally {this.#publishing = false; this.#publicationAdmissions = 0;}
    }
  }

  async #recordAudit(event: Parameters<AuditLogger["record"]>[0]): Promise<void> {
    if (!this.#auditLogger) {
      return;
    }
    await this.#auditLogger.record(event);
  }
}

function defaultMcpClientFactory(request: HarnessMcpClientRequest): HarnessMcpClient {
  if (!request.proofSigner) {
    throw new HarnessSessionError(
      "mcp_proof_signer_missing",
      `MCP attachment '${request.attachment.name}' requires a configured runner proof signer.`,
    );
  }

  const upstream = new McpAttachmentClient(request.attachment, {
    proofContext: {
      session_id: request.sessionId,
      host_id: request.hostId,
      provider_instance_id: request.providerInstanceId,
      workspace_id: request.workspaceId,
      server_id: request.attachment.name,
    },
    proofSigner: request.proofSigner,
  });
  if (request.driverKind === "claude" || request.driverKind === "opencode") {
    return new McpProxyServer({
      attachment: request.attachment,
      upstream,
    });
  }

  return upstream;
}

function toAdapterMcpServer(attachment: StreamableHttpMcpServerAttachment): HarnessAdapterMcpServer {
  return {
    name: attachment.name,
    transport: "streamable_http",
    url: attachment.url,
    headers: attachment.headers,
    ...(attachment.allowed_tools ? { allowed_tools: attachment.allowed_tools } : {}),
    ...(attachment.denied_tools ? { denied_tools: attachment.denied_tools } : {}),
  };
}

function intersectAllowedTools(profileTools: string[] | undefined, requestedTools: string[] | undefined): string[] | undefined {
  if (!profileTools) return requestedTools;
  if (!requestedTools) return profileTools;
  const requested: ReadonlySet<string> = new Set(requestedTools);
  return profileTools.filter((tool: string): boolean => requested.has(tool));
}

async function realpathOrWorkspaceError(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new HarnessSessionError("workspace_not_allowed", `Workspace path '${path}' could not be resolved: ${error.message}`);
    }
    throw error;
  }
}

async function realpathOrLocalActionError(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new LocalCapabilityPolicyError(
        "local_capability_path_denied",
        `Local action path '${path}' could not be resolved: ${error.message}`,
      );
    }
    throw error;
  }
}

function assertRequestLeaseMatchesActiveLease(payload: LocalActionRequestPayload, lease: LocalCapabilityLease): void {
  if (
    payload.lease.lease_id !== lease.lease_id ||
    payload.lease.hcp_session_id !== lease.hcp_session_id ||
    payload.lease.execution_host_id !== lease.execution_host_id ||
    payload.lease.provider_instance_id !== lease.provider_instance_id ||
    payload.lease.workspace_id !== lease.workspace_id
  ) {
    throw new LocalCapabilityPolicyError(
      "local_capability_lease_missing",
      "Local action lease binding does not match the active session lease.",
    );
  }
}

async function assertSandboxMatchesSession(
  payload: LocalActionRequestPayload,
  session: HarnessSession,
  workspaceRoot: string,
): Promise<void> {
  if (payload.sandbox.mode !== session.startPayload.sandbox_mode) {
    throw new LocalCapabilityPolicyError(
      "local_capability_sandbox_read_only",
      `Local action sandbox mode '${payload.sandbox.mode}' does not match active session sandbox mode '${session.startPayload.sandbox_mode}'.`,
    );
  }

  const resolvedRequestRoot: string = await realpathOrLocalActionError(payload.sandbox.workspace_root);
  const resolvedWorkspaceRoot: string = await realpathOrLocalActionError(workspaceRoot);
  if (resolvedRequestRoot !== resolvedWorkspaceRoot) {
    throw new LocalCapabilityPolicyError(
      "local_capability_sandbox_read_only",
      "Local action sandbox workspace root does not match the active session workspace.",
    );
  }

  const resolvedRequestCwd: string = await realpathOrLocalActionError(payload.sandbox.cwd);
  const resolvedSessionCwd: string = await realpathOrLocalActionError(session.cwd);
  if (resolvedRequestCwd !== resolvedSessionCwd) {
    throw new LocalCapabilityPolicyError(
      "local_capability_sandbox_read_only",
      "Local action sandbox cwd does not match the active session cwd.",
    );
  }
}

async function closeMcpClientsBestEffort(clients: HarnessMcpClient[]): Promise<void> {
  const errors: string[] = [];
  for (const client of clients) {
    try {
      await client.close();
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : "Unknown MCP close failure.");
    }
  }
  if (errors.length > 0) {
    throw new HarnessSessionError("mcp_attachment_close_failed", errors.join("; "));
  }
}

async function stopAdapterSessionAfterStartFailure(
  adapter: HarnessAdapter,
  sessionId: string,
  reason: string,
): Promise<void> {
  await adapter.stopSession({ sessionId, reason });
}

async function cleanupAdapterSessionStartFailure(
  adapter: HarnessAdapter,
  sessionId: string,
  mcpClients: HarnessMcpClient[],
  reason: string,
  originalError: unknown,
): Promise<void> {
  const cleanupErrors: string[] = [];
  try {
    await closeMcpClientsBestEffort(mcpClients);
  } catch (error: unknown) {
    cleanupErrors.push(error instanceof Error ? error.message : "MCP attachment close failed.");
  }

  try {
    await stopAdapterSessionAfterStartFailure(adapter, sessionId, reason);
  } catch (error: unknown) {
    cleanupErrors.push(error instanceof Error ? `adapter stop failed: ${error.message}` : "adapter stop failed.");
  }

  if (cleanupErrors.length > 0) {
    const originalMessage: string = originalError instanceof Error ? originalError.message : "Adapter session start failed.";
    throw new HarnessSessionError("adapter_start_cleanup_failed", `${originalMessage}; cleanup failed: ${cleanupErrors.join("; ")}`);
  }
}

function nativeProviderHash(provider: ProviderInstanceConfig): string {
  return createHash("sha256").update(JSON.stringify({id: provider.id, driver: provider.driver_kind,
    ...(provider.launch_args.length ? {launch_args: provider.launch_args} : {}),
    executable: provider.executable_path ?? provider.driver_kind, home: provider.home, env: Object.fromEntries(Object.entries(provider.env).sort(([a], [b]) => a.localeCompare(b)))})).digest("hex");
}
function nativeConfigurationBaseHash(payload: HcpSessionStartPayload, provider: ProviderInstanceConfig, toolsets: HarnessMcpToolset[],
  inheritance: import("@harness-control/protocol").HarnessConfigurationInheritance | undefined): string {
  const lease = payload.local_capability_lease;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return createHash("sha256").update(JSON.stringify({binding: nativeBindingHash({...payload, sandbox_mode: "read_only", approval_policy: "ask", execution_profile: "isolated"}, provider, toolsets),
    inheritance: Object.fromEntries(Object.entries(inheritance ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    local_capability_lease: lease ? canonical({actor_id: lease.actor_id, execution_host_id: lease.execution_host_id, policy_version: lease.policy_version,
      capabilities: lease.capabilities.map(grant => ({...grant, scopes: grant.scopes.slice().sort()})).sort((a, b) => a.id.localeCompare(b.id))}) : null})).digest("hex");
}
function nativeBindingHash(payload: HcpSessionStartPayload, provider: ProviderInstanceConfig, toolsets: HarnessMcpToolset[]): string {
  const scope = {provider: {id: provider.id, driver: provider.driver_kind, executable: provider.executable_path ?? provider.driver_kind,
    ...(provider.launch_args.length ? {launch_args: provider.launch_args} : {}),
    home: provider.home, env: provider.env}, workspace: {id: payload.workspace_id, cwd: payload.cwd},
    sandbox: payload.sandbox_mode, approval: payload.approval_policy,
    ...(payload.execution_profile && payload.execution_profile !== "isolated" ? {execution_profile: payload.execution_profile} : {}),
    ...(payload.instructions && Object.keys(payload.instructions).length ? {instructions: payload.instructions} : {}),
    attachments: payload.mcp_servers.map(attachment => ({name: attachment.name, transport: attachment.transport,
      ...(attachment.transport === "runner_stdio_profile" ? {profile: attachment.profile_id} : {}),
      allowed: attachment.allowed_tools?.slice().sort(), denied: attachment.denied_tools?.slice().sort()})).sort((a, b) => a.name.localeCompare(b.name)),
    tools: toolsets.map(set => ({name: set.name, tools: [...set.tools].sort((a, b) => a.name.localeCompare(b.name))})).sort((a, b) => a.name.localeCompare(b.name))};
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)])) : value;
  return createHash("sha256").update(JSON.stringify(sorted(scope))).digest("hex");
}

export {
  HarnessAdapterError,
  HarnessAdapterRegistry,
  createDefaultHarnessAdapterRegistry,
  type HarnessAdapter,
  type HarnessAdapterCancelInput,
  type HarnessAdapterConversationInput,
  type HarnessActiveTurnControls,
  type HarnessConversationOperation,
  type HarnessAdapterEvent,
  type HarnessAdapterMcpServer,
  type HarnessAdapterSession,
  type HarnessAdapterStartInput,
  type HarnessAdapterStopInput,
  type HarnessAdapterTurnInput,
} from "./adapters.js";
export type { ProviderDriverStatus } from "../host/provider-registry.js";
