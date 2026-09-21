import type { HarnessMcpToolset, HarnessMcpContinuation } from "./adapters/types.js";
import { HarnessMcpReview } from "./mcp-review.js";
import type { PersistedMcpReview } from "../state/mcp-review.js";
import type { McpInputReply } from "../mcp/input-required.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

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
  sessionId: string;
  cancelRequested: boolean;
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

export class HarnessSessionManager {
  readonly #config: RunnerConfig;
  readonly #hostId: string;
  readonly #localCapabilities: LocalCapabilityLeaseManager;
  readonly #localCapabilityEngine: LocalCapabilityEngine;
  readonly #mcpProofSigner: McpProofSigner | undefined;
  readonly #mcpClientFactory: HarnessMcpClientFactory;
  readonly #auditLogger: AuditLogger | undefined;
  readonly #stateStore: RunnerStateStore;
  readonly #adapterRegistry: HarnessAdapterRegistry;
  readonly #sessions = new Map<string, HarnessSession>();
  readonly #mcpReviews = new Map<string, HarnessMcpReview>();
  readonly #mcpResumes = new Set<string>();
  #restoredMcpReviews = false;
  readonly #turnIdsBySession = new Map<string, Set<string>>();

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

  activeSessionCount(): number {
    return this.#sessions.size;
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
    return this.#serializeWorkspace(() => this.#startSession(payload));
  }

  async #startSession(payload: HcpSessionStartPayload): Promise<HcpHarnessEventPayload[]> {
    if (payload.workspace_preflight !== undefined) {
      throw new HarnessSessionError("preflight_unsupported", "Workspace preflight expectations are not implemented by this runner.");
    }
    if (this.#sessions.has(payload.session_id) || this.#stateStore.hasSessionEvents(payload.session_id)) {
      throw new HarnessSessionError("session_exists", `Session '${payload.session_id}' already exists.`);
    }

