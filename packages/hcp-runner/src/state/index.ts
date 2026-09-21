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
  type HostRetainedEventRanges,
  type LocalActionErrorPayload,
  type LocalActionRequestPayload,
  type LocalActionResponsePayload,
} from "@harness-control/protocol";
import { z } from "zod";
import { persistedMcpReviewSchema, validateMcpTransition, type PersistedMcpReview } from "./mcp-review.js";

const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_RETENTION_PER_SESSION = 512;

export type PersistedCommandReceipt =
  | {
      payloadHash: string;
      outcome: "ack";
      settledAt: string;
      snapshotPayload?: HcpSessionSnapshotPayload;
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
};

const persistedCommandReceiptSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      payloadHash: z.string().min(1),
      outcome: z.literal("ack"),
      settledAt: z.string().datetime({ offset: true }),
      snapshotPayload: hcpSessionSnapshotPayloadSchema.optional(),
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
  })
  .strict();

export type RunnerStateStoreOptions = {
  eventRetentionPerSession?: number;
  receiptRetentionMs?: number;
  now?: () => Date;
};

export interface RunnerStateStore {
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

  nextEventSequence(sessionId: string): number {
    return (this.data.events[sessionId]?.at(-1)?.sequence ?? 0) + 1;
  }

  appendEvent(event: HcpHarnessEventPayload): void {
    this.#appendEvent(event);
    this.persist();
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
    try {change(); this.persist();} catch (error: unknown) {
      if (review) this.data.mcpReviews[sessionId] = review; else delete this.data.mcpReviews[sessionId];
      if (events) this.data.events[sessionId] = events; else delete this.data.events[sessionId];
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

  constructor(path: string, options: RunnerStateStoreOptions = {}) {
    super(readRunnerState(path), options);
    this.#path = path;
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
