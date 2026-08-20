import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HcpHarnessEventPayload, HcpSessionSnapshotPayload } from "./index.js";
import { HcpSessionEventReducer } from "./session-reducer.js";

describe("HcpSessionEventReducer", () => {
  it("applies live events once and distinguishes gaps from conflicting duplicates", () => {
    const reducer = new HcpSessionEventReducer();
    const firstEvent: HcpHarnessEventPayload = createEvent(1, "started");

    assert.equal(reducer.applyEvent(firstEvent).outcome, "applied");
    assert.equal(reducer.applyEvent({ ...firstEvent, data: { state: "started" } }).outcome, "duplicate");
    assert.equal(reducer.applyEvent(createEvent(3, "gap")).outcome, "gap");
    assert.equal(reducer.applyEvent(createEvent(1, "changed")).outcome, "conflict");
    assert.deepEqual(reducer.resumeCursor(), {
      sessions: [{ session_id: "session-1", last_event_sequence: 1 }],
    });
  });

  it("uses complete snapshots as replacement and partial snapshots as preservation-only deltas", () => {
    const reducer = new HcpSessionEventReducer();
    reducer.applyEvent(createEvent(1, "stale"));

    const completeSnapshot: HcpSessionSnapshotPayload = {
      command_id: "snapshot-complete",
      session_id: "session-1",
      generated_at: "2026-01-01T00:00:03.000Z",
      completeness: "complete",
      omission_semantics: "replace",
      from_sequence: 1,
      through_sequence: 2,
      events: [createEvent(1, "fresh"), createEvent(2, "running")],
      tombstones: [],
    };
    assert.equal(reducer.applySnapshot(completeSnapshot).outcome, "applied");
    assert.deepEqual(reducer.events()[0]?.data, { state: "fresh" });

    const partialSnapshot: HcpSessionSnapshotPayload = {
      command_id: "snapshot-partial",
      session_id: "session-1",
      generated_at: "2026-01-01T00:00:04.000Z",
      completeness: "partial",
      omission_semantics: "preserve",
      reason: "retention_gap",
      from_sequence: 2,
      through_sequence: 3,
      events: [createEvent(2, "running"), createEvent(3, "completed")],
      tombstones: [],
    };
    const result = reducer.applySnapshot(partialSnapshot);
    assert.deepEqual(result, {
      outcome: "applied",
      completeness: "partial",
      applied_events: 1,
      duplicate_events: 1,
      tombstones: [],
    });
    assert.deepEqual(reducer.events().map((event): number => event.sequence), [1, 2, 3]);
  });
});

function createEvent(sequence: number, state: string): HcpHarnessEventPayload {
  return {
    session_id: "session-1",
    sequence,
    event_type: "session.state.changed",
    created_at: `2026-01-01T00:00:0${sequence}.000Z`,
    data: { state },
  };
}
