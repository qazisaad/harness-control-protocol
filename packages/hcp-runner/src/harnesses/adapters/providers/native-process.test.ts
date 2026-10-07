import assert from "node:assert/strict";
import {test} from "node:test";
import {NativeProcess} from "./native-process.js";

test("failed forced native shutdown rejects its owner without an uncaught timer or a closure claim", async context => {
  if (process.platform === "win32") return context.skip("POSIX owned process-group signaling");
  const owner = new NativeProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), process.env);
  const denied = Object.assign(new Error("Controlled signal refusal."), {code: "EPERM"});
  let attempts = 0;
  const signal = context.mock.method(process, "kill", () => {
    attempts++;
    if (attempts > 1) throw denied;
    return true;
  });
  try {
    void owner.stop();
    await new Promise(resolve => setTimeout(resolve, 1_050));
    await assert.rejects(owner.stop(), failure => failure === denied);
    assert.equal(signal.mock.callCount(), 2);
    let closed = false;void owner.closed.then(() => {closed = true;});
    await new Promise(resolve => setTimeout(resolve, 10));assert.equal(closed, false);
    await assert.rejects(owner.stop(), failure => failure === denied);
    assert.equal(signal.mock.callCount(), 2);
  } finally {
    signal.mock.restore();owner.child.kill("SIGKILL");await owner.closed;
  }
});
