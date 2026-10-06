import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager,HarnessAdapterRegistry,type HarnessAdapter} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";

test("custom profiles enforce advertised configuration before launching and preserve their identity",async()=>{
  const cwd=await mkdtemp(join(tmpdir(),"hcp-profile-"));let starts=0,stops=0;
  const required={user_settings:false,project_settings:false,hooks:false,mcp_servers:false,plugins:false};
  const adapter:HarnessAdapter={driverKind:"example",executionProfiles:[{id:"background",runtime_lifetime:"session",native_work:false,session_events:false,
    required_configuration_inheritance:required}],configurationInheritance:required,
    async validateStart(){},async probe(){return {driver_kind:"example",installed:true,available:true,models:[]};},
    async startSession(input){starts++;assert.equal(input.payload.execution_profile,"background");return {adapter_session_id:"owner"};},
    async sendTurn(){return [];},async cancelTurn(){return [];},async stopSession(){stops++;return [];}};
  const manager=new HarnessSessionManager(RunnerConfigSchema.parse({runner_id:"runner",control_plane_url:"ws://localhost:1",workspaces:[{id:"workspace",path:cwd}],
    provider_instances:[{id:"example",driver_kind:"example"}]}),{adapterRegistry:new HarnessAdapterRegistry([adapter])});
  const payload:HcpSessionStartPayload={session_id:"session",workspace_id:"workspace",provider_instance_id:"example",driver_kind:"example",cwd,
    model_selection:{model:"model"},sandbox_mode:"read_only",approval_policy:"ask",continue_session:false,mcp_servers:[],execution_profile:"background"};
  try {
    await assert.rejects(manager.startSession({...payload,execution_profile:"undeclared"}),/selected execution profile/);
    await assert.rejects(manager.startSession(payload),/explicit configuration inheritance/);
    await assert.rejects(manager.startSession({...payload,configuration_inheritance:{...required,hooks:true}}),/explicit configuration inheritance/);
    assert.equal(starts,0);
    adapter.executionProfiles![0]!.native_work=true;
    await assert.rejects(manager.startSession({...payload,configuration_inheritance:required}),/retained runtime, observations and cancellation controls/);
    adapter.executionProfiles![0]!.native_work=false;
    assert.equal(starts,0);
    adapter.executionProfiles![0]!.mcp_attachments=false;
    await assert.rejects(manager.startSession({...payload,configuration_inheritance:required,mcp_servers:[{name:"unverified",transport:"streamable_http",
      url:"http://127.0.0.1:1/mcp",headers:{},lease_id:"lease",proof_of_possession:{scheme:"runner_signed_request",key_id:"key",required_headers:["x-proof"]}}]}),/MCP attachments/);
    assert.equal(starts,0,"A profile rejection must happen before any MCP attachment or native launch");
    await manager.startSession({...payload,configuration_inheritance:required});assert.equal(starts,1);
    await manager.stopSession("session","done");assert.equal(stops,1);
  } finally {if(manager.activeSessionCount())await manager.stopSession("session","cleanup");await rm(cwd,{recursive:true,force:true});}
});
