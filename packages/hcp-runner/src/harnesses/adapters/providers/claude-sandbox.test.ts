import assert from "node:assert/strict";
import test from "node:test";
import {mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {query, type Query} from "@anthropic-ai/claude-agent-sdk";
import type {HarnessAdapterStartInput} from "../types.js";
import {claudeSandboxOptions, claudeSandboxSettings, confirmClaudeSandbox} from "./claude-sandbox.js";

function payload(mode: HarnessAdapterStartInput["payload"]["sandbox_mode"], cwd = "/repo"): HarnessAdapterStartInput["payload"] {
  return {session_id: "test", workspace_id: "repo", cwd, provider_instance_id: "claude", driver_kind: "claude",
    model_selection: {model: "sonnet"}, sandbox_mode: mode, approval_policy: "full_access", execution_profile: "interactive",
    continue_session: false, mcp_servers: []};
}

test("contained Claude modes route mutations through the OS sandbox even with approvals disabled", async () => {
  for (const mode of ["read_only", "workspace_write"] as const) {
    const start = payload(mode);
    const options = claudeSandboxOptions(start);
    assert.equal(options.sandbox?.enabled, true);
    assert.equal(options.sandbox?.failIfUnavailable, true);
    assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
    assert.equal(options.sandbox?.autoAllowBashIfSandboxed, false);
    assert.ok(Array.isArray(options.tools) && options.tools.includes("Bash"));
    for (const bypass of ["Write", "Edit", "NotebookEdit", "Agent", "Task"]) assert.ok(!options.tools.includes(bypass));
    const sandbox = claudeSandboxSettings(start);
    const stream = {async getSettings() {return {sources: [{source: "flagSettings", settings: {sandbox}}], effective: {sandbox}};}} as unknown as Query;
    await confirmClaudeSandbox(stream, start);
    const broadened = {...sandbox, allowUnsandboxedCommands: true};
    await assert.rejects(confirmClaudeSandbox({async getSettings() {
      return {sources: [{source: "flagSettings", settings: {sandbox}}], effective: {sandbox: broadened}};
    }} as unknown as Query, start), /did not confirm/);
  }
  assert.deepEqual(claudeSandboxOptions(payload("danger_full_access")), {sandbox: {enabled: false}});
});

test("workspace-write adds only selected roots; read-only denies all filesystem writes", () => {
  const writable = payload("workspace_write");
  writable.sandbox_options = {writable_roots: [{workspace_id: "extra", path: "/extra"}]};
  assert.deepEqual(claudeSandboxSettings(writable).filesystem?.allowWrite, ["/repo", "/extra"]);
  assert.deepEqual(claudeSandboxSettings(payload("read_only")).filesystem?.denyWrite, ["/"]);
});

test("native Claude containment consumes a real Bash call through its terminal result in all three modes", {
  skip: process.env.HCP_NATIVE_SANDBOX_TESTS !== "1",
}, async () => {
  // System temporary directories are intentionally writable under native workspace
  // sandboxes; use an owned home-directory fixture to test a real boundary.
  const root = await mkdtemp(join(homedir(), ".hcp-claude-sandbox-"));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    for (const mode of ["read_only", "workspace_write", "danger_full_access"] as const) {
      const cwd = join(root, mode);
      await mkdir(cwd);
      const inside = join(cwd, "inside.txt");
      const outside = join(root, `${mode}-outside.txt`);
      const command = `printf inside > ${quote(inside)}; printf outside > ${quote(outside)}; printf CONTAINMENT_TEST_DONE`;
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 60_000);
      let release!: () => void;
      const admitted = new Promise<void>(resolve => {release = resolve;});
      async function* input() {
        await admitted;
        yield {type: "user" as const, session_id: "", parent_tool_use_id: null, message: {role: "user" as const,
          content: `This is an authorized filesystem containment test using disposable test files. Use Bash exactly once to run the following command unchanged; do not use any other tool or change permissions. Expected permission failures are part of the test. Command: ${command}`}};
      }
      const runtime = query({prompt: input(), options: {
        cwd, settingSources: [], settings: {disableAllHooks: true}, persistSession: false,
        permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, abortController,
        ...claudeSandboxOptions(payload(mode, cwd)),
      }});
      let bash = false;
      let terminal = false;
      try {
        await runtime.initializationResult();
        await confirmClaudeSandbox(runtime, payload(mode, cwd));
        release();
        for await (const message of runtime) {
          if (message.type === "assistant") bash ||= message.message.content.some(block => block.type === "tool_use" && block.name === "Bash");
          if (message.type === "result") {
            assert.equal(message.is_error, false, message.subtype);
            terminal = true;
          }
        }
        assert.ok(bash && terminal, "The test must observe a real Bash call and terminal result");
        const content = async (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        assert.equal(await content(inside), mode === "read_only" ? undefined : "inside");
        assert.equal(await content(outside), mode === "danger_full_access" ? "outside" : undefined);
      } finally {clearTimeout(timer); runtime.close();}
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
