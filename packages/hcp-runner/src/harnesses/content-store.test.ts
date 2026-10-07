import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm, writeFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BoundedHarnessContentStore, type HarnessContentScope} from "./content-store.js";
import {harnessContentChunkSchema} from "@harness-control/protocol";

const scope: HarnessContentScope = {session_id: "session", provider_instance_id: "provider", provider_binding_hash: "binding", workspace_id: "workspace", cwd: "/workspace"};
test("disk content survives recreation and reconstructs exact Unicode bytes through bounded public chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcp-content-"));
  try {
    const text = "🙂hello\n".repeat(30_000);
    const first = new BoundedHarnessContentStore(directory);
    const reference = first.publish(scope, text);
    const recreated = new BoundedHarnessContentStore(directory);
    const chunks: Buffer[] = [];
    let offset = 0;
    while (true) {
      const chunk = recreated.read("session", reference.content_id, offset, 64 * 1024);
      harnessContentChunkSchema.parse(chunk);
      chunks.push(Buffer.from(chunk.data_base64, "base64"));
      assert.ok(chunks.at(-1)!.length <= 64 * 1024);
      if (chunk.next_offset === undefined) break;
      offset = chunk.next_offset;
    }
    assert.equal(Buffer.concat(chunks).toString("utf8"), text);
    assert.throws(() => recreated.read("another-session", reference.content_id, 0, 1), /another session/);
    assert.throws(() => recreated.read("session", "../../outside", 0, 1), /Unknown content/);
    assert.throws(() => recreated.read("session", reference.content_id, reference.byte_length + 1, 1), /exceeds/);
    await writeFile(join(directory, `${reference.content_id}.bin`), "corrupt");
    assert.throws(() => recreated.read("session", reference.content_id, 0, 1), /integrity/);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("content limits, expiry and quota eviction are explicit", () => {
  let now = Date.now();
  const store = new BoundedHarnessContentStore(undefined, () => now, {maxObjectBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024});
  assert.throws(() => store.publish(scope, undefined), /serializable/);
  assert.throws(() => store.publish(scope, "x".repeat(8 * 1024 * 1024 + 1)), /object retention limit/);
  const first = store.publish(scope, "x".repeat(8 * 1024 * 1024));
  for (let i = 0; i < 8; i++) {now++; store.publish(scope, "x".repeat(8 * 1024 * 1024));}
  assert.throws(() => store.read("session", first.content_id, 0, 1), /evicted/);
  const last = store.publish(scope, {result: "retained"});
  now += 24 * 60 * 60_000 + 1;
  assert.throws(() => store.read("session", last.content_id, 0, 1), /expired/);
});

test("restart removes orphaned content bodies and corrupt metadata without touching foreign files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcp-content-orphan-"));
  try {
    await writeFile(join(directory, `${"a".repeat(64)}.bin`), "orphan");
    await writeFile(join(directory, `${"b".repeat(64)}.json`), "invalid");
    await writeFile(join(directory, "foreign.txt"), "keep");
    new BoundedHarnessContentStore(directory);
    assert.deepEqual(await readdir(directory), ["foreign.txt"]);
  } finally {await rm(directory, {recursive: true, force: true});}
});


test("large disk content verifies full integrity once per file identity and preserves exact chunks after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcp-content-large-"));
  try {
    const {readHcpContent} = await import("@harness-control/sdk");
    const text = "x".repeat(14 * 1024 * 1024), store = new BoundedHarnessContentStore(directory), reference = store.publish(scope, text);
    const recreated = new BoundedHarnessContentStore(directory);
    const complete = await readHcpContent(reference, async (offset, limit) => recreated.read("session", reference.content_id, offset, limit));
    assert.equal(complete.format, "text");if (complete.format === "text") assert.equal(complete.text, text);
    const first = recreated.read("session", reference.content_id, 0, 1);first.reference.sha256 = "0".repeat(64);
    assert.equal(recreated.read("session", reference.content_id, 1, 1).reference.sha256, reference.sha256);
    // Same length corruption after a verified read must invalidate the disk verification cache.
    await writeFile(join(directory, `${reference.content_id}.bin`), "y".repeat(text.length));
    assert.throws(() => recreated.read("session", reference.content_id, 2, 1), /integrity/);
  } finally {await rm(directory, {recursive: true, force: true});}
});


test("caller changes cannot expand validated content-store limits", () => {
  const limits = {maxObjectBytes: 3, maxTotalBytes: 6}, store = new BoundedHarnessContentStore(undefined, Date.now, limits);
  limits.maxObjectBytes = 1000;limits.maxTotalBytes = 1000;
  assert.throws(() => store.publish(scope, "four"), /object retention limit/);
  assert.equal(store.limits.maxObjectBytes, 3);assert.ok(Object.isFrozen(store.limits));
});