    let prepared: {session: HarnessSession; discoveredTools: HarnessMcpToolDiscovery[]};
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
        model_selection: payload.model_selection,
        mcp_server_count: payload.mcp_servers.length,
        local_capabilities: localCapabilityLease?.capabilities.map((capability) => capability.id) ?? [],
      }),
    ];

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

  async #prepareSession(payload: HcpSessionStartPayload): Promise<{session: HarnessSession; discoveredTools: HarnessMcpToolDiscovery[]}> {
    const provider: ProviderInstanceConfig = this.#requireProvider(payload.provider_instance_id, payload.driver_kind);
    await this.#assertWorkspaceAllowed(payload.workspace_id, payload.cwd);
    const localCapabilityLease: LocalCapabilityLease | undefined = this.#localCapabilities.validateSessionLease(
      payload,
      provider,
    );
    const adapter: HarnessAdapter = this.#adapterRegistry.require(provider.driver_kind);
    await adapter.validateStart({ payload, provider });
    const mcpAttachments: HarnessMcpAttachmentResult = await this.#attachMcpServers(payload, provider);
    const adapterStartPayload: HcpSessionStartPayload = payload;

    let adapterSession: HarnessAdapterSession;
    try {
      if (!adapter.durableMcpContinuation && mcpAttachments.toolsets.some(set => set.tools.some(tool => tool.review_policy))) {
        throw new HarnessAdapterError("mcp_review_unavailable", "This adapter does not support durable MCP review.");
      }
      adapterSession = await adapter.startSession({
        payload: adapterStartPayload,
        provider,
        mcpServers: mcpAttachments.adapterAttachments,
      });
    } catch (error: unknown) {
      await cleanupAdapterSessionStartFailure(adapter, payload.session_id, mcpAttachments.clients, "adapter_start_failed", error);
      throw new SessionStartCleanedError(error, "adapter_start_failed");
    }

    const session: HarnessSession = {
      sessionId: payload.session_id,
      cancelRequested: false,
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
    };
    return {session, discoveredTools: mcpAttachments.discoveredTools};
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
    const live = this.#mcpReviews.get(response.session_id);
    if (live) {live.decide(response); return {kind: "live"};}
    const retained = this.#stateStore.getMcpReview(response.session_id);
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
    const live = this.#mcpReviews.get(response.session_id);
    if (live) {live.respondToInput(response); return {kind: "live"};}
    const retained = this.#stateStore.getMcpReview(response.session_id);
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
      const {session} = await this.#prepareSession(retained.start);
      let decided: PersistedMcpReview;
      try {decided = decide();} catch (error: unknown) {
        await cleanupAdapterSessionStartFailure(session.adapter, sessionId, session.mcpClients, "mcp_resume_failed", error);
        throw error;
      }
      this.#sessions.set(session.sessionId, session);
      this.#turnIdsBySession.set(session.sessionId, new Set([retained.turn.turn_id]));
      this.#mcpReviews.set(session.sessionId, owner);
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
      const last = this.#lastSavedEvent(review.start.session_id);
      if (last?.event_type === "session.exited") {
        this.#stateStore.clearMcpReview(review.start.session_id, review.request_id);
        continue;
      }
      if (last && terminalTurnEvents.has(last.event_type)) {
        for (const event of this.#retireSavedReview(review, {kind: "closed"})) onEvent(event);
        continue;
      }
      if (this.#sessions.has(review.start.session_id) || review.outcome.phase === "waiting" || review.outcome.phase === "input_waiting") continue;
      if (review.outcome.phase === "dispatching" || review.outcome.phase === "input_resuming") {
        for (const event of this.#retireSavedReview(review, {kind: "failed", code: "mcp_review_outcome_unknown",
          message: "The reviewed call may have dispatched before the runner stopped; automatic retry is forbidden."})) onEvent(event);
        continue;
      }
      try {
        const resolution = await this.respondToMcpReview({session_id: review.start.session_id, turn_id: review.turn.turn_id,
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
    else if (decided.outcome.phase === "completed") {
      outcome = {kind: "completed", result: mcpToolCallResultSchema.parse(JSON.parse(decided.outcome.result_json))};
    } else if ((decided.outcome.phase === "dispatching" && previous.outcome.phase === "waiting") ||
        (decided.outcome.phase === "input_resuming" && previous.outcome.phase === "input_waiting")) {
      const toolset = session.mcpToolsets.find(item => item.name === action.attachment_name);
      if (!toolset || !toolset.tools.some(tool => tool.name === action.tool_name)) {
        throw new HarnessAdapterError("mcp_review_selection_changed", "The reviewed tool is no longer selected.");
      }
      const grant = decided.outcome.phase === "dispatching" || decided.outcome.review_actor_id !== undefined
        ? {request_id: decided.request_id, action_json: decided.action_json} : undefined;
      const result = await reviewer.invoke({attachment_name: action.attachment_name, tool_name: action.tool_name,
        arguments: action.arguments, native_thread_id: decided.native_thread_id, native_turn_id: decided.native_turn_id,
        native_call_id: decided.native_call_id}, toolset.callTool.bind(toolset), new AbortController().signal, grant,
        decided.outcome.phase === "input_resuming" ? decided.outcome.reply : undefined);
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
    await Promise.resolve();
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
    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.sendTurn({
      payload,
      session: session.adapterSession,
      startPayload: session.startPayload,
      provider: this.#requireProvider(session.providerInstanceId, session.driverKind),
      mcpServers: session.mcpServers,
      mcpToolsets: session.mcpToolsets,
      ...(reviewer ? {reviewMcpTool: reviewer} : {}),
      ...(continuation ? {mcpContinuation: continuation} : {}),
      emitEvent: emitAdapterEvent,
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
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      const review = this.#stateStore.getMcpReview(sessionId);
      if (review?.turn.turn_id === turnId) return this.#retireSavedReview(review, {kind: "cancelled"});
      if (this.#lastSavedEvent(sessionId)?.event_type === "session.exited") return [];
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

    session.cancelRequested = true;
    this.#mcpReviews.get(sessionId)?.interrupt();
    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.cancelTurn({ sessionId, turnId });
    const last = this.#lastSavedEvent(sessionId);
    if (adapterEvents.length === 0 && this.#mcpReviews.has(sessionId) &&
        (!last || !terminalTurnEvents.has(last.event_type))) {
      return [this.#event(sessionId, turnId, "turn.cancelled", {status: "cancelled", final_output: {exit_reason: "cancel_requested"}})];
    }
    return adapterEvents.map((event: HarnessAdapterEvent): HcpHarnessEventPayload =>
      this.#event(sessionId, event.turn_id ?? turnId, event.event_type, event.data),
    );
  }

  async stopSession(sessionId: string, reason: string | undefined): Promise<HcpHarnessEventPayload[]> {
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      const review = this.#stateStore.getMcpReview(sessionId);
      if (review) return this.#retireSavedReview(review, {kind: "cancelled"});
      if (this.#lastSavedEvent(sessionId)?.event_type === "session.exited") return [];
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

    session.cancelRequested = true;
    this.#mcpReviews.get(sessionId)?.interrupt();
    const events: HcpHarnessEventPayload[] = [];
    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.stopSession({ sessionId, ...(reason ? { reason } : {}) });
    events.push(
      ...adapterEvents.map((event: HarnessAdapterEvent): HcpHarnessEventPayload =>
        this.#event(sessionId, event.turn_id, event.event_type, event.data),
      ),
    );
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
    this.#mcpReviews.delete(sessionId);
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

  #requireProvider(providerInstanceId: string, driverKind: string): ProviderInstanceConfig {
    const provider: ProviderInstanceConfig | undefined = this.#config.provider_instances.find(
      (candidate: ProviderInstanceConfig): boolean => candidate.id === providerInstanceId,
    );
    if (!provider) {
      throw new HarnessSessionError("provider_not_found", `Provider '${providerInstanceId}' is not configured.`);
    }

    if (!provider.enabled) {
      throw new HarnessSessionError("provider_disabled", `Provider '${providerInstanceId}' is disabled.`);
    }

    if (provider.driver_kind !== driverKind) {
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
  ): HcpHarnessEventPayload {
    const sequence: number = this.#stateStore.nextEventSequence(sessionId);
    const payload: HcpHarnessEventPayload = {
      session_id: sessionId,
      sequence,
      event_type: eventType,
      created_at: new Date().toISOString(),
      data,
    };
    if (turnId) {
      payload.turn_id = turnId;
    }

    const retained = this.#stateStore.getMcpReview(sessionId);
    if (terminalTurnEvents.has(eventType) && (!retained || retained.turn.turn_id === turnId)) {
      if (retained) this.#stateStore.clearMcpReview(sessionId, retained.request_id, [payload]);
      else this.#stateStore.appendEvent(payload);
      this.#mcpReviews.delete(sessionId);
    } else {
      this.#stateStore.appendEvent(payload);
    }
    return payload;
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

export {
  HarnessAdapterError,
  HarnessAdapterRegistry,
  createDefaultHarnessAdapterRegistry,
  type HarnessAdapter,
  type HarnessAdapterCancelInput,
  type HarnessAdapterEvent,
  type HarnessAdapterMcpServer,
  type HarnessAdapterSession,
  type HarnessAdapterStartInput,
  type HarnessAdapterStopInput,
  type HarnessAdapterTurnInput,
} from "./adapters.js";
export type { ProviderDriverStatus } from "../host/provider-registry.js";
