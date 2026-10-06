import {realpath} from "node:fs/promises";
import {z} from "zod";
import {HarnessAdapterError} from "../types.js";
import type {CodexRpc,RpcMessage} from "./codex-rpc.js";

// Native 0.160.0 advertises effort values as non-empty strings, not a frozen enum.
const effortSchema=z.string().min(1).max(128);
const notification=z.object({threadId:z.string().min(1).max(512),threadSettings:z.object({
  model:z.string().min(1).max(512),effort:effortSchema.nullable(),cwd:z.string().min(1).max(4096),
  approvalPolicy:z.string(),approvalsReviewer:z.string(),
  collaborationMode:z.object({mode:z.enum(["default","plan"]),settings:z.object({model:z.string(),reasoning_effort:effortSchema.nullable()})}),
  sandboxPolicy:z.object({type:z.string(),writableRoots:z.array(z.string()).optional(),excludeTmpdirEnvVar:z.boolean().optional(),excludeSlashTmp:z.boolean().optional()})})});
type Expected={threadId:string;model:string;effort?:string;mode:"default"|"plan";cwd:string;approvalPolicy:string;
  sandbox:{type:string;writableRoots?:string[]|undefined;excludeTmpdirEnvVar?:boolean|undefined;excludeSlashTmp?:boolean|undefined}};
export type CodexSettingsReadback=z.infer<typeof notification>;
export function readCodexSettingsNotification(message:RpcMessage):CodexSettingsReadback|undefined {
  if(message.method!=="thread/settings/updated")return undefined;
  const parsed=notification.safeParse(message.params);return parsed.success?parsed.data:undefined;
}

/** One owned transport mutation at a time. The empty RPC ACK is never effective-settings evidence. */
export async function updateCodexRootSettings(rpc:Pick<CodexRpc,"request"|"observeNotifications">,expected:Expected,signal:AbortSignal,
  /** Maintained by continuous observation on this same exclusive transport, never reconstructed from requested settings. */
  previous?:CodexSettingsReadback) {
  signal.throwIfAborted();
  const requestedEffort=expected.effort===undefined?null:effortSchema.parse(expected.effort);
  const cached=previous?.threadId===expected.threadId&&previous.threadSettings.model===expected.model&&
    previous.threadSettings.effort===requestedEffort&&previous.threadSettings.collaborationMode.mode===expected.mode&&
    previous.threadSettings.collaborationMode.settings.model===expected.model&&previous.threadSettings.collaborationMode.settings.reasoning_effort===requestedEffort
    ?previous:undefined;
  let latest:CodexSettingsReadback|undefined;
  const waiters=new Set<{mode:Expected["mode"];resolve:(value:CodexSettingsReadback)=>void;reject:(error:unknown)=>void}>();
  const observe=(mode:Expected["mode"]):Promise<CodexSettingsReadback>=>{
    const result=new Promise<CodexSettingsReadback>((resolve,reject)=>{
      if(latest?.threadSettings.collaborationMode.mode===mode)resolve(latest);
      else waiters.add({mode,resolve,reject});
    });void result.catch(()=>undefined);return result;
  };
  const unsubscribe=rpc.observeNotifications(message=>{
    if(message.method!=="thread/settings/updated")return;
    const candidate=z.object({threadId:z.string()}).safeParse(message.params);
    if(!candidate.success||candidate.data.threadId!==expected.threadId)return;
    const parsed=notification.safeParse(message.params);
    if(!parsed.success) {
      for(const waiter of waiters)waiter.reject(new HarnessAdapterError("native_settings_unconfirmed","Codex returned invalid effective settings."));
      return;
    }
    latest=parsed.data;
    for(const waiter of [...waiters])if(waiter.mode===parsed.data.threadSettings.collaborationMode.mode){waiters.delete(waiter);waiter.resolve(parsed.data);}
  });
  let failDeadline!:(error:unknown)=>void;
  const deadline=new Promise<never>((_,no)=>{failDeadline=no;});void deadline.catch(()=>undefined);
  const timeout=setTimeout(()=>failDeadline(new HarnessAdapterError("native_settings_unconfirmed","Codex did not confirm effective settings.")),10000);
  const abort=()=>failDeadline(signal.reason);
  signal.addEventListener("abort",abort,{once:true});
  if(signal.aborted)abort();
  try {
    signal.throwIfAborted();
    let settings:CodexSettingsReadback["threadSettings"];
    if(cached)settings=cached.threadSettings;
    else {
      const mutate=(mode:Expected["mode"])=>rpc.request("thread/settings/update",{threadId:expected.threadId,model:expected.model,effort:requestedEffort,
        collaborationMode:{mode,settings:{model:expected.model,reasoning_effort:requestedEffort,developer_instructions:null}}});
      const observed=observe(expected.mode);
      await Promise.race([mutate(expected.mode),deadline]);
      // Native 0.160.0 omits notifications for a no-op. Without retained evidence,
      // establish a real root-only mode transition, then restore and confirm the requested snapshot.
      // No model turn is admitted until restoration is observed. Never change authority or child settings.
      let grace:ReturnType<typeof setTimeout>|undefined;
      const initial=await Promise.race([observed,new Promise<undefined>(yes=>{grace=setTimeout(()=>yes(undefined),250);}),deadline]);
      if(grace)clearTimeout(grace);
      if(initial)settings=initial.threadSettings;
      else {
        const opposite=expected.mode==="default"?"plan":"default";
        latest=undefined;
        const transitioned=observe(opposite);
        await Promise.race([Promise.all([mutate(opposite),transitioned]),deadline]);
        latest=undefined;
        const restored=observe(expected.mode);
        await Promise.race([Promise.all([mutate(expected.mode),restored]),deadline]);
        settings=(await restored).threadSettings;
      }
    }
    if(settings.model!==expected.model||settings.effort!==requestedEffort||settings.collaborationMode.mode!==expected.mode||
      settings.collaborationMode.settings.model!==expected.model||settings.collaborationMode.settings.reasoning_effort!==requestedEffort||
      settings.approvalPolicy!==expected.approvalPolicy||settings.approvalsReviewer!=="user"||
      await realpath(settings.cwd)!==await realpath(expected.cwd)||settings.sandboxPolicy.type!==expected.sandbox.type)
      throw new HarnessAdapterError("native_settings_mismatch","Codex did not preserve the authorized effective model, options and policy.");
    if(expected.sandbox.type==="workspaceWrite") {
      const actualRoots=await Promise.all((settings.sandboxPolicy.writableRoots??[]).map(path=>realpath(path)));
      const roots=await Promise.all((expected.sandbox.writableRoots??[]).map(path=>realpath(path)));
      if(settings.sandboxPolicy.writableRoots===undefined||JSON.stringify(actualRoots.sort())!==JSON.stringify(roots.sort())||
        settings.sandboxPolicy.excludeTmpdirEnvVar!==true||settings.sandboxPolicy.excludeSlashTmp!==true)
        throw new HarnessAdapterError("native_settings_mismatch","Codex changed the authorized writable roots or temporary-directory policy.");
    }
    signal.throwIfAborted();return settings;
  } finally {clearTimeout(timeout);signal.removeEventListener("abort",abort);unsubscribe();}
}
