import { createServer } from "node:http";
import {appendFileSync, readFileSync, writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";

if (process.argv.includes("--version")) {
  process.stdout.write((process.env.HCP_TEST_OPENCODE_VERSION ?? "opencode 1.3.15-test") + "\n");
  process.exit(0);
}

const streams = new Set();
const pending = new Map();
const admittedMessages = new Map();
const emit = value => {for (const stream of streams) sendEvent(stream, value);};
const finish = response => {
  const messageID = `assistant-tools-${response.hcpMessageId}`;
  emit({type: "message.updated", properties: {info: {id: messageID, sessionID: "fake-opencode-session", role: "assistant", parentID: response.hcpMessageId}}});
  emit({type: "message.part.updated", properties: {part: {id: "tool", messageID, sessionID: "fake-opencode-session", type: "tool", tool: "bash", state: {status: "completed", input: {command: "echo hello"}, output: "hello"}}}});
  emit({type: "message.part.updated", properties: {part: {id: "tool", messageID, sessionID: "fake-opencode-session", type: "tool", tool: "bash", state: {status: "running", input: {command: "echo late"}}}}});
  emit({type: "session.idle", properties: {sessionID: "fake-opencode-session"}});
  writeJson(response, {parts: [{type: "text", text: "hello"}]});
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = body ? JSON.parse(body) : {};
  if (request.method === "GET" && url.pathname === "/config") {
    writeJson(response, JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")); return;
  }
  if (process.env.HCP_TEST_OPENCODE_RECORD) appendFileSync(process.env.HCP_TEST_OPENCODE_RECORD, JSON.stringify({method: request.method, path: url.pathname, payload}) + "\n");
  const admitted = /^\/session\/([^/]+)\/message\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && admitted) {
    const user = admittedMessages.get(admitted[2]);
    const info = {id: admitted[2], sessionID: user?.hcpSessionId, role: "user", system: user?.system};
    const drift = process.env.HCP_TEST_OPENCODE_INSTRUCTION_DRIFT;
    if (drift === "system") info.system = "Native rewritten instructions";
    if (drift === "session") info.sessionID = "unrelated-session";
    writeJson(response, {info}); return;
  }
  if (process.env.HCP_TEST_OPENCODE_HISTORY) {
    const file = process.env.HCP_TEST_OPENCODE_HISTORY;
    const histories = JSON.parse(readFileSync(file, "utf8"));
    const match = /^\/session\/([^/]+)(?:\/(message|fork))?$/.exec(url.pathname);
    const id = match?.[1];
    const retained = histories[id];
    if (retained && request.method === "GET") {
      writeJson(response, match[2] === "message" ? retained.messages : {id, directory: process.cwd(), permission: retained.permission}); return;
    }
    if (retained && match[2] === "fork" && request.method === "POST") {
      const target = `fork-${randomUUID()}`;
      const copied = retained.messages.filter(message => !payload.messageID || message.info.id < payload.messageID).map((message, index) => ({
        info: {...message.info, id: `copy-${index}`, sessionID: target}, parts: message.parts.map((part, partIndex) => ({...part,
          id: `part-${index}-${partIndex}`, messageID: `copy-${index}`, sessionID: target}))}));
      histories[target] = {messages: copied};
      writeFileSync(file, JSON.stringify(histories)); writeJson(response, {id: target}); return;
    }
    if (retained && request.method === "PATCH") {
      retained.permission = payload.permission;
      writeFileSync(file, JSON.stringify(histories)); writeJson(response, {id, permission: retained.permission}); return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      histories["fake-opencode-session"].permission = payload.permission;
      writeFileSync(file, JSON.stringify(histories));
    }
  }
  if (request.method === "POST" && url.pathname === "/session") {
    const permissions = payload.permission;
    const expected = ["full_access", "ask", "auto_edits"].map(policy => [
      {permission: "*", pattern: "*", action: policy === "full_access" ? "allow" : "ask"},
      ...(policy === "auto_edits" ? [{permission: "edit", pattern: "*", action: "allow"}] : []),
      {permission: "question", pattern: "*", action: policy === "full_access" ? "deny" : "allow"},
      {permission: "task", pattern: "*", action: "deny"},
    ]);
    if (!expected.some(rules => JSON.stringify(permissions) === JSON.stringify(rules))) {
      response.writeHead(400).end("Missing explicit session permissions");
      return;
    }
    writeJson(response, { id: "fake-opencode-session" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/session/fake-opencode-session") {
    writeJson(response, {id: "fake-opencode-session", directory: process.cwd(), permission: [
      {permission: "*", pattern: "*", action: "ask"},
      {permission: "question", pattern: "*", action: "allow"},
      {permission: "task", pattern: "*", action: "deny"},
    ]}); return;
  }
  if (request.method === "POST" && url.pathname === "/session/fake-opencode-session/summarize") {
    writeJson(response, true); return;
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
  if (request.method === "POST" && /^\/session\/[^/]+\/message$/.test(url.pathname)) {
    const executionId = url.pathname.split("/")[2];
    const text = payload.parts[0].text;
    response.hcpMessageId = payload.messageID;
    admittedMessages.set(payload.messageID, {...payload, hcpSessionId: executionId});
    if (text === "approval" || text === "question") {
      pending.set(text, response);
      emit({type: text === "approval" ? "permission.asked" : "question.asked", properties: {id: text, sessionID: "another-session", permission: "bash", questions: []}});
      emit({type: text === "approval" ? "permission.asked" : "question.asked", properties: {id: text, sessionID: "fake-opencode-session", permission: "bash",
        patterns: ["echo hello"], metadata: {}, questions: [{question: "Which scope?", header: "Scope", multiple: true, custom: false,
          options: [{label: "A", description: "first"}, {label: "B", description: "second"}]}]}});
      return;
    }
    for (const stream of streams) {
      const usagePart = {id: `usage-${payload.messageID}`, messageID: `answer-${payload.messageID}`, sessionID: executionId,
        type: "step-finish", cost: 0.5, tokens: {input: 10, output: 3, reasoning: 2, cache: {read: 20, write: 4}}};
      sendEvent(stream, {type: "message.part.updated", properties: {part: usagePart}});
      sendEvent(stream, {type: "message.part.updated", properties: {part: usagePart}});
      sendEvent(stream, {type: "message.updated", properties: {info: {id: usagePart.messageID, sessionID: executionId, role: "assistant", parentID: payload.messageID}}});
      sendEvent(stream, {type: "message.updated", properties: {info: {id: "older-answer", sessionID: executionId, role: "assistant", parentID: "older-prompt"}}});
      sendEvent(stream, {type: "message.part.updated", properties: {part: {...usagePart, id: "old-usage", messageID: "older-answer"}}});
      sendEvent(stream, {
        type: "message.part.updated",
        properties: {
          part: { id: `reasoning-${payload.messageID}`, messageID: usagePart.messageID, sessionID: executionId, type: "reasoning" },
          delta: "thinking ",
        },
      });
      sendEvent(stream, {
        type: "message.part.updated",
        properties: {
          part: { id: `text-${payload.messageID}`, messageID: usagePart.messageID, sessionID: executionId, type: "text" },
          delta: "hello",
        },
      });
      sendEvent(stream, { type: "session.idle", properties: { sessionID: executionId } });
    }
    writeJson(response, {info: {id: `answer-${payload.messageID}`, sessionID: executionId, role: "assistant", parentID: payload.messageID,
      providerID: payload.model?.providerID, modelID: payload.model?.modelID, variant: payload.variant,
      tokens: {input: 10, output: 3, reasoning: 2, cache: {read: 20, write: 4}}}, parts: [{ type: "text", text: "hello" }] });
    return;
  }
  if (request.method === "POST" && (url.pathname === "/permission/approval/reply" || url.pathname === "/question/question/reply")) {
    const kind = url.pathname.startsWith("/permission") ? "approval" : "question";
    if ((kind === "approval" && payload.reply !== "once") || (kind === "question" && JSON.stringify(payload.answers) !== JSON.stringify([["A", "B"]]))) {
      response.writeHead(400).end("Incorrect native reply"); return;
    }
    const original = pending.get(kind); pending.delete(kind);
    writeJson(response, true);
    finish(original); return;
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
