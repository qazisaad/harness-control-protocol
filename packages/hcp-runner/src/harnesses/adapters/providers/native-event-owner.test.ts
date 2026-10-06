import assert from "node:assert/strict";
import {test} from "node:test";
import {NativeEventOwner} from "./native-event-owner.js";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
test("root unsubscribe keeps one native connection alive for later observers",async()=>{
  let source!:ReadableStreamDefaultController<Uint8Array>,opens=0,cancelled=false;
  const owner=new NativeEventOwner(async()=>{opens++;return new ReadableStream({start(c){source=c;},cancel(){cancelled=true;}});},()=>assert.fail("unexpected death"));
  const first:number[]=[],second:number[]=[];
  const a=new AbortController(),b=new AbortController();
  const one=owner.consume(value=>first.push((value as {n:number}).n),a.signal,()=>{});
  await tick();source.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'));await tick();
  a.abort();await one;assert.equal(cancelled,false);
  const two=owner.consume(value=>second.push((value as {n:number}).n),b.signal,()=>{});
  await tick();source.enqueue(new TextEncoder().encode('data: {"n":2}\n\n'));await tick();
  b.abort();await two;await owner.close();
  assert.equal(opens,1);assert.equal(cancelled,true);assert.deepEqual(first,[1]);assert.deepEqual(second,[2]);
});
test("native EOF fails current and future roots with the same owner loss",async()=>{
  let source!:ReadableStreamDefaultController<Uint8Array>,loss:Error|undefined;
  const owner=new NativeEventOwner(async()=>new ReadableStream({start(c){source=c;}}),error=>{loss=error;});
  const pending=owner.consume(()=>{},new AbortController().signal,()=>{});
  const rejected=assert.rejects(pending,/closed unexpectedly/);
  await tick();source.close();await rejected;
  assert.ok(loss);await assert.rejects(owner.consume(()=>{},new AbortController().signal,()=>assert.fail("readmitted lost owner")),error=>error===loss);
  await owner.close();
});
test("closing an idle owner releases its reader without native death",async()=>{
  let cancelled=false;
  const owner=new NativeEventOwner(async()=>new ReadableStream({cancel(){cancelled=true;}}),()=>assert.fail("controlled close reported death"));
  await owner.ready;await owner.close();await owner.close();assert.equal(cancelled,true);
});
