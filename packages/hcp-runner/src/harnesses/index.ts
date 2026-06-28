import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type {
  HcpHarnessEventPayload,
  HostResumeCursor,
  HcpSessionStartPayload,
  HcpTurnSendPayload,
  LocalCapabilityLease,
  McpServerAttachment,
} from "@hcp-runner/protocol";

import type { AuditLogger } from "../audit/index.js";
import type { ProviderInstanceConfig, RunnerConfig } from "../config/index.js";
import type { ProviderDriverStatus } from "../host/provider-registry.js";
import { LocalCapabilityLeaseManager } from "../local-actions/index.js";
import { McpAttachmentClient, type McpProofSigner } from "../mcp/McpAttachmentClient.js";
import {
  HarnessAdapterRegistry,
  createDefaultHarnessAdapterRegistry,
  type HarnessAdapter,
  type HarnessAdapterEvent,
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
  workspaceId: string;
  providerInstanceId: string;
  driverKind: string;
  cwd: string;
  startPayload: HcpSessionStartPayload;
  adapter: HarnessAdapter;
  adapterSession: HarnessAdapterSession;
  localCapabilityLease?: LocalCapabilityLease;
  mcpClients: HarnessMcpClient[];
};

export type HarnessMcpClient = {
  connect(): Promise<void>;
  close(): Promise<void>;
};

export type HarnessMcpClientRequest = {
  attachment: McpServerAttachment;
  sessionId: string;
  hostId: string;
  providerInstanceId: string;
  workspaceId: string;
  proofSigner?: McpProofSigner;
};

export type HarnessMcpClientFactory = (request: HarnessMcpClientRequest) => HarnessMcpClient;

