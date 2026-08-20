import { createServer } from "node:http";

if (process.argv.includes("--version")) {
  process.stdout.write("opencode 1.2.3-test\n");
  process.exit(0);
}

const streams = new Set();
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/session") {
    writeJson(response, { id: "fake-opencode-session" });
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
  if (request.method === "POST" && url.pathname === "/session/fake-opencode-session/message") {
    for (const stream of streams) {
      sendEvent(stream, {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "fake-opencode-session", type: "reasoning" },
          delta: "thinking ",
        },
      });
      sendEvent(stream, {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "fake-opencode-session", type: "text" },
          delta: "hello",
        },
      });
      sendEvent(stream, { type: "session.idle", properties: { sessionID: "fake-opencode-session" } });
    }
    writeJson(response, { parts: [{ type: "text", text: "hello" }] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/session/fake-opencode-session/abort") {
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
