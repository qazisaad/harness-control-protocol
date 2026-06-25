import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type {
  CommandPolicy,
  HcpSessionStartPayload,
  LocalCapabilityGrant,
  LocalCapabilityLease,
} from "@hcp-runner/protocol";

import type { LocalCapabilityConfig, ProviderInstanceConfig, RunnerConfig } from "../config/index.js";

export type LocalCapabilityActionRequest = {
  session_id: string;
  turn_id: string;
  workspace_id: string;
  provider_instance_id: string;
  capability_id: string;
  scope: string;
  action: string;
};

export type LocalFilesystemAction = "read" | "list" | "write" | "create" | "delete" | "patch";

export type LocalFilesystemAuthorizationRequest = {
  session_id: string;
  turn_id: string;
  workspace_id: string;
  provider_instance_id: string;
  action: LocalFilesystemAction;
};

export type LocalGitAction =
  | "status"
  | "diff"
  | "branch"
  | "commit_metadata"
  | "commit"
  | "checkout"
  | "push";

export type LocalGitAuthorizationRequest = {
  session_id: string;
  turn_id: string;
  workspace_id: string;
  provider_instance_id: string;
  action: LocalGitAction;
};

export type LocalShellAuthorizationRequest = {
  session_id: string;
  turn_id: string;
  workspace_id: string;
  provider_instance_id: string;
  executable: string;
  argv: string[];
  cwd: string;
  workspace_root: string;
  use_shell: boolean;
  timeout_seconds: number;
};

export type LocalDevServerAuthorizationRequest = {
  session_id: string;
  turn_id: string;
  workspace_id: string;
  provider_instance_id: string;
  action: "start" | "stop" | "inspect";
};

export class LocalCapabilityPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalCapabilityPolicyError";
  }
}

export class LocalCapabilityLeaseManager {
  readonly #config: RunnerConfig;
  readonly #hostId: string;
  readonly #now: () => Date;
  readonly #revokedLeaseIds = new Set<string>();
  readonly #callCounts = new Map<string, number>();

  constructor(config: RunnerConfig, hostId: string, now: () => Date = () => new Date()) {
    this.#config = config;
    this.#hostId = hostId;
    this.#now = now;
  }

  validateSessionLease(payload: HcpSessionStartPayload, provider: ProviderInstanceConfig): LocalCapabilityLease | undefined {
    const lease: LocalCapabilityLease | undefined = payload.local_capability_lease;
    if (!lease) {
      return undefined;
    }

    this.#assertLeaseBinding(lease, payload);
    this.#assertLeaseUsable(lease);

    for (const grant of lease.capabilities) {
      const configuredCapability: LocalCapabilityConfig = this.#requireConfiguredCapability(grant.id);
      this.#assertGrantScopesAllowed(configuredCapability, grant);
      this.#assertProviderSupportsCapability(provider, grant.id);
    }

    return lease;
  }

  revokeLease(leaseId: string): void {
    this.#revokedLeaseIds.add(leaseId);
  }

  assertActionAllowed(lease: LocalCapabilityLease, request: LocalCapabilityActionRequest): LocalCapabilityGrant {
    this.#assertLeaseUsable(lease);

    if (request.session_id !== lease.hcp_session_id) {
      throw new LocalCapabilityPolicyError("local_capability_session_mismatch", "Local capability action session does not match the lease.");
    }
    if (request.workspace_id !== lease.workspace_id) {
      throw new LocalCapabilityPolicyError("local_capability_workspace_mismatch", "Local capability action workspace does not match the lease.");
    }
    if (request.provider_instance_id !== lease.provider_instance_id) {
      throw new LocalCapabilityPolicyError("local_capability_provider_mismatch", "Local capability action provider does not match the lease.");
    }

    const grant: LocalCapabilityGrant | undefined = lease.capabilities.find(
      (candidate: LocalCapabilityGrant): boolean => candidate.id === request.capability_id,
    );
    if (!grant) {
      throw new LocalCapabilityPolicyError(
        "local_capability_not_granted",
        `Capability '${request.capability_id}' is not granted by lease '${lease.lease_id}'.`,
      );
    }
    if (!grant.scopes.includes(request.scope)) {
      throw new LocalCapabilityPolicyError(
        "local_capability_scope_not_granted",
        `Scope '${request.scope}' is not granted for capability '${request.capability_id}'.`,
      );
    }

    const configuredCapability: LocalCapabilityConfig = this.#requireConfiguredCapability(request.capability_id);
    if (!configuredCapability.scopes.includes(request.scope)) {
      throw new LocalCapabilityPolicyError(
        "local_capability_scope_unavailable",
        `Scope '${request.scope}' is not available for capability '${request.capability_id}' on this runner.`,
      );
    }

    const countKey = `${lease.lease_id}:${grant.id}`;
    const existingCallCount: number = this.#callCounts.get(countKey) ?? 0;
    if (grant.max_calls !== undefined && existingCallCount >= grant.max_calls) {
      throw new LocalCapabilityPolicyError(
        "local_capability_max_calls_exceeded",
        `Capability '${request.capability_id}' exceeded its max call count.`,
      );
    }

    this.#callCounts.set(countKey, existingCallCount + 1);
    return grant;
  }

