import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type {
  HcpHarnessEventPayload,
  HcpSessionStartPayload,
  HcpTurnSendPayload,
  LocalCapabilityLease,
  McpServerAttachment,
} from "@hcp-runner/protocol";

import type { ProviderInstanceConfig, RunnerConfig } from "../config/index.js";
import { LocalCapabilityLeaseManager } from "../local-actions/index.js";
import { McpAttachmentClient, type McpProofSigner } from "../mcp/McpAttachmentClient.js";

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
  readonly #sessions = new Map<string, HarnessSession>();
  readonly #nextSequences = new Map<string, number>();

  constructor(config: RunnerConfig, options: string | HarnessSessionManagerOptions = {}) {
    const resolvedOptions: HarnessSessionManagerOptions = typeof options === "string" ? { hostId: options } : options;
    this.#config = config;
    this.#hostId = resolvedOptions.hostId ?? config.host_id ?? config.runner_id;
    this.#localCapabilities = new LocalCapabilityLeaseManager(config, this.#hostId);
    this.#mcpProofSigner = resolvedOptions.mcpProofSigner;
    this.#mcpClientFactory = resolvedOptions.mcpClientFactory ?? defaultMcpClientFactory;
  }

  activeSessionCount(): number {
    return this.#sessions.size;
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
    const mcpClients: HarnessMcpClient[] = await this.#attachMcpServers(payload);

    const session: HarnessSession = {
      sessionId: payload.session_id,
      workspaceId: payload.workspace_id,
      providerInstanceId: provider.id,
      driverKind: provider.driver_kind,
      cwd: payload.cwd,
      ...(localCapabilityLease ? { localCapabilityLease } : {}),
      mcpClients,
    };
    this.#sessions.set(payload.session_id, session);
    this.#nextSequences.set(payload.session_id, 1);

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

    return events;
  }

  sendTurn(payload: HcpTurnSendPayload): HcpHarnessEventPayload[] {
    const session: HarnessSession | undefined = this.#sessions.get(payload.session_id);
    if (!session) {
      throw new HarnessSessionError("session_not_found", `Session '${payload.session_id}' is not active.`);
    }

    return [
      this.#event(payload.session_id, payload.turn_id, "turn.started", {
        provider_instance_id: session.providerInstanceId,
        input_length: payload.input.length,
        ...(payload.model_selection ? { model_selection: payload.model_selection } : {}),
      }),
      this.#event(payload.session_id, payload.turn_id, "turn.completed", {
        status: "accepted",
        final_output: {
          final_text: "",
        },
      }),
    ];
  }

  cancelTurn(sessionId: string, turnId: string): HcpHarnessEventPayload[] {
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

    return [
      this.#event(sessionId, turnId, "turn.cancelled", {
        status: "cancelled",
        final_output: {
          exit_reason: "cancel_requested",
        },
      }),
    ];
  }

  async stopSession(sessionId: string, reason: string | undefined): Promise<HcpHarnessEventPayload[]> {
    const session: HarnessSession | undefined = this.#sessions.get(sessionId);
    if (!session) {
      throw new HarnessSessionError("session_not_found", `Session '${sessionId}' is not active.`);
    }

    const events: HcpHarnessEventPayload[] = [];
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
      return;
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

    return payload;
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
