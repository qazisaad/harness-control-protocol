import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {harnessNativeWorkObservationSchema} from "@harness-control/protocol";
import {NativeProcess} from "../packages/hcp-runner/dist/harnesses/adapters/providers/native-process.js";
import {NativeEventOwner} from "../packages/hcp-runner/dist/harnesses/adapters/providers/native-event-owner.js";
import {OpenCodeOwnedWork} from "../packages/hcp-runner/dist/harnesses/adapters/providers/opencode-work.js";
import {prepareControlledOpenCode} from "../packages/hcp-runner/dist/harnesses/adapters/providers/opencode-controlled.js";
import {openCodeMessageId} from "../packages/hcp-runner/dist/harnesses/adapters/providers/opencode-usage.js";

if(process.env.HCP_NATIVE_LIVE!=="1")throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated native component acceptance.");
const cwd=await mkdtemp(join(tmpdir(),"hcp-opencode-work-component-"));
const marker=randomUUID(),model=process.env.HCP_LIVE_OPENCODE_MODEL??"opencode-go/glm-5.3-flash";
const [providerID,...modelParts]=model.split("/");
const profile=await prepareControlledOpenCode({env:process.env,cwd,providerId:providerID,mcpServers:{}});
const native=new NativeProcess("opencode",["serve","--hostname=127.0.0.1","--port=0"],cwd,
  {...profile.env,OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS:"true"});
