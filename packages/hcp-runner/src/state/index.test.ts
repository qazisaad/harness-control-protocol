import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { HcpHarnessEventPayload } from "@harness-control/protocol";

import { JsonRunnerStateStore } from "./index.js";

describe("JsonRunnerStateStore", () => {
  it("survives restart with retained ranges, monotonic sequences, and explicit partial snapshot semantics", async () => {
    const root: string = await mkdtemp(join(tmpdir(), "hcp-runner-state-"));
    const statePath: string = join(root, "runner-state.json");

    try {
      const firstStore = new JsonRunnerStateStore(statePath, { eventRetentionPerSession: 2 });
      firstStore.appendEvent(createEvent(1));
      firstStore.appendEvent(createEvent(2));
      firstStore.appendEvent(createEvent(3));

      const restartedStore = new JsonRunnerStateStore(statePath, { eventRetentionPerSession: 2 });
      assert.equal(restartedStore.nextEventSequence("session-1"), 4);
      assert.deepEqual(restartedStore.retainedEventRanges(), {
        sessions: [{ session_id: "session-1", first_event_sequence: 2, last_event_sequence: 3 }],
      });
      assert.equal(restartedStore.replayEventsAfter("session-1", 0), undefined);
      assert.deepEqual(
        restartedStore.replayEventsAfter("session-1", 2)?.map((event: HcpHarnessEventPayload): number => event.sequence),
        [3],
      );

      const snapshot = restartedStore.sessionSnapshot("snapshot-command", "session-1");
      assert.equal(snapshot?.completeness, "partial");
      assert.equal(snapshot?.omission_semantics, "preserve");
      assert.equal(snapshot?.from_sequence, 2);
      assert.equal(snapshot?.through_sequence, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists command receipts across restart and expires them only after the 24-hour contract", async () => {
    const root: string = await mkdtemp(join(tmpdir(), "hcp-runner-state-receipts-"));
    const statePath: string = join(root, "runner-state.json");
    let now = new Date("2026-01-01T00:00:00.000Z");

    try {
      const firstStore = new JsonRunnerStateStore(statePath, { now: () => now });
      firstStore.setCommandReceipt("command-1", {
        payloadHash: "hash-1",
        outcome: "ack",
        settledAt: now.toISOString(),
      });

      now = new Date("2026-01-01T23:59:59.000Z");
      const beforeExpiry = new JsonRunnerStateStore(statePath, { now: () => now });
      assert.equal(beforeExpiry.getCommandReceipt("command-1")?.outcome, "ack");

      now = new Date("2026-01-02T00:00:01.000Z");
      const afterExpiry = new JsonRunnerStateStore(statePath, { now: () => now });
      assert.equal(afterExpiry.getCommandReceipt("command-1"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("downgrades oversized complete snapshots instead of emitting an invalid protocol payload", async () => {
    const root: string = await mkdtemp(join(tmpdir(), "hcp-runner-state-snapshot-size-"));
    const statePath: string = join(root, "runner-state.json");

    try {
      const store = new JsonRunnerStateStore(statePath);
      const content = "x".repeat(600_000);
      store.appendEvent({
        session_id: "session-large",
        sequence: 1,
        event_type: "extension.large",
        created_at: "2026-01-01T00:00:01.000Z",
        data: { fields: { content } },
      });
      store.appendEvent({
        session_id: "session-large",
        sequence: 2,
        event_type: "extension.large",
        created_at: "2026-01-01T00:00:02.000Z",
        data: { fields: { content } },
      });

      const snapshot = store.sessionSnapshot("snapshot-command", "session-large");
      assert.ok(snapshot && snapshot.completeness === "partial");
      assert.equal(snapshot.reason, "size_limit");
      assert.equal(snapshot.from_sequence, 2);
      assert.equal(snapshot.omission_semantics, "preserve");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createEvent(sequence: number): HcpHarnessEventPayload {
  return {
    session_id: "session-1",
    sequence,
    event_type: sequence === 1 ? "session.started" : "session.state.changed",
    created_at: `2026-01-01T00:00:0${sequence}.000Z`,
    data: sequence === 1 ? { provider_instance_id: "provider-1" } : { state: `state-${sequence}` },
  };
}