  #assertLeaseBinding(lease: LocalCapabilityLease, payload: HcpSessionStartPayload): void {
    if (lease.hcp_session_id !== payload.session_id) {
      throw new LocalCapabilityPolicyError("local_capability_session_mismatch", "Local capability lease session does not match the HCP session.");
    }
    if (lease.execution_host_id !== this.#hostId) {
      throw new LocalCapabilityPolicyError("local_capability_host_mismatch", "Local capability lease host does not match this runner.");
    }
    if (lease.provider_instance_id !== payload.provider_instance_id) {
      throw new LocalCapabilityPolicyError("local_capability_provider_mismatch", "Local capability lease provider does not match the selected provider.");
    }
    if (lease.workspace_id !== payload.workspace_id) {
      throw new LocalCapabilityPolicyError("local_capability_workspace_mismatch", "Local capability lease workspace does not match the selected workspace.");
    }
  }

  #assertLeaseUsable(lease: LocalCapabilityLease): void {
    if (this.#revokedLeaseIds.has(lease.lease_id)) {
      throw new LocalCapabilityPolicyError("local_capability_lease_revoked", `Local capability lease '${lease.lease_id}' has been revoked.`);
    }

    const expiresAt: number = Date.parse(lease.expires_at);
    if (Number.isNaN(expiresAt) || expiresAt <= this.#now().getTime()) {
      throw new LocalCapabilityPolicyError("local_capability_lease_expired", `Local capability lease '${lease.lease_id}' has expired.`);
    }
  }

  #requireConfiguredCapability(capabilityId: string): LocalCapabilityConfig {
    const capability: LocalCapabilityConfig | undefined = this.#config.local_capabilities.find(
      (candidate: LocalCapabilityConfig): boolean => candidate.id === capabilityId,
    );
    if (!capability) {
      throw new LocalCapabilityPolicyError(
        "local_capability_unavailable",
        `Capability '${capabilityId}' is not configured by this runner.`,
      );
    }
    if (capability.status !== "available") {
      throw new LocalCapabilityPolicyError(
        "local_capability_unavailable",
        `Capability '${capabilityId}' is ${capability.status}.`,
      );
    }
    return capability;
  }

  #assertProviderSupportsCapability(provider: ProviderInstanceConfig, capabilityId: string): void {
    if (!provider.local_capabilities.includes(capabilityId as ProviderInstanceConfig["local_capabilities"][number])) {
      throw new LocalCapabilityPolicyError(
        "local_capability_provider_unsupported",
        `Provider '${provider.id}' does not support capability '${capabilityId}'.`,
      );
    }
  }

  #assertGrantScopesAllowed(configuredCapability: LocalCapabilityConfig, grant: LocalCapabilityGrant): void {
    const unavailableScopes: string[] = grant.scopes.filter(
      (scope: string): boolean => !configuredCapability.scopes.includes(scope),
    );
    if (unavailableScopes.length > 0) {
      throw new LocalCapabilityPolicyError(
        "local_capability_scope_unavailable",
        `Capability '${grant.id}' requested unavailable scopes: ${unavailableScopes.join(", ")}.`,
      );
    }
  }
}

export class LocalCapabilityEngine {
  constructor(readonly leaseManager: LocalCapabilityLeaseManager) {}

  authorizeFilesystemAction(
    lease: LocalCapabilityLease,
    request: LocalFilesystemAuthorizationRequest,
  ): LocalCapabilityGrant {
    return this.leaseManager.assertActionAllowed(lease, {
      session_id: request.session_id,
      turn_id: request.turn_id,
      workspace_id: request.workspace_id,
      provider_instance_id: request.provider_instance_id,
      capability_id: "filesystem",
      scope: filesystemScopeForAction(request.action),
      action: request.action,
    });
  }

