import assert from "node:assert/strict";
import {test} from "node:test";
import {openCodeRootTerminal} from "./opencode-root-terminal.js";
const native = {id: "assistant", sessionID: "root", parentID: "owned-prompt", role: "assistant", time: {completed: 100}, finish: "stop"};
test("owned OpenCode prompt responses preserve native terminal outcomes and exact parent scope", () => {
  assert.equal(openCodeRootTerminal(native, "root", "owned-prompt"), "completed");
  assert.equal(openCodeRootTerminal({...native, error: {name: "MessageAbortedError"}}, "root", "owned-prompt"), "interrupted");
  assert.equal(openCodeRootTerminal({...native, error: {name: "ProviderAuthError"}}, "root", "owned-prompt"), "failed");
  assert.equal(openCodeRootTerminal({...native, finish: "error"}, "root", "owned-prompt"), "failed");
  assert.equal(openCodeRootTerminal({...native, finish: "length"}, "root", "owned-prompt"), "completed");
  assert.equal(openCodeRootTerminal({...native, sessionID: "foreign"}, "root", "owned-prompt"), undefined);
  assert.equal(openCodeRootTerminal({...native, parentID: "old-prompt"}, "root", "owned-prompt"), undefined);
});
test("idle, tool-loop and incomplete native messages cannot claim root completion", () => {
  for (const input of [{type: "session.idle", properties: {sessionID: "root"}}, {...native, finish: "tool-calls"},
    {...native, finish: "unknown"}, {...native, finish: "other"}, {...native, finish: "future-provider-value"}, {...native, time: {}}, {...native, time: {completed: -1}}, {...native, time: {created: 200, completed: 100}}])
    assert.equal(openCodeRootTerminal(input, "root", "owned-prompt"), undefined);
});
