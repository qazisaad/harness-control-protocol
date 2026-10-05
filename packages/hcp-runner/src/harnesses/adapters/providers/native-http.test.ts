import assert from "node:assert/strict";
import {test} from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import {fetchNativeResponse} from "./native-http.js";

for (const method of ["GET", "POST"]) test(`native HTTP ${method} ${method === "GET" ? "recovers a reset read" : "never repeats an uncertain mutation"}`, async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (requests === 1) {request.socket.destroy(); return;}
    response.end("ready");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const result = fetchNativeResponse(new URL(`http://127.0.0.1:${address.port}`), {method});
    if (method === "GET") {assert.equal(await (await result).text(), "ready"); assert.equal(requests, 2);}
    else {await assert.rejects(result); assert.equal(requests, 1);}
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});
