import {z} from "zod";
import type {HcpTurnSendPayload} from "@harness-control/protocol";
import {NativeInteractions} from "../../native-interactions.js";
import {HarnessAdapterError,type HarnessAdapterStartInput} from "../types.js";
import {OpenCodeOwnedWork} from "./opencode-work.js";
import {respondOpenCodeInteraction} from "./opencode-interactions.js";

type Owner={session:string;prompt:string;workId:string;lifetime:AbortController;interactions:NativeInteractions};
export class OpenCodeWorkCallbacks {
  readonly #roots=new Map<string,HcpTurnSendPayload>();
  readonly #owners=new Map<string,Owner>();
  readonly #seen=new Set<string>();
  readonly #closingWorks=new Set<string>();
  #closed=false;
  constructor(readonly work:OpenCodeOwnedWork,readonly start:HarnessAdapterStartInput,
    readonly reply:(path:string,body:unknown,signal:AbortSignal)=>Promise<unknown>,readonly onFailure:(error:unknown)=>void) {
    if(!start.emitSessionEvent||!start.registerSessionInteractions)throw new HarnessAdapterError("native_session_owner_required","Persistent callbacks require a registered session owner.");
    start.registerSessionInteractions({owns:id=>[...this.#owners.values()].some(owner=>owner.interactions.owns(id)),
      respondApproval:response=>this.#find(response.request_id).respondApproval(response),respondInput:response=>this.#find(response.request_id).respondInput(response)});
  }
  #find(request:string):NativeInteractions {
    const owner=[...this.#owners.values()].find(owner=>owner.interactions.owns(request));
    if(!owner||this.#closed)throw new HarnessAdapterError("native_request_owner_missing","The native child callback owner is unavailable.");
    return owner.interactions;
  }
  admitRoot(payload:HcpTurnSendPayload):void {
    if(this.#roots.size>=1024||this.#roots.has(payload.turn_id))throw new HarnessAdapterError("native_work_origin_limit","Native callback admission exceeds its bounded registry.");
    this.#roots.set(payload.turn_id,payload);
  }
  observe(value:unknown):void {
    const event=z.object({type:z.string(),properties:z.record(z.string(),z.unknown())}).parse(value);
    void this.work.settled().then(async()=>{
      this.synchronize();
      if(this.#closed||!["permission.asked","question.asked"].includes(event.type))return;
      const session=z.string().min(1).max(512).parse(event.properties.sessionID);
      let origin=this.work.childOrigin(session);
      if(session===this.work.root) {
        const request=z.object({tool:z.object({messageID:z.string().min(1).max(512)})}).parse(event.properties);
        const native=z.object({info:z.object({id:z.string(),sessionID:z.string(),role:z.literal("assistant"),parentID:z.string()})}).parse(
          await this.work.transport.message(session,request.tool.messageID)).info;
        if(native.id!==request.tool.messageID||native.sessionID!==session)throw new HarnessAdapterError("native_work_request_binding","The native parent callback changed identity.");
        origin=this.work.continuationOrigin(native.parentID);
      }
      if(!origin)return; // Root callbacks belong to their separate root subscription.
      if(this.#closingWorks.has(origin.work_id))return;
      if(!origin.prompt_id)throw new HarnessAdapterError("native_work_request_binding","Native child callback has no confirmed prompt origin.");
      const id=z.string().min(1).max(512).parse(event.properties.id),key=`${session}\0${id}`;
      if(this.#seen.has(key))return;
      if(this.#seen.size>=4096)throw new HarnessAdapterError("native_work_request_limit","Native callback receipts exceeded their bounded registry.");
      this.#seen.add(key);
      let owner=this.#owners.get(origin.work_id);
      if(!owner) {
        const payload=this.#roots.get(origin.origin_turn_id);
        if(!payload||this.#owners.size>=128)throw new HarnessAdapterError("native_work_request_binding","The native child has no original callback admission.");
        owner={session,prompt:origin.prompt_id,workId:origin.work_id,lifetime:new AbortController(),interactions:new NativeInteractions(this.start.payload,payload,
          {threadId:session,turnId:()=>payload.turn_id},this.start.emitSessionEvent!,origin.work_id)};
        this.#owners.set(origin.work_id,owner);
      }
      const captured=owner;
      try{await respondOpenCodeInteraction(event,{sessionId:session,promptId:origin.prompt_id,turnId:origin.origin_turn_id,owner:captured.interactions,
        signal:captured.lifetime.signal,sessionPermissions:!this.start.payload.approval_options,readMessage:id=>this.work.transport.message(session,id),reply:this.reply});}
      catch(error){if(!captured.lifetime.signal.aborted)throw error;}
    }).catch(error=>{if(!this.#closed)this.onFailure(error);});
  }
  synchronize():void {
    for(const [id,owner]of this.#owners)if((owner.session===this.work.root?this.work.continuationOrigin(owner.prompt):this.work.childOrigin(owner.session))?.work_id!==id) {
      owner.lifetime.abort();owner.interactions.close();this.#owners.delete(id);
    }
  }
  closeWork(id:string):void {
    this.#closingWorks.add(id);
    const owner=this.#owners.get(id);
    if(owner){owner.lifetime.abort();owner.interactions.close();this.#owners.delete(id);}
  }
  close():void {
    if(this.#closed)return;this.#closed=true;
    for(const owner of this.#owners.values()){owner.lifetime.abort();owner.interactions.close();}
    this.#owners.clear();this.#roots.clear();this.start.registerSessionInteractions?.(undefined);
  }
}
