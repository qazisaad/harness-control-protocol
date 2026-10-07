import {randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {z} from "zod";
import {isNativeWorkTerminal,type HarnessNativeWorkObservation,type HarnessNativeWorkRecord} from "@harness-control/protocol";
import {HarnessAdapterError,type HarnessAdapterStartInput} from "../types.js";

const id=z.string().min(1).max(512);
const eventSchema=z.object({type:z.string(),properties:z.record(z.string(),z.unknown())});
const partSchema=z.object({id,messageID:id,sessionID:id,type:z.literal("tool"),tool:z.literal("task"),callID:id,
  state:z.object({status:z.enum(["pending","running","completed","error"]),title:z.string().max(2048).optional(),
    metadata:z.object({parentSessionId:id,sessionId:id,background:z.boolean().optional(),jobId:id.optional()}).optional()}).passthrough()});
type Child={parent:string;launch:string;prompt?:string;cancelAccepted?:true;aborted?:true;work:HarnessNativeWorkObservation;
  custody?:import("../../../state/index.js").NativeWorkCustody};

export type OpenCodeWorkTransport={
  session(id:string,signal?:AbortSignal):Promise<unknown>;
  message(sessionId:string,messageId:string):Promise<unknown>;
  cancel?(sessionId:string,signal:AbortSignal):Promise<unknown>;
};

/** Internal ownership component. Public controls stay disabled until native closure/callback acceptance passes. */
export class OpenCodeOwnedWork {
  readonly #roots=new Map<string,string>();
  readonly #activeRoots=new Set<string>();
  readonly #children=new Map<string,Child>();
  readonly #pending=new Map<string,unknown[]>();
  readonly #continuations=new Map<string,HarnessNativeWorkObservation>();
  readonly #abortedContinuations=new Set<string>();
  #queue:Promise<void>=Promise.resolve();
  #lost=false;
  readonly #acceptedContinuationCancels=new Set<string>();
  readonly #continuationTerminals=new Map<string,"completed"|"failed">();
  #stopping=false;
  readonly #childPolicyWaiters = new Map<string, Set<() => void>>();
  constructor(readonly root:string,readonly start:HarnessAdapterStartInput,readonly transport:OpenCodeWorkTransport) {
    if(!start.emitSessionEvent)throw new HarnessAdapterError("native_session_owner_required","Native task ownership requires a session observer.");
  }
  admitRoot(promptId:string,turnId:string):void {
    if(this.#lost||this.#stopping)throw new HarnessAdapterError("native_owner_unavailable","The native task owner is unavailable.");
    id.parse(promptId);id.parse(turnId);
    if(this.#roots.has(promptId)||this.#roots.size>=1024)throw new HarnessAdapterError("native_work_origin_limit","Native prompt admission is duplicated or exceeds its limit.");
    this.#roots.set(promptId,turnId);
    this.#activeRoots.add(promptId);
  }
  closeRoot(promptId:string):void {
    if(!this.#roots.has(promptId))throw new HarnessAdapterError("native_root_origin_unconfirmed","The native root was never admitted.");
    this.#activeRoots.delete(promptId);
  }
  observe(event:unknown):void {this.#queue=this.#queue.then(()=>this.#observe(event)).catch(()=>this.lose());}
  async settled():Promise<void> {
    await this.#queue;
    if(this.#lost)throw new HarnessAdapterError("native_owner_unavailable","The native task observation owner was lost.");
  }
  /** Wait only for verified native launch custody; this does not admit a model prompt or restore an owner. */
  async awaitChildPolicyOwner(sessionId: string, signal: AbortSignal): Promise<{
    native_reference: string; parent_native_reference: string; work_id: string; origin_turn_id: string; prompt_id?: string;
  }> {
    await this.settled();signal.throwIfAborted();
    if (this.#lost || this.#stopping) throw new HarnessAdapterError("native_owner_unavailable", "The native child policy owner is unavailable.");
    if (!this.#children.has(sessionId)) await new Promise<void>((resolve, reject) => {
      if ([...this.#childPolicyWaiters.values()].reduce((count, set) => count + set.size, 0) >= 128) {
        reject(new HarnessAdapterError("native_work_limit", "Native child policy waits exceed their bounded registry."));return;
      }
      const finish = () => {
        this.#childPolicyWaiters.get(sessionId)?.delete(check);
        if (!this.#childPolicyWaiters.get(sessionId)?.size) this.#childPolicyWaiters.delete(sessionId);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {finish();reject(signal.reason ?? new Error("Native policy wait aborted."));};
      const check = () => {
        if (this.#lost || this.#stopping) {finish();reject(new HarnessAdapterError("native_owner_unavailable", "The native child policy owner was lost."));}
        else if (this.#children.has(sessionId)) {finish();resolve();}
      };
      const waiters = this.#childPolicyWaiters.get(sessionId) ?? new Set<() => void>();waiters.add(check);this.#childPolicyWaiters.set(sessionId, waiters);
      signal.addEventListener("abort", abort, {once: true});if (signal.aborted) abort();else check();
    });
    signal.throwIfAborted();
    const child = this.#children.get(sessionId);
    if (this.#lost || this.#stopping || !child || isNativeWorkTerminal(child.work.status))
      throw new HarnessAdapterError("native_owner_unavailable", "The native child policy has no live verified launch owner.");
    const native = z.object({id, parentID: id, directory: z.string()}).parse(await this.transport.session(sessionId, signal));
    signal.throwIfAborted();
    if (native.id !== sessionId || native.parentID !== child.parent || await realpath(native.directory) !== await realpath(this.start.payload.cwd)
      || this.#lost || this.#stopping || this.#children.get(sessionId) !== child || isNativeWorkTerminal(child.work.status))
      throw new HarnessAdapterError("native_work_policy_binding", "Native child policy ancestry, workspace or launch ownership changed.");
    return {native_reference: sessionId, parent_native_reference: child.parent, work_id: child.work.work_id, origin_turn_id: child.work.origin_turn_id,
      ...(child.prompt ? {prompt_id: child.prompt} : {})};
  }
  #notifyChildPolicyWaiters(): void {for (const waiters of [...this.#childPolicyWaiters.values()]) for (const check of [...waiters]) check();}

  async verifyHistoryOwner(work:HarnessNativeWorkRecord,signal:AbortSignal):Promise<string> {
    await this.settled();signal.throwIfAborted();
    const child=this.#children.get(work.native_reference);
    if(this.#lost||this.#stopping||!child||child.work.work_id!==work.work_id||child.work.origin_turn_id!==work.origin_turn_id
      ||child.work.parent_work_id!==work.parent_work_id)
      throw new HarnessAdapterError("native_work_history_binding","This native child history has no matching execution owner.");
    const native=z.object({id,parentID:id,directory:z.string()}).parse(await this.transport.session(work.native_reference,signal));
    if(native.id!==work.native_reference||native.parentID!==child.parent||await realpath(native.directory)!==await realpath(this.start.payload.cwd))
      throw new HarnessAdapterError("native_work_history_binding","Native child history ancestry or workspace changed.");
    signal.throwIfAborted();
    if(this.#lost||this.#stopping)throw new HarnessAdapterError("native_work_history_unavailable","The native child history owner was lost.");
    return native.id;
  }
  async cancel(work:HarnessNativeWorkRecord,signal:AbortSignal,beforeDispatch?:()=>void):Promise<void> {
    await this.settled();signal.throwIfAborted();
    const child=this.#children.get(work.native_reference);
    if(!child||child.work.work_id!==work.work_id||!child.prompt||!child.work.background||!this.transport.cancel||isNativeWorkTerminal(child.work.status))
      throw new HarnessAdapterError("native_work_owner_unavailable","The native background cancellation owner is unavailable.");
    const native=z.object({id,parentID:id,directory:z.string()}).parse(await this.transport.session(work.native_reference));
    if(native.id!==work.native_reference||native.parentID!==child.parent||await realpath(native.directory)!==await realpath(this.start.payload.cwd))
      throw new HarnessAdapterError("native_work_binding_unconfirmed","Cancellation requires the confirmed native parent and workspace.");
    signal.throwIfAborted();
    beforeDispatch?.();
    let response:unknown;
    try{response=await this.transport.cancel(work.native_reference,signal);}catch(failure){this.lose();throw failure;}
    if(response!==true){this.lose();throw new HarnessAdapterError("native_work_cancel_unknown","The native task cancellation was not acknowledged.");}
    child.cancelAccepted=true;
    child.work.supports_cancel=false;this.#publish(child);
    await this.settled();
    this.#cancelTerminal(child);
  }
  #cancelTerminal(child:Child):void {
    if(child.cancelAccepted&&child.aborted&&!isNativeWorkTerminal(child.work.status)) {
      child.work.status="cancelled";child.work.supports_cancel=false;this.#publish(child);
    }
  }
  async cancelFamily(signal:AbortSignal):Promise<void> {
    await this.settled();signal.throwIfAborted();
    if(!this.transport.cancel)throw new HarnessAdapterError("native_work_closure_unknown","The native family has no cancellation transport.");
    const children=[...this.#children.values()].filter(child=>!isNativeWorkTerminal(child.work.status));
    const continuations=[...this.#continuations].filter(([,work])=>!isNativeWorkTerminal(work.status));
    const roots=[...this.#activeRoots];
    let response:unknown;
    try{response=await this.transport.cancel(this.root,signal);}catch(failure){this.lose();throw failure;}
    if(response!==true){this.lose();throw new HarnessAdapterError("native_work_cancel_unknown","The native family cancellation has no acknowledgement.");}
    for(const [prompt]of continuations)this.#acceptedContinuationCancels.add(prompt);
    for(const prompt of roots)this.#activeRoots.delete(prompt);
    await this.settled();
    for(const child of children){child.cancelAccepted=true;this.#cancelTerminal(child);}
    for(const [prompt,work]of continuations)if(this.#abortedContinuations.has(prompt)&&!isNativeWorkTerminal(work.status)) {
      work.status="cancelled";this.start.emitSessionEvent!({event_type:"native.work.updated",data:{work:structuredClone(work)}});
    }
  }
  async stop():Promise<void> {
    await this.#queue;
    if(this.#lost&&!this.busy&&!this.#activeRoots.size){this.#stopping=true;return;}
    await this.settled();
    if(this.#pending.size)throw new HarnessAdapterError("native_work_closure_unknown","Unconfirmed native task membership prevents unload.");
    this.#stopping=true;this.#notifyChildPolicyWaiters();
    try {
      await this.cancelFamily(AbortSignal.timeout(10000));
      const end=Date.now()+10000;
      while(this.busy&&Date.now()<end){await this.settled();await new Promise(resolve=>setTimeout(resolve,20));}
      await this.settled();
      if(this.busy)throw new HarnessAdapterError("native_work_closure_unknown","Native tasks or parent continuations have no terminal shutdown proof.");
    } catch(error){this.#stopping=false;throw error;}
  }
  lose(uncertainNativeExecution = false):void {
    if(this.#lost)return;this.#lost=true;this.#notifyChildPolicyWaiters();
    try{this.start.emitSessionEvent!({event_type:"native.work.owner_lost",data:{reason:"runtime_error",
      ...(uncertainNativeExecution || this.busy||this.#activeRoots.size?{closure_unconfirmed:true}:{})}});}catch{/* A lost observer cannot regain ownership. */}
  }
  get busy():boolean {return this.#childPolicyWaiters.size > 0 || this.#pending.size>0||[...this.#children.values()].some(child=>!isNativeWorkTerminal(child.work.status))
    ||[...this.#continuations.values()].some(work=>!isNativeWorkTerminal(work.status));}
  get rootBusy():boolean {return [...this.#continuations.values()].some(work=>!isNativeWorkTerminal(work.status));}
  rootOrigin(promptId:string):string|undefined {
    return !this.#lost&&!this.#stopping&&this.#activeRoots.has(promptId)?this.#roots.get(promptId):undefined;
  }
  childOrigin(sessionId:string):{origin_turn_id:string;work_id:string;prompt_id?:string}|undefined {
    const child=this.#children.get(sessionId);
    return !this.#lost&&child&&!isNativeWorkTerminal(child.work.status)?{origin_turn_id:child.work.origin_turn_id,work_id:child.work.work_id,
      ...(child.prompt?{prompt_id:child.prompt}:{})}:undefined;
  }
  continuationOrigin(promptId:string):{origin_turn_id:string;work_id:string;prompt_id:string}|undefined {
    const work=this.#continuations.get(promptId);
    return !this.#lost&&work&&!isNativeWorkTerminal(work.status)?{origin_turn_id:work.origin_turn_id,work_id:work.work_id,prompt_id:promptId}:undefined;
  }
  #publish(child:Child):void {this.start.emitSessionEvent!({event_type:"native.work.updated",data:{work:structuredClone(child.work)},
    ...(child.custody?{nativeWorkCustody:child.custody}:{})});this.#notifyChildPolicyWaiters();}
  #buffer(session:string,event:unknown):void {
    const values=this.#pending.get(session)??[];
    if(this.#pending.size>=128&&!this.#pending.has(session)||values.length>=256||
      Buffer.byteLength(JSON.stringify([...values,event]))>1024*1024)throw new Error("Unconfirmed native task observation limit");
    values.push(event);this.#pending.set(session,values);
  }
  async #observe(value:unknown):Promise<void> {
    if(this.#lost)return;
    const event=eventSchema.parse(value);
    if(event.type==="message.part.updated") {
      const text=z.object({sessionID:id,messageID:id,type:z.literal("text"),synthetic:z.literal(true),text:z.string().max(4*1024*1024)}).safeParse(event.properties.part);
      if(text.success&&text.data.sessionID===this.root) {
        const result=/^<task id="([^"\r\n]+)" state="(completed|error)">\n/.exec(text.data.text);
        const child=result?this.#children.get(result[1]!):undefined;
        if(child) {
          const native=z.object({info:z.object({id,sessionID:id,role:z.literal("user")}),parts:z.array(z.record(z.string(),z.unknown())).max(1024)}).parse(
            await this.transport.message(this.root,text.data.messageID));
          if(native.info.id!==text.data.messageID||native.info.sessionID!==this.root||!native.parts.some(part=>part.type==="text"&&part.synthetic===true&&part.text===text.data.text))
            throw new Error("Native background completion has no synthetic user-message proof");
          const status=result![2]==="error"?"failed":"completed";
          if(isNativeWorkTerminal(child.work.status)&&child.work.status!==status)throw new Error("Native background terminal conflict");
          child.work.status=status;child.work.supports_cancel=false;this.#publish(child);
          if(!this.#continuations.has(native.info.id)) {
            if(this.#continuations.size+this.#children.size>=128)throw new Error("Native work registry limit");
            const work:HarnessNativeWorkObservation={work_id:`opencode-continuation-${randomUUID()}`,native_reference:`${this.root}:${native.info.id}`,
              origin_turn_id:child.work.origin_turn_id,parent_work_id:child.work.work_id,kind:"task",background:true,status:"running",supports_cancel:false,
              summary:"Native parent continuation after background result"};
            this.#continuations.set(native.info.id,work);
            this.start.emitSessionEvent!({event_type:"native.work.updated",data:{work:structuredClone(work)}});
          }
        }
        return;
      }
      const part=partSchema.safeParse(event.properties.part);
      if(part.success&&part.data.state.metadata) {
        const p=part.data,m=p.state.metadata!;
        const parent=this.#children.get(p.sessionID);
        const assistant=z.object({info:z.object({id,sessionID:id,role:z.literal("assistant"),parentID:id})}).parse(await this.transport.message(p.sessionID,p.messageID)).info;
        if(assistant.id!==p.messageID||assistant.sessionID!==p.sessionID)throw new Error("Native task assistant identity conflict");
        const continuation=p.sessionID===this.root?this.#continuations.get(assistant.parentID):undefined;
        const origin=p.sessionID===this.root?this.#roots.get(assistant.parentID)??continuation?.origin_turn_id:parent?.prompt===assistant.parentID?parent.work.origin_turn_id:undefined;
        if(!origin||m.parentSessionId!==p.sessionID||m.sessionId===this.root||m.background&&m.jobId!==undefined&&m.jobId!==m.sessionId)throw new Error("Native task launch has no admitted origin");
        if(m.background&&!m.jobId)return; // Initial tool metadata precedes confirmed background admission.
        const session=z.object({id,parentID:id,directory:z.string().min(1).max(4096)}).parse(await this.transport.session(m.sessionId));
        if(session.id!==m.sessionId||session.parentID!==p.sessionID||await realpath(session.directory)!==await realpath(this.start.payload.cwd))throw new Error("Native task parent/workspace mismatch");
        const launch=`${p.sessionID}\0${p.callID}`,prior=this.#children.get(m.sessionId);
        if(prior&&prior.launch!==launch)throw new Error("Native task reuse requires a new admitted continuation");
        if(!prior) {
          if(this.#children.size+this.#continuations.size>=128)throw new Error("Native work registry limit");
          const child:Child={parent:p.sessionID,launch,work:{work_id:`opencode-task-${randomUUID()}`,native_reference:m.sessionId,
            origin_turn_id:origin,...(parent||continuation?{parent_work_id:parent?.work.work_id??continuation!.work_id}:{}),kind:"agent",background:m.background===true,
            status:"running",supports_cancel:false,...(p.state.title?{summary:p.state.title}:{})}};
          // Parent continuation jobs share the root transcript and have no independent child custody.
          if(!continuation)child.custody={source:"opencode",work_id:child.work.work_id,native_reference:m.sessionId,origin_turn_id:origin,
            ...(parent?{parent_work_id:parent.work.work_id}:{}),root_native_reference:this.root,
            parent_native_reference:p.sessionID,launch_native_reference:p.callID};
          this.#children.set(m.sessionId,child);this.#publish(child);
          const pending=this.#pending.get(m.sessionId)??[];this.#pending.delete(m.sessionId);
          for(const held of pending)await this.#observe(held);
        }
        const child=this.#children.get(m.sessionId)!;
        if(!child.work.background&&(p.state.status==="completed"||p.state.status==="error")) {
          const status=p.state.status==="error"?"failed":"completed";
          if(isNativeWorkTerminal(child.work.status)&&child.work.status!==status)throw new Error("Native foreground terminal conflict");
          child.work.status=status;child.work.supports_cancel=false;this.#publish(child);
        }
        return;
      }
    }
    if(event.type!=="message.updated"&&event.type!=="session.idle")return;
    const info=event.type==="message.updated"?z.object({id,sessionID:id,role:z.enum(["user","assistant"])}).passthrough().parse(event.properties.info):undefined;
    const session=info?.sessionID??id.parse(event.properties.sessionID);
    if(info?.role==="assistant"&&session===this.root) {
      const continuation=this.#continuations.get(id.parse(info.parentID));
      if(continuation) {
        const aborted=z.object({error:z.object({name:z.literal("MessageAbortedError")}),time:z.object({completed:z.number()})}).safeParse(info);
        if(aborted.success) {
          this.#abortedContinuations.add(id.parse(info.parentID));
          if(this.#acceptedContinuationCancels.has(id.parse(info.parentID))) {continuation.status="cancelled";this.start.emitSessionEvent!({event_type:"native.work.updated",data:{work:structuredClone(continuation)}});}
          return;
        }
        const terminal=z.object({time:z.object({completed:z.number()}),finish:z.string().min(1),error:z.unknown().optional()}).safeParse(info);
        if(terminal.success&&!["tool-calls","unknown"].includes(terminal.data.finish)) {
          this.#continuationTerminals.set(id.parse(info.parentID),terminal.data.error?"failed":"completed");
        }
        return;
      }
    }
    const child=this.#children.get(session);
    if(event.type==="session.idle"&&session===this.root) {
      for(const [prompt,status]of this.#continuationTerminals) {
        const work=this.#continuations.get(prompt)!;
        if(!isNativeWorkTerminal(work.status)){work.status=status;this.start.emitSessionEvent!({event_type:"native.work.updated",data:{work:structuredClone(work)}});}
      }
      this.#continuationTerminals.clear();return;
    }
    if(!child) {if(session!==this.root)this.#buffer(session,value);return;}
    if(isNativeWorkTerminal(child.work.status))return;
    if(info?.role==="user") {
      if(child.prompt&&child.prompt!==info.id)throw new Error("Native child received an unadmitted prompt");
      child.prompt=info.id;
      if(child.custody)child.custody.native_execution_reference=info.id;
      this.#publish(child);return;
    }
    if(info?.role==="assistant") {
      const parentID=id.parse(info.parentID);
      if(!child.prompt||parentID!==child.prompt)throw new Error("Native child assistant has another prompt origin");
      const aborted=z.object({error:z.object({name:z.literal("MessageAbortedError")}),time:z.object({completed:z.number()})}).safeParse(info);
      if(aborted.success) {child.aborted=true;this.#cancelTerminal(child);return;}
      if(child.work.background&&this.transport.cancel&&!child.work.supports_cancel)child.work.supports_cancel=true;
      child.work.summary="Native child response observed";this.#publish(child);
    }
    // Native idle and assistant text alone cannot prove the background job has closed.
  }
}
