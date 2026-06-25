import { isAbsolute, relative, resolve } from "node:path";

import type {
  HcpHarnessEventPayload,
  HcpSessionStartPayload,
  HcpTurnSendPayload,
} from "@hcp-runner/protocol";

import type { ProviderInstanceConfig, RunnerConfig } from "../config/index.js";

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
  providerInstanceId: string;
  driverKind: string;
  cwd: string;
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
  readonly #sessions = new Map<string, HarnessSession>();
  #sequence = 0;

  constructor(config: RunnerConfig) {
    this.#config = config;
  }

  startSession(payload: HcpSessionStartPayload): HcpHarnessEventPayload[] {
    if (this.#sessions.has(payload.session_id)) {
      throw new HarnessSessionError("session_exists", `Session '${payload.session_id}' already exists.`);
    }

    const provider: ProviderInstanceConfig = this.#requireProvider(payload.provider_instance_id, payload.driver_kind);
    this.#assertWorkspaceAllowed(payload.cwd);

    const session: HarnessSession = {
      sessionId: payload.session_id,
      providerInstanceId: provider.id,
      driverKind: provider.driver_kind,
      cwd: payload.cwd,
    };
    this.#sessions.set(payload.session_id, session);

    return [
      this.#event(payload.session_id, undefined, "session.started", {
        provider_instance_id: provider.id,
        driver_kind: provider.driver_kind,
        cwd: payload.cwd,
        runtime_mode: payload.runtime_mode,
        sandbox_mode: payload.sandbox_mode,
      }),
      this.#event(payload.session_id, undefined, "session.configured", {
        model_selection: payload.model_selection,
        mcp_server_count: payload.mcp_servers.length,
      }),
    ];
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
      }),
    ];
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

  #assertWorkspaceAllowed(cwd: string): void {
    if (this.#config.workspaces.length === 0) {
      return;
    }

    const resolvedCwd: string = resolve(cwd);
    const allowed: boolean = this.#config.workspaces.some((workspace): boolean => {
      const resolvedWorkspace: string = resolve(workspace.path);
      const pathFromWorkspace: string = relative(resolvedWorkspace, resolvedCwd);
      return pathFromWorkspace === "" || (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace));
    });

    if (!allowed) {
      throw new HarnessSessionError("workspace_not_allowed", `Workspace '${cwd}' is not allowed by runner config.`);
    }
  }

  #event(
    sessionId: string,
    turnId: string | undefined,
    eventType: HcpHarnessEventPayload["event_type"],
    data: Record<string, unknown>,
  ): HcpHarnessEventPayload {
    const payload: HcpHarnessEventPayload = {
      session_id: sessionId,
      sequence: this.#sequence,
      event_type: eventType,
      created_at: new Date().toISOString(),
      data,
    };
    this.#sequence += 1;

    if (turnId) {
      payload.turn_id = turnId;
    }

    return payload;
  }
}
