import type {
  HcpHarnessEventPayload,
  HcpSessionSnapshotPayload,
  HostResumeCursor,
} from "./index.js";

export type HcpEventApplyResult =
  | { outcome: "applied"; event: HcpHarnessEventPayload }
  | { outcome: "duplicate"; event: HcpHarnessEventPayload }
  | {
      outcome: "gap";
      session_id: string;
      expected_sequence: number;
      received_sequence: number;
    }
  | {
      outcome: "conflict";
      session_id: string;
      sequence: number;
      existing_event: HcpHarnessEventPayload;
      received_event: HcpHarnessEventPayload;
    };

export type HcpSnapshotApplyResult =
  | {
      outcome: "applied";
      completeness: HcpSessionSnapshotPayload["completeness"];
      applied_events: number;
      duplicate_events: number;
      tombstones: HcpSessionSnapshotPayload["tombstones"];
    }
  | Extract<HcpEventApplyResult, { outcome: "gap" | "conflict" }>;

export class HcpSessionEventReducer {
  readonly #eventsBySession = new Map<string, Map<number, HcpHarnessEventPayload>>();

  applyEvent(event: HcpHarnessEventPayload): HcpEventApplyResult {
    const sessionEvents: Map<number, HcpHarnessEventPayload> =
      this.#eventsBySession.get(event.session_id) ?? new Map<number, HcpHarnessEventPayload>();
    const existingEvent: HcpHarnessEventPayload | undefined = sessionEvents.get(event.sequence);
    if (existingEvent) {
      return canonicalStringify(existingEvent) === canonicalStringify(event)
        ? { outcome: "duplicate", event: existingEvent }
        : {
            outcome: "conflict",
            session_id: event.session_id,
            sequence: event.sequence,
            existing_event: existingEvent,
            received_event: event,
          };
    }

    const expectedSequence: number = sessionEvents.size === 0 ? 1 : Math.max(...sessionEvents.keys()) + 1;
    if (event.sequence !== expectedSequence) {
      return {
        outcome: "gap",
        session_id: event.session_id,
        expected_sequence: expectedSequence,
        received_sequence: event.sequence,
      };
    }

    sessionEvents.set(event.sequence, event);
    this.#eventsBySession.set(event.session_id, sessionEvents);
    return { outcome: "applied", event };
  }

  applySnapshot(snapshot: HcpSessionSnapshotPayload): HcpSnapshotApplyResult {
    if (snapshot.completeness === "complete") {
      const replacement = new Map<number, HcpHarnessEventPayload>();
      for (const event of snapshot.events) {
        replacement.set(event.sequence, event);
      }
      this.#eventsBySession.set(snapshot.session_id, replacement);
      return {
        outcome: "applied",
        completeness: "complete",
        applied_events: snapshot.events.length,
        duplicate_events: 0,
        tombstones: snapshot.tombstones,
      };
    }

    let appliedEvents = 0;
    let duplicateEvents = 0;
    for (const event of snapshot.events) {
      const result: HcpEventApplyResult = this.applyEvent(event);
      if (result.outcome === "gap" || result.outcome === "conflict") {
        return result;
      }
      if (result.outcome === "applied") {
        appliedEvents += 1;
      } else {
        duplicateEvents += 1;
      }
    }
    return {
      outcome: "applied",
      completeness: "partial",
      applied_events: appliedEvents,
      duplicate_events: duplicateEvents,
      tombstones: snapshot.tombstones,
    };
  }

  resumeCursor(): HostResumeCursor | undefined {
    const sessions: HostResumeCursor["sessions"] = Array.from(this.#eventsBySession.entries())
      .map(([sessionId, events]) => ({
        session_id: sessionId,
        last_event_sequence: Math.max(...events.keys()),
      }))
      .sort((left, right): number => left.session_id.localeCompare(right.session_id));
    return sessions.length > 0 ? { sessions } : undefined;
  }

  events(): HcpHarnessEventPayload[] {
    return Array.from(this.#eventsBySession.values())
      .flatMap((events): HcpHarnessEventPayload[] => Array.from(events.values()))
      .sort((left, right): number =>
        left.session_id === right.session_id
          ? left.sequence - right.sequence
          : left.session_id.localeCompare(right.session_id),
      );
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown): string => canonicalStringify(entry)).join(",")}]`;
  }
  const entries: Array<[string, unknown]> = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entryValue]): string => `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`)
    .join(",")}}`;
}