export type HarnessSessionManagerOptions = {
  hostId?: string;
  mcpProofSigner?: McpProofSigner;
  mcpClientFactory?: HarnessMcpClientFactory;
  auditLogger?: AuditLogger;
  replayRetentionEventsPerSession?: number;
  adapterRegistry?: HarnessAdapterRegistry;
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

export class HarnessSessionManager {
  readonly #config: RunnerConfig;
  readonly #hostId: string;
  readonly #localCapabilities: LocalCapabilityLeaseManager;
  readonly #mcpProofSigner: McpProofSigner | undefined;
  readonly #mcpClientFactory: HarnessMcpClientFactory;
  readonly #auditLogger: AuditLogger | undefined;
  readonly #replayRetentionEventsPerSession: number;
  readonly #adapterRegistry: HarnessAdapterRegistry;
  readonly #sessions = new Map<string, HarnessSession>();
  readonly #nextSequences = new Map<string, number>();
  readonly #replayBuffers = new Map<string, HcpHarnessEventPayload[]>();

  constructor(config: RunnerConfig, options: string | HarnessSessionManagerOptions = {}) {
    const resolvedOptions: HarnessSessionManagerOptions = typeof options === "string" ? { hostId: options } : options;
    this.#config = config;
    this.#hostId = resolvedOptions.hostId ?? config.host_id ?? config.runner_id;
    this.#localCapabilities = new LocalCapabilityLeaseManager(config, this.#hostId);
    this.#mcpProofSigner = resolvedOptions.mcpProofSigner;
    this.#mcpClientFactory = resolvedOptions.mcpClientFactory ?? defaultMcpClientFactory;
    this.#auditLogger = resolvedOptions.auditLogger;
    this.#replayRetentionEventsPerSession = resolvedOptions.replayRetentionEventsPerSession ?? 512;
    this.#adapterRegistry = resolvedOptions.adapterRegistry ?? createDefaultHarnessAdapterRegistry();
  }

  activeSessionCount(): number {
    return this.#sessions.size;
  }

  providerDriverStatuses(): Promise<ProviderDriverStatus[]> {
    return this.#adapterRegistry.probeProviders(this.#config.provider_instances);
  }

  resumeCursor(): HostResumeCursor | undefined {
    const sessions = Array.from(this.#replayBuffers.entries())
      .map(([sessionId, events]) => {
        const lastEvent: HcpHarnessEventPayload | undefined = events.at(-1);
        return lastEvent ? { session_id: sessionId, last_event_sequence: lastEvent.sequence } : undefined;
      })
      .filter((entry): entry is { session_id: string; last_event_sequence: number } => entry !== undefined);
    return sessions.length > 0 ? { sessions } : undefined;
  }

  replayEventsAfter(cursor: HostResumeCursor): HcpHarnessEventPayload[] {
    const events: HcpHarnessEventPayload[] = [];
    for (const sessionCursor of cursor.sessions) {
      const buffer: HcpHarnessEventPayload[] | undefined = this.#replayBuffers.get(sessionCursor.session_id);
      if (!buffer || buffer.length === 0) {
        events.push(this.#replayUnavailableEvent(sessionCursor.session_id, sessionCursor.last_event_sequence, "no_replay_buffer"));
        continue;
      }

      const firstSequence: number | undefined = buffer[0]?.sequence;
      const lastSequence: number | undefined = buffer.at(-1)?.sequence;
      if (
        firstSequence === undefined ||
        lastSequence === undefined ||
        sessionCursor.last_event_sequence < firstSequence - 1 ||
        sessionCursor.last_event_sequence > lastSequence
      ) {
        events.push(this.#replayUnavailableEvent(sessionCursor.session_id, sessionCursor.last_event_sequence, "cursor_outside_retention"));
        continue;
      }

      events.push(
        ...buffer.filter(
          (event: HcpHarnessEventPayload): boolean => event.sequence > sessionCursor.last_event_sequence,
        ),
      );
    }
    return events;
  }

  async startSession(payload: HcpSessionStartPayload): Promise<HcpHarnessEventPayload[]> {
    if (this.#sessions.has(payload.session_id)) {
      throw new HarnessSessionError("session_exists", `Session '${payload.session_id}' already exists.`);
    }

    const provider: ProviderInstanceConfig = this.#requireProvider(payload.provider_instance_id, payload.driver_kind);
    await this.#assertWorkspaceAllowed(payload.workspace_id, payload.cwd);
    const localCapabilityLease: LocalCapabilityLease | undefined = this.#localCapabilities.validateSessionLease(
      payload,
      provider,
    );
    const adapter: HarnessAdapter = this.#adapterRegistry.require(provider.driver_kind);
    await adapter.validateStart({ payload, provider });
    const mcpClients: HarnessMcpClient[] = await this.#attachMcpServers(payload);

    let adapterSession: HarnessAdapterSession;
    try {
      adapterSession = await adapter.startSession({ payload, provider });
    } catch (error: unknown) {
      await cleanupAdapterSessionStartFailure(adapter, payload.session_id, mcpClients, "adapter_start_failed", error);
      throw error;
    }

    const session: HarnessSession = {
      sessionId: payload.session_id,
      workspaceId: payload.workspace_id,
      providerInstanceId: provider.id,
      driverKind: provider.driver_kind,
      cwd: payload.cwd,
      startPayload: payload,
      adapter,
      adapterSession,
      ...(localCapabilityLease ? { localCapabilityLease } : {}),
      mcpClients,
    };
    this.#sessions.set(payload.session_id, session);
    this.#nextSequences.set(payload.session_id, 1);
    this.#replayBuffers.set(payload.session_id, []);

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

  async sendTurn(payload: HcpTurnSendPayload): Promise<HcpHarnessEventPayload[]> {
    const session: HarnessSession | undefined = this.#sessions.get(payload.session_id);
    if (!session) {
      throw new HarnessSessionError("session_not_found", `Session '${payload.session_id}' is not active.`);
    }

    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.sendTurn({
      payload,
      session: session.adapterSession,
      startPayload: session.startPayload,
      provider: this.#requireProvider(session.providerInstanceId, session.driverKind),
    });
    const events: HcpHarnessEventPayload[] = adapterEvents.map((event: HarnessAdapterEvent): HcpHarnessEventPayload =>
      this.#event(payload.session_id, event.turn_id ?? payload.turn_id, event.event_type, event.data),
    );
    await this.#recordAudit({
      event: "turn.completed",
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

  async cancelTurn(sessionId: string, turnId: string): Promise<HcpHarnessEventPayload[]> {
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

    const adapterEvents: HarnessAdapterEvent[] = await session.adapter.cancelTurn({ sessionId, turnId });
    return adapterEvents.map((event: HarnessAdapterEvent): HcpHarnessEventPayload =>
      this.#event(sessionId, event.turn_id ?? turnId, event.event_type, event.data),
    );
  }

  async stopSession(sessionId: string, reason: string | undefined): Promise<HcpHarnessEventPayload[]> {
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

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
    this.#nextSequences.delete(sessionId);
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

  async #attachMcpServers(payload: HcpSessionStartPayload): Promise<HarnessMcpClient[]> {
    const clients: HarnessMcpClient[] = [];
    try {
      for (const attachment of payload.mcp_servers) {
        const client: HarnessMcpClient = this.#mcpClientFactory({
          attachment,
          sessionId: payload.session_id,
          hostId: this.#hostId,
          providerInstanceId: payload.provider_instance_id,
          workspaceId: payload.workspace_id,
          ...(this.#mcpProofSigner ? { proofSigner: this.#mcpProofSigner } : {}),
        });
        await client.connect();
        clients.push(client);
      }
    } catch (error: unknown) {
      await closeMcpClientsBestEffort(clients);
      throw error;
    }

    return clients;
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
    const sequence: number = this.#nextSequences.get(sessionId) ?? 1;
    const payload: HcpHarnessEventPayload = {
      session_id: sessionId,
      sequence,
      event_type: eventType,
      created_at: new Date().toISOString(),
      data,
    };
    this.#nextSequences.set(sessionId, sequence + 1);

    if (turnId) {
      payload.turn_id = turnId;
    }

    this.#storeReplayEvent(payload);
    return payload;
  }

  #storeReplayEvent(event: HcpHarnessEventPayload): void {
    const buffer: HcpHarnessEventPayload[] = this.#replayBuffers.get(event.session_id) ?? [];
    buffer.push(event);
    while (buffer.length > this.#replayRetentionEventsPerSession) {
      buffer.shift();
    }
    this.#replayBuffers.set(event.session_id, buffer);
  }

  #replayUnavailableEvent(
    sessionId: string,
    requestedAfterSequence: number,
    reason: string,
  ): HcpHarnessEventPayload {
    const event: HcpHarnessEventPayload = {
      session_id: sessionId,
      sequence: (this.#replayBuffers.get(sessionId)?.at(-1)?.sequence ?? 0) + 1,
      event_type: "session.replay_unavailable",
      created_at: new Date().toISOString(),
      data: {
        requested_after_sequence: requestedAfterSequence,
        reason,
      },
    };
    this.#storeReplayEvent(event);
    return event;
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

  return new McpAttachmentClient(request.attachment, {
    proofContext: {
      session_id: request.sessionId,
      host_id: request.hostId,
      provider_instance_id: request.providerInstanceId,
      workspace_id: request.workspaceId,
      server_id: request.attachment.name,
    },
    proofSigner: request.proofSigner,
  });
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
