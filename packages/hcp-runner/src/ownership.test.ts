import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConnectionOwnership, acquireStateOwnership, connectionDirectory } from "./ownership.js";
import { connectMachine, parseConnectOptions } from "./connect.js";

const workers = new WeakMap<TestContext, { child: ChildProcess; exited: Promise<unknown[]> }[]>();

function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "hcp-ownership-"));
  const children: { child: ChildProcess; exited: Promise<unknown[]> }[] = [];
  workers.set(t, children);
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

function worker(t: TestContext, path: string, beforeMarker = false): { child: ChildProcess; result: Promise<unknown>; exited: Promise<unknown[]> } {
  const source = `
    import { ConnectionOwnership } from ${JSON.stringify(new URL("./ownership.ts", import.meta.url).href)};
    import { openSync } from 'node:fs';
    import { tryLock } from 'fs-native-extensions';
    import { join } from 'node:path';
    const owner = ${beforeMarker ? "tryLock(openSync(join(process.argv[1], 'runner.owner'), 'a+', 0o600))" : "ConnectionOwnership.acquire(process.argv[1])"};
    process.send(owner === 'already_running' ? 'busy' : 'acquired');
    const timer = setInterval(() => {}, 1000);
    process.on('message', () => {
      if (typeof owner === 'object') { owner.release(); owner.release(); }
      clearInterval(timer);
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  const exited = once(child, "exit");
  const result = Promise.race([
    once(child, "message").then(([value]: unknown[]) => value),
    exited.then(() => { throw new Error(`Owner worker exited before reporting: ${stderr}`); }),
  ]);
  workers.get(t)!.push({ child, exited });
  return { child, result, exited };
}

test("OS ownership survives competing starts and is released after SIGKILL", { timeout: 20_000 }, async t => {
  const path = directory(t);
  const first = worker(t, path);
  assert.equal(await first.result, "acquired");
  const competing = worker(t, path);
  assert.equal(await competing.result, "busy");
  first.child.kill("SIGKILL");
  await first.exited;
  const contenders = Array.from({ length: 6 }, () => worker(t, path));
  const results = await Promise.all(contenders.map(candidate => candidate.result));
  assert.equal(results.filter(value => value === "acquired").length, 1);
  assert.equal(results.filter(value => value === "busy").length, 5);
  assert.equal(ConnectionOwnership.acquire(path), "already_running");
});

test("death before metadata publication does not leave an unrecoverable lock", { timeout: 10_000 }, async t => {
  const path = directory(t);
  const first = worker(t, path, true);
  assert.equal(await first.result, "acquired");
  first.child.kill("SIGKILL");
  await first.exited;
  const owner = ConnectionOwnership.acquire(path);
  assert.notEqual(owner, "already_running");
  if (owner !== "already_running") owner.release();
});

test("released owner cannot remove a replacement owner's marker", t => {
  const path = directory(t);
  const first = ConnectionOwnership.acquire(path);
  assert.notEqual(first, "already_running");
  if (first === "already_running") return;
  first.release();
  const second = ConnectionOwnership.acquire(path);
  assert.notEqual(second, "already_running");
  if (second === "already_running") return;
  const marker = readFileSync(join(path, "runner.json.lock"), "utf8");
  first.release();
  assert.equal(readFileSync(join(path, "runner.json.lock"), "utf8"), marker);
  assert.equal(ConnectionOwnership.acquire(path), "already_running");
  second.release();
});

test("a dead published-runner PID lock recovers without touching saved setup", t => {
  const path = directory(t);
  const processResult = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  assert.equal(processResult.status, 0);
  const pid = Number(processResult.stdout.trim());
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  writeFileSync(join(path, "runner.json.lock"), String(pid));
  writeFileSync(join(path, "runner.json"), "saved configuration");
  writeFileSync(join(path, "credentials.json"), "saved credentials");
  const owner = ConnectionOwnership.acquire(path);
  assert.notEqual(owner, "already_running");
  assert.equal(readFileSync(join(path, "runner.json"), "utf8"), "saved configuration");
  assert.equal(readFileSync(join(path, "credentials.json"), "utf8"), "saved credentials");
  if (owner !== "already_running") owner.release();
});

test("legacy live, reused, and malformed PIDs never authorize takeover", t => {
  const path = directory(t);
  for (const marker of [String(process.pid), "", "broken", "0", "-1", '{"pid":1}']) {
    writeFileSync(join(path, "runner.json.lock"), marker);
    assert.throws(() => ConnectionOwnership.acquire(path), /older HCP runner|older runner lock/);
    assert.equal(readFileSync(join(path, "runner.json.lock"), "utf8"), marker);
  }
});

test("new metadata with a reused PID recovers because the OS proves ownership is free", t => {
  const path = directory(t);
  writeFileSync(join(path, "runner.json.lock"), JSON.stringify({ version: 1, pid: process.pid, token: "b924a054-3592-4c27-aed7-c4b853b25fd7" }));
  const owner = ConnectionOwnership.acquire(path);
  assert.notEqual(owner, "already_running");
  if (owner !== "already_running") owner.release();
});

test("a permission error inspecting a legacy process preserves its marker", t => {
  const path = directory(t);
  const marker = String(process.pid);
  writeFileSync(join(path, "runner.json.lock"), marker);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("Not permitted"), { code: "EPERM" }); });
  assert.throws(() => ConnectionOwnership.acquire(path), /cannot verify whether process/);
  assert.equal(readFileSync(join(path, "runner.json.lock"), "utf8"), marker);
});

test("repeating ordinary connect succeeds without starting another runner or applying setup changes", async t => {
  const path = directory(t);
  const options = parseConnectOptions(["ws://localhost:8000/hcp/runner"], path);
  const owner = ConnectionOwnership.acquire(options.connectionDirectory);
  assert.notEqual(owner, "already_running");
  if (owner === "already_running") return;
  try {
    assert.equal(await connectMachine(options, async () => { assert.fail("duplicate runner started"); }), 0);
    await assert.rejects(connectMachine({ ...options, pair: true }, async () => 0), /not applied/);
    await assert.rejects(connectMachine({ ...options, providers: ["codex"] }, async () => 0), /not applied/);
    await assert.rejects(connectMachine({ ...options, configPath: join(path, "other.json") }, async () => 0), /not applied/);
  } finally { owner.release(); }
});

test("connection URLs normalize before selecting ownership", t => {
  const path = directory(t);
  assert.equal(connectionDirectory("http://localhost:8000/hcp/runner", path), connectionDirectory("ws://localhost:8000/hcp/runner", path));
});

test("state ownership resolves symlink aliases and remains exclusive after failed acquisition", { skip: process.platform === "win32" }, t => {
  const path = directory(t);
  const state = join(path, "state.json");
  writeFileSync(state, "{}");
  const alias = join(path, "alias.json");
  symlinkSync(state, alias);
  const release = acquireStateOwnership(state);
  assert.throws(() => acquireStateOwnership(alias), /already in use/);
  assert.throws(() => acquireStateOwnership(state), /already in use/);
  release.release();
  const releaseNext = acquireStateOwnership(alias);
  release.release();
  assert.throws(() => acquireStateOwnership(state), /already in use/);
  releaseNext.release();
});
