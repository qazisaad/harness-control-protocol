import assert from "node:assert/strict";
import {test} from "node:test";
import {tmpdir} from "node:os";
import type {RpcMessage} from "./codex-rpc.js";
import {updateCodexRootSettings,readCodexSettingsNotification} from "./codex-settings.js";

function fixture() {
  let observer:((message:RpcMessage)=>void)|undefined;
  const expected={threadId:"root",model:"model",effort:"low",mode:"default" as const,cwd:tmpdir(),approvalPolicy:"untrusted",sandbox:{type:"dangerFullAccess"}};
  const settings={model:"model",effort:"low",cwd:tmpdir(),approvalPolicy:"untrusted",approvalsReviewer:"user",
    collaborationMode:{mode:"default",settings:{model:"model",reasoning_effort:"low"}},sandboxPolicy:{type:"dangerFullAccess"}};
  const send=(value:unknown=settings,threadId="root")=>observer?.({method:"thread/settings/updated",params:{threadId,threadSettings:value}});
  const rpc={observeNotifications(callback:(message:RpcMessage)=>void){observer=callback;return()=>{observer=undefined;};},
    async request(_method:string,_params:unknown):Promise<unknown>{send();return {};}};
  return {expected,settings,rpc,send,subscribed:()=>Boolean(observer)};
}
test("native settings notification before RPC ACK is retained, but success requires both",async()=>{
  const f=fixture();let acknowledge!:(value:unknown)=>void,done=false;
  f.rpc.request=async(method,params)=>{assert.equal(method,"thread/settings/update");assert.equal((params as {effort:string}).effort,"low");f.send();return new Promise(resolve=>{acknowledge=resolve;});};
  const pending=updateCodexRootSettings(f.rpc,f.expected,new AbortController().signal).then(value=>{done=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(done,false);
  acknowledge({});assert.equal((await pending).effort,"low");assert.equal(f.subscribed(),false);
});
test("unchanged root settings reuse continuously retained native evidence without a no-op mutation",async()=>{
  const f=fixture();const readback=readCodexSettingsNotification({method:"thread/settings/updated",params:{threadId:"root",threadSettings:f.settings}})!;
  f.rpc.request=async()=>assert.fail("A no-op native mutation does not emit another notification");
  assert.equal((await updateCodexRootSettings(f.rpc,f.expected,new AbortController().signal,readback)).effort,"low");
  await assert.rejects(updateCodexRootSettings(f.rpc,f.expected,new AbortController().signal,{...readback,threadSettings:{...readback.threadSettings,approvalPolicy:"never"}}),/authorized effective/);
});
test("an ACK alone and unrelated thread notification cannot confirm settings",async()=>{
  const f=fixture(),abort=new AbortController();let done=false;
  f.rpc.request=async()=>{f.send(f.settings,"child");return {};};
  const pending=updateCodexRootSettings(f.rpc,f.expected,abort.signal).then(()=>{done=true;});
  const rejected=assert.rejects(pending,/cancelled/);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(done,false);abort.abort(new Error("cancelled"));await rejected;
  assert.equal(f.subscribed(),false);
});
test("lost ACK remains bounded by cancellation even after effective settings arrived",async()=>{
  const f=fixture(),abort=new AbortController();
  f.rpc.request=async()=>{f.send();return new Promise(()=>{});};
  const pending=updateCodexRootSettings(f.rpc,f.expected,abort.signal),rejected=assert.rejects(pending,/cancelled/);
  abort.abort(new Error("cancelled"));await rejected;assert.equal(f.subscribed(),false);
});
test("native settings reject changed authority, clamped effort and a different model",async()=>{
  for(const patch of [{approvalPolicy:"never"},{approvalsReviewer:"auto"},{effort:"high"},{model:"other"},{sandboxPolicy:{type:"workspaceWrite"}}]) {
    const f=fixture();f.rpc.request=async()=>{f.send({...f.settings,...patch});return {};};
    await assert.rejects(updateCodexRootSettings(f.rpc,f.expected,new AbortController().signal),/authorized effective/);
    assert.equal(f.subscribed(),false);
  }
});
test("native workspace settings cannot gain temporary directories or writable roots",async()=>{
  const f=fixture();const sandbox={type:"workspaceWrite",writableRoots:[tmpdir()],excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  f.rpc.request=async()=>{f.send({...f.settings,sandboxPolicy:{...sandbox,excludeTmpdirEnvVar:false}});return {};};
  await assert.rejects(updateCodexRootSettings(f.rpc,{...f.expected,sandbox},new AbortController().signal),/temporary-directory policy/);
});
test("explicit effort reset is sent through collaboration settings and confirmed as null",async()=>{
  const f=fixture();f.rpc.request=async(_method,params)=>{
    assert.equal((params as {effort:unknown}).effort,null);
    f.send({...f.settings,effort:null,collaborationMode:{mode:"plan",settings:{model:"model",reasoning_effort:null}}});return {};
  };
  const {effort:_effort,...expected}=f.expected;
  assert.equal((await updateCodexRootSettings(f.rpc,{...expected,mode:"plan"},new AbortController().signal)).effort,null);
});
test("native advertised effort strings are preserved without freezing a provider enum",async()=>{
  const f=fixture();f.rpc.request=async()=>{f.send({...f.settings,effort:"future-effort",
    collaborationMode:{mode:"default",settings:{model:"model",reasoning_effort:"future-effort"}}});return {};};
  assert.equal((await updateCodexRootSettings(f.rpc,{...f.expected,effort:"future-effort"},new AbortController().signal)).effort,"future-effort");
});
