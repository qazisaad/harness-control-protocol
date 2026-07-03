import type {
  HarnessModel,
  HarnessOptionDescriptor,
  HarnessProviderSnapshot,
  HcpHostCapabilitiesUpdatedPayload,
} from "@harness-control/protocol";

import type { ProviderInstanceConfig, RunnerConfig } from "../config/index.js";

export type ProviderRegistrySnapshot = {
  providers: HarnessProviderSnapshot[];
  local_capabilities: HcpHostCapabilitiesUpdatedPayload["local_capabilities"];
  workspaces: HcpHostCapabilitiesUpdatedPayload["workspaces"];
};

export type ProviderDriverStatus = {
  provider_instance_id?: string;
  driver_kind: string;
  installed: boolean;
  available: boolean;
  status?: HarnessProviderSnapshot["status"];
  authStatus?: NonNullable<HarnessProviderSnapshot["auth"]>["status"];
  version?: string;
  message?: string;
  models: HarnessModel[];
};

export type ProviderContinuationGroup = {
  key: string;
  driver_kind: string;
  provider_instance_ids: string[];
};

export class ProviderInstanceRegistry {
  readonly #config: RunnerConfig;
  readonly #driversByKind: Map<string, ProviderDriverStatus>;
  readonly #driversByProviderId: Map<string, ProviderDriverStatus>;

  constructor(config: RunnerConfig, drivers: ProviderDriverStatus[] = []) {
    this.#config = config;
    this.#driversByKind = new Map();
    this.#driversByProviderId = new Map();
    for (const driver of drivers) {
      if (driver.provider_instance_id) {
        this.#driversByProviderId.set(driver.provider_instance_id, driver);
      } else {
        this.#driversByKind.set(driver.driver_kind, driver);
      }
    }
  }

  static fromConfig(config: RunnerConfig, drivers: ProviderDriverStatus[] = []): ProviderInstanceRegistry {
    return new ProviderInstanceRegistry(config, drivers);
  }

  snapshot(now: Date = new Date()): ProviderRegistrySnapshot {
    return {
      providers: this.#config.provider_instances.map((provider: ProviderInstanceConfig) =>
        this.#snapshotProvider(provider, now),
      ),
      local_capabilities: this.#config.local_capabilities.map((capability) => ({
        id: capability.id,
        status: capability.status,
        scopes: capability.scopes,
        approval_required: capability.approval_required,
        ...(capability.message ? { message: capability.message } : {}),
      })),
      workspaces: this.#config.workspaces.map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        ...(workspace.git_remote ? { git_remote: workspace.git_remote } : {}),
      })),
    };
  }

  computeContinuationGroups(): ProviderContinuationGroup[] {
    const groups: Map<string, ProviderContinuationGroup> = new Map();
    for (const provider of this.#config.provider_instances) {
      const key: string = computeContinuationGroupKey(provider);
      const existing: ProviderContinuationGroup | undefined = groups.get(key);
      if (existing) {
        existing.provider_instance_ids.push(provider.id);
      } else {
        groups.set(key, {
          key,
          driver_kind: provider.driver_kind,
          provider_instance_ids: [provider.id],
        });
      }
    }
    return Array.from(groups.values());
  }

  #snapshotProvider(provider: ProviderInstanceConfig, now: Date): HarnessProviderSnapshot {
    const driver: ProviderDriverStatus | undefined =
      this.#driversByProviderId.get(provider.id) ?? this.#driversByKind.get(provider.driver_kind);
    const enabled: boolean = provider.enabled;
    const installed: boolean = driver?.installed ?? false;
    const available: boolean = enabled && Boolean(driver?.available);
    const status: HarnessProviderSnapshot["status"] = enabled
      ? driver?.status ?? (available ? "ready" : "unavailable")
      : "disabled";

    const snapshot: HarnessProviderSnapshot = {
      provider_instance_id: provider.id,
      driver_kind: provider.driver_kind,
      ...(provider.display_name ? { display_name: provider.display_name } : {}),
      ...(provider.accent_color ? { accent_color: provider.accent_color } : {}),
      enabled,
      installed,
      status,
      availability: available ? "available" : "unavailable",
      ...(driver?.version ? { version: driver.version } : {}),
      ...(available ? {} : { message: this.#unavailableMessage(provider, driver) }),
      checked_at: now.toISOString(),
      continuation_group_key: computeContinuationGroupKey(provider),
      auth: {
        status: driver?.authStatus ?? (status === "unauthenticated" ? "unauthenticated" : "unknown"),
      },
      models: provider.models.length > 0 ? normalizeHarnessModels(provider.models) : driver?.models ?? [],
      local_capabilities: provider.local_capabilities,
    };

    if (provider.hidden_models.length > 0) {
      snapshot.hidden_models = provider.hidden_models;
    }
    if (provider.model_order.length > 0) {
      snapshot.model_order = provider.model_order;
    }
    if (provider.favorite_models.length > 0) {
      snapshot.favorite_models = provider.favorite_models;
    }

    return snapshot;
  }

  #unavailableMessage(provider: ProviderInstanceConfig, driver: ProviderDriverStatus | undefined): string {
    if (!provider.enabled) {
      return "Provider is disabled in runner config.";
    }

    if (!driver) {
      return `Unsupported provider driver '${provider.driver_kind}'.`;
    }

    if (driver.message) {
      return driver.message;
    }

    return "Provider is unavailable.";
  }
}

export function computeContinuationGroupKey(provider: ProviderInstanceConfig): string {
  if (provider.continuation_group_key) {
    return provider.continuation_group_key;
  }
  if (provider.driver_kind === "codex" && provider.home) {
    return `codex:${provider.home}`;
  }
  if (provider.driver_kind === "claude" && provider.home) {
    return `claude:${provider.home}`;
  }
  return `driver:${provider.driver_kind}`;
}

function normalizeHarnessModels(models: ProviderInstanceConfig["models"]): HarnessModel[] {
  return models.map((model): HarnessModel => {
    const result: HarnessModel = {
      id: model.id,
      label: model.label,
      capabilities: {
        option_descriptors: model.capabilities.option_descriptors.map(normalizeHarnessOptionDescriptor),
      },
    };
    if (model.is_default !== undefined) {
      result.is_default = model.is_default;
    }
    return result;
  });
}

function normalizeHarnessOptionDescriptor(option: ProviderInstanceConfig["models"][number]["capabilities"]["option_descriptors"][number]): HarnessOptionDescriptor {
  const result: HarnessOptionDescriptor = {
    id: option.id,
    label: option.label,
    type: option.type,
  };
  if (option.values !== undefined) {
    result.values = option.values;
  }
  if (option.default_value !== undefined) {
    result.default_value = option.default_value;
  }
  if (option.current_value !== undefined) {
    result.current_value = option.current_value;
  }
  if (option.prompt_injected_values !== undefined) {
    result.prompt_injected_values = option.prompt_injected_values;
  }
  return result;
}