native.child.stdin.end();
let owner,observer,work,url,root;
const observerAbort=new AbortController();
const events=[];
const until=async predicate=>{
  const end=Date.now()+120000;
  while(Date.now()<end){if(work)await work.settled();const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error("Native component acceptance did not reach its required observation.");
};
try {
  url=await new Promise((resolve,reject)=>{
    let text="";
    const timer=setTimeout(()=>reject(new Error("Native server readiness timed out.")),10000);
    native.child.stdout.on("data",chunk=>{text=(text+chunk.toString()).slice(-32768);const found=/http:\/\/127\.0\.0\.1:\d+/.exec(text);if(found){clearTimeout(timer);resolve(found[0]);}});
    void native.closed.then(()=>{clearTimeout(timer);reject(new Error("Native server exited before readiness."));});
  });
  const request=async(path,body)=>{
    const response=await fetch(new URL(`${path}?directory=${encodeURIComponent(cwd)}`,url),{method:body===undefined?"GET":"POST",
      ...(body===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
    assert.equal(response.ok,true,`Native HTTP status ${response.status}`);return await response.json();
  };
  assert.equal((await request("/experimental/capabilities")).backgroundSubagents,true);
  root=(await request("/session",{title:"HCP ownership acceptance",permission:[{permission:"*",pattern:"*",action:"allow"},
    {permission:"question",pattern:"*",action:"deny"}]})).id;
  const provider=RunnerConfigSchema.parse({runner_id:"component",control_plane_url:"ws://localhost:1",provider_instances:[{id:"opencode",driver_kind:"opencode"}]}).provider_instances[0];
  work=new OpenCodeOwnedWork(root,{provider,payload:{session_id:"component",workspace_id:"workspace",provider_instance_id:"opencode",driver_kind:"opencode",cwd,
    model_selection:{model},sandbox_mode:"danger_full_access",approval_policy:"full_access",continue_session:false,mcp_servers:[]},emitSessionEvent:event=>{
      if(event.event_type==="native.work.updated")harnessNativeWorkObservationSchema.parse(event.data.work);events.push(event);
    }},{session:id=>request(`/session/${encodeURIComponent(id)}`),message:(session,id)=>request(`/session/${encodeURIComponent(session)}/message/${encodeURIComponent(id)}`),
      cancel:id=>request(`/session/${encodeURIComponent(id)}/abort`,{})});
  owner=new NativeEventOwner(async signal=>{
    const response=await fetch(new URL(`/event?directory=${encodeURIComponent(cwd)}`,url),{headers:{accept:"text/event-stream"},signal});
    assert.equal(response.ok,true);assert.ok(response.body);return response.body;
  },()=>work.lose());
  let ready;
  const subscribed=new Promise(resolve=>{ready=resolve;});
  observer=owner.consume(value=>work.observe(value),observerAbort.signal,ready);void observer.catch(()=>{});await subscribed;
  const prompt=openCodeMessageId();work.admitRoot(prompt,"original-root");
  console.log(JSON.stringify({stage:"background-launch",cwd}));
  await request(`/session/${encodeURIComponent(root)}/message`,{messageID:prompt,model:{providerID,modelID:modelParts.join("/")},parts:[{type:"text",
    text:`Use task exactly once with background: true, subagent_type: general, and this exact prompt: Use bash to run exactly sleep 30; printf '%s' '${marker}'. Use no other tools, then return the output. After launching, reply ROOT_RETURNED immediately. Do not wait, poll or use any other tools.`}]});
  await work.settled();
  const child=events.find(event=>event.event_type==="native.work.updated"&&event.data.work.kind==="agent")?.data.work;
  assert.ok(child,"Native provider did not launch an owned task");assert.equal(child.background,true);
  assert.ok(work.childOrigin(child.native_reference),"No child remained after its root turn");
  console.log(JSON.stringify({stage:"root-returned-child-active",cwd}));
  await until(()=>events.some(event=>event.event_type==="native.work.updated"&&event.data.work.work_id===child.work_id&&event.data.work.status==="completed"));
  await until(()=>events.some(event=>event.event_type==="native.work.updated"&&event.data.work.kind==="task"&&event.data.work.status==="completed"));
  assert.equal(work.busy,false,"Native parent continuation remained unresolved");
  console.log(JSON.stringify({stage:"completion-and-parent-continuation-confirmed",cwd}));
  const next=openCodeMessageId();work.admitRoot(next,"cancel-root");
  await request(`/session/${encodeURIComponent(root)}/message`,{messageID:next,model:{providerID,modelID:modelParts.join("/")},parts:[{type:"text",
    text:`Use task exactly once with background: true, subagent_type: general, and this exact prompt: Use bash to run exactly sleep 60; printf '%s' '${marker}'. Use no other tools, then return the output. After launching, reply ROOT_RETURNED immediately. Do not wait, poll or use any other tools.`}]});
  const cancelled=await until(()=>events.findLast(event=>event.event_type==="native.work.updated"&&event.data.work.origin_turn_id==="cancel-root"&&event.data.work.supports_cancel)?.data.work);
  console.log(JSON.stringify({stage:"individual-child-cancellation",cwd}));
  await work.cancel({...cancelled,revision:1},new AbortController().signal);
  await until(()=>events.some(event=>event.event_type==="native.work.updated"&&event.data.work.work_id===cancelled.work_id&&event.data.work.status==="cancelled"));
  assert.equal(work.busy,false,"Cancelled child has no confirmed native terminal closure");
  const last=openCodeMessageId();work.admitRoot(last,"shutdown-root");
  console.log(JSON.stringify({stage:"family-shutdown",cwd}));
  await request(`/session/${encodeURIComponent(root)}/message`,{messageID:last,model:{providerID,modelID:modelParts.join("/")},parts:[{type:"text",
    text:`Use task exactly once with background: true, subagent_type: general, and this exact prompt: Use bash to run exactly sleep 60; printf '%s' '${marker}'. Use no other tools, then return the output. After launching, reply ROOT_RETURNED immediately. Do not wait, poll or use any other tools.`}]});
  const shutdown=await until(()=>events.findLast(event=>event.event_type==="native.work.updated"&&event.data.work.origin_turn_id==="shutdown-root"&&event.data.work.supports_cancel)?.data.work);
  await work.stop();assert.equal(work.busy,false);
  assert.ok(events.some(event=>event.event_type==="native.work.updated"&&event.data.work.work_id===shutdown.work_id&&event.data.work.status==="cancelled"));
  console.log(JSON.stringify({passed:["native-background-capability","admitted-parent-workspace","child-after-root","native-job-completion","separate-parent-continuation",
    "native-child-cancel-ack","observed-native-child-cancelled","root-abort-cancels-descendants","safe-native-family-shutdown"],cwd}));
} finally {
  if(url&&root){try{await fetch(new URL(`/session/${encodeURIComponent(root)}/abort?directory=${encodeURIComponent(cwd)}`,url),{method:"POST",signal:AbortSignal.timeout(10000)});}catch{}}
  observerAbort.abort();await observer?.catch(()=>{});await owner?.close();await native.stop();await profile.cleanup();
}
