import assert from "node:assert/strict";
import {test} from "node:test";
import {harnessExecutionProfileCapabilitiesSchema,harnessExecutionProfileIdSchema,hcpHarnessEventPayloadSchema} from "./index.js";

test("effective settings evidence has an explicit root scope and native provenance",()=>{
  const event={session_id:"session",turn_id:"turn",sequence:1,created_at:new Date().toISOString(),event_type:"settings.effective",
    data:{scope:"root",source:"native",model_selection:{model:"model",options:[]},mode:"execute",approval_policy:"ask",sandbox_mode:"read_only"}};
  assert.equal(hcpHarnessEventPayloadSchema.safeParse(event).success,true);
  const {turn_id:_turn,...unowned}=event;
  assert.equal(hcpHarnessEventPayloadSchema.safeParse(unowned).success,false);
  for(const patch of [{scope:"all_work"},{source:"requested"},{approval_policy:"implicit"}])
    assert.equal(hcpHarnessEventPayloadSchema.safeParse({...event,data:{...event.data,...patch}}).success,false);
});

test("apps can distinguish root-only interruption from descendant cancellation",()=>{
  const base={id:"interactive",runtime_lifetime:"session",native_work:true,session_events:true};
  for(const effect of ["root_only","owned_work","unknown"])
    assert.equal(harnessExecutionProfileCapabilitiesSchema.parse({...base,root_interrupt_effect:effect}).root_interrupt_effect,effect);
  assert.equal(harnessExecutionProfileCapabilitiesSchema.parse(base).root_interrupt_effect,undefined);
  assert.equal(harnessExecutionProfileCapabilitiesSchema.safeParse({...base,root_interrupt_effect:"always_preserved"}).success,false);
});
test("driver profiles are bounded discoverable identities with explicit configuration requirements",()=>{
  const profile=harnessExecutionProfileCapabilitiesSchema.parse({id:"background",runtime_lifetime:"session",native_work:true,session_events:true,
    required_configuration_inheritance:{user_settings:false,project_settings:false,hooks:false,mcp_servers:false,plugins:false}});
  assert.equal(profile.id,"background");assert.equal(profile.required_configuration_inheritance?.plugins,false);
  for(const value of ["", "UPPER", "../settings", "a".repeat(65)])assert.equal(harnessExecutionProfileIdSchema.safeParse(value).success,false);
});