  authorizeGitAction(lease: LocalCapabilityLease, request: LocalGitAuthorizationRequest): LocalCapabilityGrant {
    return this.leaseManager.assertActionAllowed(lease, {
      session_id: request.session_id,
      turn_id: request.turn_id,
      workspace_id: request.workspace_id,
      provider_instance_id: request.provider_instance_id,
      capability_id: "git",
      scope: gitScopeForAction(request.action),
      action: request.action,
    });
  }

  async authorizeShellCommand(
    lease: LocalCapabilityLease,
    request: LocalShellAuthorizationRequest,
  ): Promise<LocalCapabilityGrant> {
    const grant: LocalCapabilityGrant = this.leaseManager.assertActionAllowed(lease, {
      session_id: request.session_id,
      turn_id: request.turn_id,
      workspace_id: request.workspace_id,
      provider_instance_id: request.provider_instance_id,
      capability_id: "shell",
      scope: "workspace",
      action: "run_command",
    });

    const policy: CommandPolicy | undefined = grant.command_policy;
    if (!policy) {
      throw new LocalCapabilityPolicyError(
        "local_capability_command_policy_required",
        "Shell actions require a structured command policy.",
      );
    }

    if (!policy.allow_shell && request.use_shell) {
      throw new LocalCapabilityPolicyError("local_capability_shell_denied", "Shell wrappers are not allowed by policy.");
    }
    if (request.timeout_seconds > policy.timeout_seconds) {
      throw new LocalCapabilityPolicyError(
        "local_capability_timeout_exceeded",
        `Requested timeout ${request.timeout_seconds}s exceeds policy timeout ${policy.timeout_seconds}s.`,
      );
    }
    if (policy.denied_executables?.includes(request.executable)) {
      throw new LocalCapabilityPolicyError(
        "local_capability_executable_denied",
        `Executable '${request.executable}' is denied by policy.`,
      );
    }
    if (policy.allowed_executables && !policy.allowed_executables.includes(request.executable)) {
      throw new LocalCapabilityPolicyError(
        "local_capability_executable_not_allowed",
        `Executable '${request.executable}' is not allowed by policy.`,
      );
    }
    if (policy.argv_patterns && !argvMatchesPolicy(request.argv, policy.argv_patterns)) {
      throw new LocalCapabilityPolicyError(
        "local_capability_argv_denied",
        `Command arguments do not match policy.`,
      );
    }
    if (policy.cwd_policy === "selected_workspace_only") {
      await assertPathInsideWorkspace(request.cwd, request.workspace_root);
    }

    return grant;
  }

  authorizeDevServerAction(
    lease: LocalCapabilityLease,
    request: LocalDevServerAuthorizationRequest,
  ): LocalCapabilityGrant {
    return this.leaseManager.assertActionAllowed(lease, {
      session_id: request.session_id,
      turn_id: request.turn_id,
      workspace_id: request.workspace_id,
      provider_instance_id: request.provider_instance_id,
      capability_id: "dev_server",
      scope: "workspace",
      action: request.action,
    });
  }
}

function filesystemScopeForAction(action: LocalFilesystemAction): string {
  return action === "read" || action === "list" ? "workspace_read" : "workspace_write";
}

function gitScopeForAction(action: LocalGitAction): string {
  return action === "status" || action === "diff" || action === "branch" || action === "commit_metadata"
    ? "workspace_read"
    : "workspace_write";
}

function argvMatchesPolicy(argv: string[], patterns: string[]): boolean {
  const commandLine: string = argv.join(" ");
  return patterns.some((pattern: string): boolean => {
    try {
      return new RegExp(pattern).test(commandLine);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new LocalCapabilityPolicyError(
          "local_capability_command_policy_invalid",
          `Command policy argv pattern '${pattern}' is invalid: ${error.message}`,
        );
      }
      throw error;
    }
  });
}

async function assertPathInsideWorkspace(path: string, workspaceRoot: string): Promise<void> {
  const resolvedPath: string = await realpathForPolicy(path);
  const resolvedWorkspace: string = await realpathForPolicy(workspaceRoot);
  const pathFromWorkspace: string = relative(resolvedWorkspace, resolvedPath);
  if (pathFromWorkspace === "" || (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace))) {
    return;
  }

  throw new LocalCapabilityPolicyError("local_capability_cwd_denied", `Path '${path}' is outside the selected workspace.`);
}

async function realpathForPolicy(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new LocalCapabilityPolicyError("local_capability_path_unresolved", `Path '${path}' could not be resolved: ${error.message}`);
    }
    throw error;
  }
}
