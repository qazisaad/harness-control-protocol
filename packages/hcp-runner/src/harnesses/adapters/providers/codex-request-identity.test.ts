import assert from "node:assert/strict";
import {test} from "node:test";
import {codexRequestIdentity} from "./codex-request-identity.js";
const params = {threadId: "actual-native-thread", turnId: "actual-native-phase", itemId: "actual-native-item", requestId: "forged-param-id"};
test("Codex request identity requires transport context rather than a parameter-shaped request ID", () => {
  assert.equal(codexRequestIdentity(params), undefined);
  assert.deepEqual(codexRequestIdentity(params, {requestId: "actual-rpc-id"}), {source: "native", native_reference: "actual-native-thread",
    request_reference: "actual-rpc-id", execution_reference: "actual-native-phase", item_reference: "actual-native-item"});
});
test("numeric native RPC IDs retain their exact value without inventing an item reference", () => {
  assert.deepEqual(codexRequestIdentity({threadId: "thread", turnId: "phase"}, {requestId: 7}),
    {source: "native", native_reference: "thread", request_reference: "7", execution_reference: "phase"});
});
