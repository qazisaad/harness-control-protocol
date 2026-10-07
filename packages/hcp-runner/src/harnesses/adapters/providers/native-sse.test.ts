import assert from "node:assert/strict";
import {test} from "node:test";
import {consumeNativeSse} from "./native-sse.js";

const stream=(chunks:Uint8Array[])=>new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
const encode=(value:string)=>new TextEncoder().encode(value);
test("CRLF and UTF-8 split at every byte retain exact native frames",async()=>{
  const raw=encode(': heartbeat\r\ndata: {"type":"native","text":"🙂"}\r\n\r\ndata: {"next":true}\r\n\r\n');
  const events:unknown[]=[];
  await assert.rejects(consumeNativeSse(stream([...raw].map(byte=>new Uint8Array([byte]))),value=>events.push(value),new AbortController().signal),/closed unexpectedly/);
  assert.deepEqual(events,[{type:"native",text:"🙂"},{next:true}]);
});
test("multi-line data and bare CR frames follow SSE line boundaries",async()=>{
  const events:unknown[]=[];
  await assert.rejects(consumeNativeSse(stream([encode('data: {\rdata: "native": true\rdata: }\r\r')]),value=>events.push(value),new AbortController().signal),/closed unexpectedly/);
  assert.deepEqual(events,[{native:true}]);
});
for(const [name,raw,reason]of[
  ["truncated JSON",encode('data: {"native":true}'),/inside a frame/],
  ["invalid JSON",encode('data: broken\n\n'),/invalid JSON/],
  ["invalid UTF-8",new Uint8Array([0xff]),/invalid UTF-8/],
]as const)test(`native SSE rejects ${name} without projecting an invented event`,async()=>{
  const events:unknown[]=[];
  await assert.rejects(consumeNativeSse(stream([raw]),value=>events.push(value),new AbortController().signal),reason);
  assert.deepEqual(events,[]);
});
test("oversized frames release the reader and preserve earlier valid events",async()=>{
  const events:unknown[]=[];let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encode('data: {"before":true}\n\n'));controller.enqueue(encode('data: '+"x".repeat(8*1024*1024)));},cancel(){cancelled=true;}});
  await assert.rejects(consumeNativeSse(body,value=>events.push(value),new AbortController().signal,{maxFrameBytes:8*1024*1024}),/bounded retention/);
  assert.deepEqual(events,[{before:true}]);assert.equal(cancelled,true);assert.equal(body.locked,false);
});

test("controlled cancellation releases a blocked reader without reporting unexpected owner death",async()=>{
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  const controller=new AbortController();
  const pending=consumeNativeSse(body,()=>assert.fail("invented cancellation event"),controller.signal);
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await pending;
  assert.equal(cancelled,true);assert.equal(body.locked,false);
});


test("large native image frames preserve complete JSON without losing their observation owner", async () => {
  const {createHash} = await import("node:crypto");
  const payload = {type: "message.part.updated", data: "x".repeat(14 * 1024 * 1024)};
  const raw = encode("data: " + JSON.stringify(payload) + "\n\n");
  const chunks: Uint8Array[] = [];for (let offset = 0; offset < raw.length; offset += 65536) chunks.push(raw.subarray(offset, offset + 65536));
  let observed = 0;
  await assert.rejects(consumeNativeSse(stream(chunks), value => {
    observed++;assert.equal(createHash("sha256").update(JSON.stringify(value)).digest("hex"), createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  }, new AbortController().signal), /closed unexpectedly/);
  assert.equal(observed, 1);
});
