import type { ProviderInstanceConfig } from "../../config/index.js";
import type { ProviderDriverStatus } from "../../host/provider-registry.js";
import { ClaudeHarnessAdapter } from "./providers/claude.js";
import { CodexHarnessAdapter } from "./providers/codex.js";
import { MockHarnessAdapter } from "./providers/mock.js";
import { OpenCodeHarnessAdapter } from "./providers/opencode.js";
import { HarnessAdapterError, type HarnessAdapter } from "./types.js";

export class HarnessAdapterRegistry {
  readonly #adapters: Map<string, HarnessAdapter>;

  constructor(adapters: HarnessAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter: HarnessAdapter): [string, HarnessAdapter] => [adapter.driverKind, adapter]));
  }

  get(driverKind: string): HarnessAdapter | undefined {
    return this.#adapters.get(driverKind);
  }

  require(driverKind: string): HarnessAdapter {
    const adapter: HarnessAdapter | undefined = this.get(driverKind);
    if (!adapter) {
      throw new HarnessAdapterError("provider_driver_unavailable", `Provider driver '${driverKind}' is not available in this runner.`);
    }
    return adapter;
  }

  async probeProviders(providers: ProviderInstanceConfig[]): Promise<ProviderDriverStatus[]> {
    return await Promise.all(
      providers.map(async (provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> => {
        const adapter: HarnessAdapter | undefined = this.get(provider.driver_kind);
        if (!adapter) {
          return {
            provider_instance_id: provider.id,
            driver_kind: provider.driver_kind,
            installed: false,
            available: false,
            status: "unavailable",
            message: `Unsupported provider driver '${provider.driver_kind}'.`,
            models: [],
          };
        }
        return adapter.probe(provider);
      }),
    );
  }
}

export function createDefaultHarnessAdapterRegistry(): HarnessAdapterRegistry {
  return new HarnessAdapterRegistry([
    new MockHarnessAdapter(),
    new CodexHarnessAdapter(),
    new ClaudeHarnessAdapter(),
    new OpenCodeHarnessAdapter(),
  ]);
}
