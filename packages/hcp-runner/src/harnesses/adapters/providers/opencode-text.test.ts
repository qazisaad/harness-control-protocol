import assert from "node:assert/strict";
import {test} from "node:test";
import {harnessTextDeltaEventDataSchema} from "@harness-control/protocol";
import {OpenCodeText} from "./opencode-text.js";
import type {HarnessAdapterEvent} from "../types.js";

const message = (parentID = "prompt") => ({type: "message.updated", properties: {info: {id: "message", sessionID: "session", role: "assistant", parentID}}});
const part = (text: string, type = "text") => ({type: "message.part.updated", properties: {part: {id: "part", messageID: "message", sessionID: "session", type, text}}});
const delta = (text: string) => ({type: "message.part.delta", properties: {sessionID: "session", messageID: "message", partID: "part", field: "text", delta: text}});

test("OpenCode modern deltas and legacy snapshots project equivalent text without duplicate snapshot output", () => {
  for (const modern of [false, true]) {
    const events: HarnessAdapterEvent[] = [];
    const stream = new OpenCodeText("session", "prompt", "turn", event => events.push(event));
    stream.observe(message()); stream.observe(part(""));
    if (modern) {stream.observe(delta("hello")); stream.observe(delta(" world"));}
    else {stream.observe(part("hello")); stream.observe(part("hello world"));}
    stream.observe(part("hello world")); stream.observe(part("hello"));
    assert.equal(events.map(event => harnessTextDeltaEventDataSchema.parse(event.data).delta).join(""), "hello world");
    for (const event of events) {assert.equal(event.data.item_id, "part"); assert.equal(event.data.message_id, "message");}
  }
});

test("OpenCode buffers text until root ownership, excludes older roots and distinguishes reasoning", () => {
  const events: HarnessAdapterEvent[] = [];
  const stream = new OpenCodeText("session", "prompt", "turn", event => events.push(event));
  stream.observe(part("thinking", "reasoning")); assert.equal(events.length, 0);
  stream.observe(message()); assert.equal(events[0]?.event_type, "reasoning.delta");
  const foreign = new OpenCodeText("session", "prompt", "turn", event => events.push(event));
  foreign.observe(part("older root")); foreign.observe(message("older-prompt"));
  foreign.observe({...delta("later foreign text"), properties: {...delta("later foreign text").properties, partID: "unobserved-foreign-part"}});
  assert.equal(events.length, 1);
});

test("OpenCode cannot replace emitted text or rebind an admitted part to another message", () => {
  const stream = new OpenCodeText("session", "prompt", "turn", () => {});
  stream.observe(message()); stream.observe(part("hello"));
  assert.throws(() => stream.observe(part("goodbye")), /rewrote streamed text/);
  assert.throws(() => stream.observe({...delta("bad"), properties: {...delta("bad").properties, messageID: "foreign"}}), /another message/);
});
