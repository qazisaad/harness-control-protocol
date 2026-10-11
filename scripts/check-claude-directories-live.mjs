import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";

// Installed Claude Code acceptance for 0.5.1 startup controls. No model request is made:
// the session starts without a first turn and stops after native readback.
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native acceptance.");
const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-claude-directories-")));
const cwd = join(root, "current"), extra = join(root, "extra");
await mkdir(cwd); await mkdir(extra);
const git = (...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {cwd}).toString().trim();
git("init", "-q", "-b", "main"); git("remote", "add", "origin", "git@github.com:acme/acceptance.git"); git("commit", "-q", "--allow-empty", "-m", "root");
const rootCommit = git("rev-parse", "HEAD");
const config = RunnerConfigSchema.parse({runner_id: "native-claude-directories", control_plane_url: "ws://127.0.0.1:1",
  workspaces: [{id: "current", path: cwd}, {id: "extra", path: extra}], provider_instances: [{id: "claude", driver_kind: "claude",
    ...(process.env.HCP_LIVE_CLAUDE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE} : {})}]});
const manager = new HarnessSessionManager(config);
const passed = [];
const base = {workspace_id: "current", cwd, provider_instance_id: "claude", driver_kind: "claude", sandbox_mode: "danger_full_access",
  approval_policy: "auto_edits", continue_session: false, execution_profile: "interactive", mcp_servers: []};
try {
  const events = await manager.startSession({...base, session_id: "directories",
    model_selection: {model: "opus", options: [{id: "contextWindow", value: "1m"}]},
    sandbox_options: {writable_roots: [{workspace_id: "extra", path: extra}]},
    workspace_preflight: {workspace_id: "current", expected_git_remote: "https://github.com/Acme/acceptance", expected_root_commit: rootCommit, allow_dirty_worktree: false}});
  const preflight = events.find(event => event.event_type === "workspace.preflight.completed")?.data;
  assert.equal(preflight?.result, "passed"); assert.equal(preflight?.root_commit, rootCommit); assert.equal(preflight?.dirty, false);
  passed.push("preflight verified remote, root commit and clean worktree");
  const configured = events.find(event => event.event_type === "session.configured")?.data;
  assert.deepEqual(configured?.native_policy_readback?.sandbox_options, {writable_roots: [{workspace_id: "extra", path: extra}]});
  assert.equal(configured?.native_policy_readback?.sandbox_mode, "danger_full_access");
  passed.push("native settings confirmed the additional permitted directory and 1M model before any input");
  await manager.stopSession("directories", "acceptance complete");
  await assert.rejects(manager.startSession({...base, session_id: "wrong-repository", model_selection: {model: "opus"},
    workspace_preflight: {workspace_id: "current", expected_root_commit: "0".repeat(40)}}), /root commit/);
  passed.push("preflight refused a different repository before native startup");
  await assert.rejects(manager.startSession({...base, session_id: "network", model_selection: {model: "opus"},
    sandbox_options: {network_access: true, writable_roots: [{workspace_id: "extra", path: extra}]}}), /has not declared|additional permitted directories/);
  passed.push("network authority refused for Claude");
  // Opt-in model turn: proves the permission scope is effective, not only declared.
  if (process.env.HCP_LIVE_MODEL_TURN === "1") {
    const observed = [];
    const unsubscribe = manager.subscribeEvents(event => observed.push(event));
    try {
      await manager.startSession({...base, session_id: "write", model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "haiku"},
        sandbox_options: {writable_roots: [{workspace_id: "extra", path: extra}]}});
      await manager.sendTurn({session_id: "write", turn_id: "write-1",
        input: `Use your file tools to create the file ${join(extra, "proof.txt")} containing exactly the word ok. Do not create anything else.`});
      const deadline = Date.now() + 180_000;
      while (!observed.some(event => event.session_id === "write" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type))) {
        if (Date.now() > deadline) throw new Error("The Claude turn did not finish within three minutes.");
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.ok(observed.some(event => event.session_id === "write" && event.event_type === "turn.completed"), "The Claude turn did not complete.");
      const {readFile} = await import("node:fs/promises");
      assert.equal((await readFile(join(extra, "proof.txt"), "utf8")).trim(), "ok");
      assert.ok(!observed.some(event => event.session_id === "write" && event.event_type === "approval.requested"), "Edits in the permitted directory needed approval.");
      passed.push("authenticated model turn wrote in the additional directory without an approval prompt");
      await manager.stopSession("write", "acceptance complete");
    } finally { unsubscribe(); }
  }
  console.log(`Claude 0.5.1 startup acceptance passed ${passed.length} checks:\n- ${passed.join("\n- ")}`);
} finally {
  await manager.close?.();
  await rm(root, {recursive: true, force: true});
}
