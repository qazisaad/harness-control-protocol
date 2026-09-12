import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { HcpWorkspaceOperation } from "@harness-control/protocol";
import { loadRunnerConfig } from "../config/index.js";
import { HarnessSessionManager } from "../harnesses/index.js";
import { WorkspaceManager } from "./index.js";

it("browses paginated directories during active sessions without changing registrations or escaping roots", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-browse-")));
  try {
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    await mkdir(allowed); await mkdir(outside);
    await Promise.all(Array.from({ length: 205 }, (_, index) => mkdir(join(allowed, `folder-${String(index).padStart(3, "0")}`))));
    await writeFile(join(allowed, "file.txt"), "not a folder");
    await symlink(outside, join(allowed, "escape"));
    await symlink(join(allowed, "missing"), join(allowed, "broken"));
    await symlink(join(allowed, "folder-000"), join(allowed, "alias"));
    const file = join(root, "runner.json");
    await writeFile(file, JSON.stringify({ runner_id: "test", control_plane_url: "ws://localhost:1", workspace_management: { allowed_roots: [allowed] } }));
    const before = await readFile(file, "utf8");
    const config = await loadRunnerConfig(file);
    class BusySessions extends HarnessSessionManager { override activeSessionCount() { return 1; } }
    const manager = new WorkspaceManager(config, file, new BusySessions(config));
    const call = (operation: HcpWorkspaceOperation) => manager.execute(crypto.randomUUID(), { operation, expected_revision: "ignored-for-read", expires_at: new Date(Date.now() + 30_000).toISOString() });
    const first = await call({ kind: "browse" });
    assert.equal(first.outcome.kind, "directory");
    if (first.outcome.kind !== "directory") throw new Error("Expected a directory listing");
    assert.equal(first.outcome.path, allowed);
    assert.equal(first.outcome.parent, undefined);
    assert.equal(first.outcome.entries.length, 200);
    assert.equal(first.outcome.entries[0]!.path, join(allowed, "folder-000"));
    const next = await call({ kind: "browse", path: allowed, cursor: first.outcome.next_cursor });
    assert.equal(next.outcome.kind, "directory");
    if (next.outcome.kind !== "directory") throw new Error("Expected another page");
    assert.equal(next.outcome.entries.length, 6);
    assert.equal(next.outcome.next_cursor, undefined);
    const child = await call({ kind: "browse", path: join(allowed, "folder-000") });
    assert.equal(child.outcome.kind, "directory");
    if (child.outcome.kind === "directory") assert.equal(child.outcome.parent, allowed);
    for (const path of [outside, join(allowed, "escape"), "relative", join(allowed, "file.txt")]) assert.equal((await call({ kind: "browse", path })).outcome.kind, "error");
    const expired = await manager.execute("expired", { operation: { kind: "browse" }, expected_revision: "ignored", expires_at: new Date(0).toISOString() });
    assert.equal(expired.outcome.kind, "error");
    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual(first.workspaces, []);
    config.workspace_management = { allowed_roots: [] };
    assert.equal((await call({ kind: "browse", path: allowed })).outcome.kind, "error");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("persists registration and stable-name changes; rejects escapes, duplicates, stale revisions and disabled writes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-workspaces-")));
  try {
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    await mkdir(allowed); await mkdir(outside); await mkdir(join(allowed, "repo"));
    await symlink(outside, join(allowed, "escape"));
    const file = join(root, "runner.json");
    await writeFile(file, JSON.stringify({ runner_id: "test", control_plane_url: "ws://localhost:1", workspace_management: { allowed_roots: [allowed] } }));
    const config = await loadRunnerConfig(file);
    const sessions = new HarnessSessionManager(config);
    const manager = new WorkspaceManager(config, file, sessions);
    const call = (operation: HcpWorkspaceOperation, revision = manager.snapshot().revision) => manager.execute(crypto.randomUUID(), { operation, expected_revision: revision, expires_at: new Date(Date.now() + 30_000).toISOString() });
    assert.equal((await call({ kind: "add", path: join(allowed, "escape"), display_name: "escape" })).outcome.kind, "error");
    assert.equal((await call({ kind: "add", path: "relative", display_name: "relative" })).outcome.kind, "error");
    const before = manager.snapshot().revision;
    const added = await call({ kind: "add", path: join(allowed, "repo"), display_name: "Repo" });
    assert.equal(added.outcome.kind, "success");
    assert.equal((await call({ kind: "add", path: join(allowed, "repo"), display_name: "Duplicate" })).outcome.kind, "error");
    const id = added.workspaces[0]!.id;
    assert.equal((await call({ kind: "rename", id, display_name: "Stale" }, before)).outcome.kind, "error");
    const renamed = await call({ kind: "rename", id, display_name: "Renamed" });
    assert.equal(renamed.workspaces[0]!.id, id);
    const loaded = await loadRunnerConfig(file);
    assert.equal(loaded.workspaces[0]!.display_name, "Renamed");
    assert.equal(new WorkspaceManager(loaded, file, new HarnessSessionManager(loaded)).snapshot().revision, renamed.management.revision);
    assert.equal((await call({ kind: "remove", id })).outcome.kind, "success");
    assert.equal((await loadRunnerConfig(file)).workspaces.length, 0);
    assert.equal(await realpath(join(allowed, "repo")), join(allowed, "repo"));
    const contents = await readFile(file, "utf8");
    await writeFile(file, contents.replace('"test"', '"changed"'));
    assert.equal((await call({ kind: "add", path: join(allowed, "repo"), display_name: "Repo" })).outcome.kind, "error");
    config.workspace_management = { allowed_roots: [] };
    assert.equal((await call({ kind: "add", path: outside, display_name: "Denied" })).outcome.kind, "error");
    assert.equal((await call({ kind: "list" })).outcome.kind, "success");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("serializes edits with session starts and rejects a busy machine", async () => {
  const config = (await import("../config/index.js")).RunnerConfigSchema.parse({ runner_id: "test", control_plane_url: "ws://localhost:1" });
  class BusySessions extends HarnessSessionManager { override activeSessionCount() { return 1; } }
  const manager = new WorkspaceManager(config, "unused", new BusySessions(config));
  const result = await manager.execute("busy", { operation: { kind: "remove", id: "x" }, expected_revision: manager.snapshot().revision, expires_at: new Date(Date.now() + 30_000).toISOString() });
  assert.equal(result.outcome.kind, "error");
  if (result.outcome.kind === "error") assert.match(result.outcome.message, /active sessions/);
  const expired = await manager.execute("expired", { operation: { kind: "list" }, expected_revision: manager.snapshot().revision, expires_at: new Date(0).toISOString() });
  assert.equal(expired.outcome.kind, "error");
});
