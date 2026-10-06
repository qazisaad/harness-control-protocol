import {HarnessAdapterError} from "../types.js";
import {consumeNativeSse} from "./native-sse.js";

/** One observation connection per native owner; a turn only borrows a subscription. */
export class NativeEventOwner {
  readonly #abort = new AbortController();
  readonly #subscribers = new Set<{data:(value:unknown)=>void;fail:(error:Error)=>void}>();
  readonly ready:Promise<void>;
  readonly #completed:Promise<void>;
  #failure:Error|undefined;
  #closed=false;

  constructor(open:(signal:AbortSignal)=>Promise<ReadableStream<Uint8Array>>, onFailure:(error:Error)=>void) {
    let ready!:()=>void,failed!:(error:Error)=>void;
    this.ready=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
    void this.ready.catch(()=>{});
    this.#completed=(async()=>{
      try {
        const stream=await open(this.#abort.signal);
        this.#abort.signal.throwIfAborted();
        ready();
        await consumeNativeSse(stream,value=>{
          for(const subscriber of [...this.#subscribers])subscriber.data(value);
        },this.#abort.signal);
      } catch(value) {
        const error=value instanceof Error?value:new Error("Native observation failed.");
        if(this.#closed){failed(error);return;}
        this.#failure=error;failed(error);
        for(const subscriber of [...this.#subscribers])subscriber.fail(error);
        this.#subscribers.clear();
        onFailure(error);
      }
    })();
  }

  async consume(data:(value:unknown)=>void, signal:AbortSignal, admitted:()=>void):Promise<void> {
    await this.ready;
    signal.throwIfAborted();
    if(this.#failure)throw this.#failure;
    if(this.#closed)throw new HarnessAdapterError("native_session_unavailable","The native observation owner closed.");
    if(this.#subscribers.size>=128)throw new HarnessAdapterError("native_observer_limit","The native owner exceeded its observer limit.");
    let abort!:()=>void;
    const pending=new Promise<void>((resolve,reject)=>{
      const subscriber={data,fail:reject};
      abort=()=>{this.#subscribers.delete(subscriber);resolve();};
      this.#subscribers.add(subscriber);
      signal.addEventListener("abort",abort,{once:true});
      try{admitted();}catch(error){this.#subscribers.delete(subscriber);reject(error);}
    });
    try{await pending;}finally{signal.removeEventListener("abort",abort);abort();}
  }

  async close():Promise<void> {
    if(!this.#closed) {
      this.#closed=true;
      const error=new HarnessAdapterError("native_session_unavailable","The native observation owner closed.");
      for(const subscriber of [...this.#subscribers])subscriber.fail(error);
      this.#subscribers.clear();this.#abort.abort();
    }
    await this.#completed;
  }
}
