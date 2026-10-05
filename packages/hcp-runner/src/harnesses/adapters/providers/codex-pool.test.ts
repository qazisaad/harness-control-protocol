import assert from "node:assert/strict";
import {test} from "node:test";
import {CodexProcessPool} from "./codex-pool.js";

function fixture(capacity = 2, idle = 120_000) {
  let created = 0, stopped = 0;
  const pool = new CodexProcessPool(async () => {
    let closed!: () => void;
    let done = false;
    return {id: ++created, process: {closed: new Promise<void>(r => {closed=r;}),
      stop: async () => {if (!done) {done=true;stopped++;closed();}}}};
  }, capacity, idle);
  return {pool, counts: () => ({created,stopped})};
}
test("same scoped key reuses only an idle exclusive process", async () => {
  const f=fixture();
  try {
    const first=await f.pool.acquire("workspace/provider/policy");
    const concurrent=await f.pool.acquire("workspace/provider/policy");
    assert.notEqual(first.runtime.id,concurrent.runtime.id);
    await assert.rejects(f.pool.acquire("other"), /leased/);
    await first.release(true);
    const next=await f.pool.acquire("workspace/provider/policy");
    assert.equal(next.runtime.id,first.runtime.id);
    await next.release(true);await concurrent.release(true);
  } finally {await f.pool.close();}
  assert.deepEqual(f.counts(),{created:2,stopped:2});
});
test("changed scope evicts idle process and failed cleanup destroys it", async () => {
  const f=fixture(1);
  try {
    const first=await f.pool.acquire("scope-a");await first.release(true);
    const second=await f.pool.acquire("scope-b");assert.notEqual(first.runtime.id,second.runtime.id);
    await second.release(false);
    const third=await f.pool.acquire("scope-b");assert.notEqual(third.runtime.id,second.runtime.id);
    await third.release(true);
  } finally {await f.pool.close();}
  assert.deepEqual(f.counts(),{created:3,stopped:3});
});
test("idle timeout retires process; close prevents new leases", async () => {
  const f=fixture(1,10);
  const first=await f.pool.acquire("scope");await first.release(true);
  await new Promise(r=>setTimeout(r,30));assert.equal(f.counts().stopped,1);
  await f.pool.close();await assert.rejects(f.pool.acquire("scope"),/closed/);
});
test("shutdown during initialization cannot register a surviving process", async () => {
  let ready!: () => void;let stopped=0;
  const pool = new CodexProcessPool(async () => {
    await new Promise<void>(r=>{ready=r;});
    return {process:{closed:new Promise<void>(()=>{}),stop:async()=>{stopped++;}}};
  });
  const opening=pool.acquire("scope");const rejected=assert.rejects(opening,/closed/);
  await pool.close();ready();await rejected;assert.equal(stopped,1);
});

test("retiring process continues to consume capacity until physically stopped", async () => {
  let finish!: () => void;
  const pool = new CodexProcessPool(async () => ({process: {
    closed: new Promise<void>(() => {}),
    stop: () => new Promise<void>(resolve => {finish = resolve;}),
  }}), 1);
  const first = await pool.acquire("a");
  const retiring = first.release(false);
  await assert.rejects(pool.acquire("b"), /leased/);
  finish();
  await retiring;
  await pool.close();
});
