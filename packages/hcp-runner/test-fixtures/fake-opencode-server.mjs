import { createServer } from "node:http";
import {appendFileSync} from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("opencode 1.2.3-test\n");
  process.exit(0);
}

const streams = new Set();
const sessions = new Set();
let counter = 0;
const record = value => {if (process.env.REUSE_RECORD) appendFileSync(process.env.REUSE_RECORD, JSON.stringify({pid:process.pid,...value})+'\n');};
record({kind:"server"});
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/session") {
    const id = `fake-opencode-session-${++counter}`;
    sessions.add(id); record({kind:"create",id});
    writeJson(response, { id });
    return;
  }
  if (request.method === "GET" && url.pathname === "/event") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    streams.add(response);
    response.on("close", () => streams.delete(response));
    return;
  }
  const sessionId = url.pathname.split('/')[2];
  if (request.method === "DELETE" && url.pathname === `/session/${sessionId}`) {
    record({kind:"delete",id:sessionId});
    if (process.env.FAIL_DELETE) {response.writeHead(500).end();return;}
    writeJson(response, sessions.delete(sessionId)); return;
  }
  if (request.method === "POST" && url.pathname === `/session/${sessionId}/message` && sessions.has(sessionId)) {
    for (const stream of streams) {
      sendEvent(stream, {
        type: "message.part.updated",
        properties: {
          part: { sessionID: sessionId, type: "reasoning" },
          delta: "thinking ",
        },
      });
      if (process.env.HOLD_TURN) continue;
      sendEvent(stream, {
        type: "message.part.updated",
        properties: {
          part: { sessionID: sessionId, type: "text" },
          delta: "hello",
        },
      });
      sendEvent(stream, { type: "session.idle", properties: { sessionID: sessionId } });
    }
    if (!process.env.HOLD_TURN) writeJson(response, { parts: [{ type: "text", text: "hello" }] });
    return;
  }
  if (request.method === "POST" && url.pathname === `/session/${sessionId}/abort`) {
    writeJson(response, { ok: true });
    return;
  }
  response.writeHead(404).end();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));

function sendEvent(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function writeJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
