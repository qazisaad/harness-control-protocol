import { z } from "zod";
import {
  accountUsageObservationSchema, hcpAccountsReadPayloadSchema, hcpAccountsSnapshotPayloadSchema,
  type AccountProviderReading, type AccountUsageObservation, type HcpAccountsReadPayload, type HcpAccountsSnapshotPayload,
} from "@harness-control/protocol";
import type { ProviderInstanceConfig, RunnerConfig } from "../config/index.js";
import { readCodexAccount } from "./codex.js";
import { readClaudeAccount } from "./claude.js";
import { unavailable, type AccountCollector } from "./shared.js";
export { normalizeCodexUsage } from "./codex.js";
export { normalizeClaudeUsage } from "./claude.js";
export type { AccountCollector, AccountReadContext } from "./shared.js";

export class AccountUsageReader {
  readonly #inflight = new Map<string, Promise<AccountUsageObservation>>();
  readonly #cache = new Map<string, { expires: number; observation: AccountUsageObservation }>();
  readonly #controllers = new Set<AbortController>();
  readonly #collectors: ReadonlyMap<string, AccountCollector>;
  readonly #timeoutMs: number;
  readonly #cacheMs: number;
  #closed = false;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(private readonly config: RunnerConfig, options: {
    collectors?: ReadonlyMap<string, AccountCollector>; timeoutMs?: number; cacheMs?: number;
  } = {}) {
    this.#collectors = options.collectors ?? new Map([["codex", readCodexAccount], ["claude", readClaudeAccount]]);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#cacheMs = options.cacheMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000
      || !Number.isSafeInteger(this.#cacheMs) || this.#cacheMs < 0) throw new Error("Invalid account reader timing.");
  }

  async read(requestId: string, input: HcpAccountsReadPayload): Promise<HcpAccountsSnapshotPayload> {
    if (this.#closed) throw new Error("Account reader is closed.");
    const request = hcpAccountsReadPayloadSchema.parse(input);
    const ids: string[] = request.provider_instance_ids ?? this.config.provider_instances.map(provider => provider.id);
    const providers: AccountProviderReading[] = [];
    for (const id of ids) {
      const provider: ProviderInstanceConfig | undefined = this.config.provider_instances.find(provider => provider.id === id);
      if (!provider) throw new Error("Unknown provider instance.");
    }
    // Bound native subprocess concurrency independently of the number of configured accounts.
    for (let offset = 0; offset < ids.length; offset += 4) {
      const group = await Promise.all(ids.slice(offset, offset + 4).map(async id => ({
        provider_instance_id: id,
        observation: await this.#readProvider(this.config.provider_instances.find(provider => provider.id === id)!),
      })));
      providers.push(...group);
    }
    return hcpAccountsSnapshotPayloadSchema.parse({ request_id: requestId, host_id: this.config.host_id ?? this.config.runner_id, providers });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    await Promise.all(this.#inflight.values());
  }

  #readProvider(provider: ProviderInstanceConfig): Promise<AccountUsageObservation> {
    if (this.#closed) return Promise.resolve(unavailable("timeout", "Account reader was closed."));
    if (!provider.enabled || !provider.account_usage) return Promise.resolve(unavailable("disabled", "Account usage sharing is disabled in local runner configuration."));
    const collector: AccountCollector | undefined = this.#collectors.get(provider.driver_kind);
    if (!collector) return Promise.resolve(unavailable("unsupported", "This provider has no account usage collector."));
    const cached = this.#cache.get(provider.id);
    if (cached && cached.expires > Date.now()) return Promise.resolve(structuredClone(cached.observation));
    const pending = this.#inflight.get(provider.id);
    if (pending) return pending;
    const read = this.#collect(provider, collector).then(observation => {
      this.#cache.set(provider.id, { expires: Date.now() + this.#cacheMs, observation });
      return observation;
    }).finally(() => this.#inflight.delete(provider.id));
    this.#inflight.set(provider.id, read);
    return read;
  }

  async #collect(provider: ProviderInstanceConfig, collector: AccountCollector): Promise<AccountUsageObservation> {
    if (this.#active >= 4) await new Promise<void>(resolve => this.#waiting.push(resolve));
    else this.#active++;
    if (this.#closed) {
      this.#release();
      return unavailable("timeout", "Account reader was closed.");
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Account read cancelled.")), { once: true }));
      const observation = await Promise.race([collector({ provider, hostId: this.config.host_id ?? this.config.runner_id, signal: controller.signal }), cancelled]);
      if (controller.signal.aborted) return unavailable("timeout", "Account collection timed out or was cancelled.");
      return accountUsageObservationSchema.parse(observation);
    } catch (error) {
      if (controller.signal.aborted) return unavailable("timeout", "Account collection timed out or was cancelled.");
      if (error instanceof z.ZodError || error instanceof RangeError || error instanceof SyntaxError) {
        return unavailable("invalid_response", "Provider returned invalid account usage data.");
      }
      if (!(error instanceof Error)) throw error;
      return unavailable("provider_error", "Account collection failed. Check the local provider login and supported version.");
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
      this.#release();
    }
  }
  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active--;
  }
}
