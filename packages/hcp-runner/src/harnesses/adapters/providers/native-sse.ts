import {HARNESS_CONTENT_MAX_BYTES} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

/** A native event stream is persistent: clean EOF still loses its observation owner. */
export async function consumeNativeSse(stream:ReadableStream<Uint8Array>, onData:(value:unknown)=>void,
  signal:AbortSignal, options: {maxFrameBytes?: number} = {}):Promise<void> {
  const maxFrameBytes = options.maxFrameBytes ?? HARNESS_CONTENT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > HARNESS_CONTENT_MAX_BYTES)
    throw new HarnessAdapterError("native_sse_frame_limit", "Invalid native event frame bound.");
  const reader=stream.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal.addEventListener("abort",abort,{once:true});
  if(signal.aborted)abort();
  let buffered="",data:string[]=[],bytes=0;
  const line=(value:string):void=>{
    if(value==="") {
      if(data.length) {
        let event:unknown;
        try{event=JSON.parse(data.join("\n"));}catch{throw new HarnessAdapterError("native_sse_invalid_json","The native event stream contained invalid JSON.");}
        data=[];bytes=0;onData(event);
      }
      return;
    }
    if(value.startsWith("data:")) {
      const field=value.slice(5).replace(/^ /,"");
      bytes+=Buffer.byteLength(field)+1;
      if(bytes>maxFrameBytes||data.length>=10000)throw new HarnessAdapterError("native_sse_frame_limit","The native event frame exceeded its bounded retention.");
      data.push(field);
    }
  };
  const lines=(eof:boolean):void=>{
    for(;;) {
      const end=buffered.search(/[\r\n]/);
      if(end<0)return;
      if(buffered[end]==="\r"&&end===buffered.length-1&&!eof)return;
      const count=buffered[end]==="\r"&&buffered[end+1]==="\n"?2:1;
      const value=buffered.slice(0,end);buffered=buffered.slice(end+count);line(value);
    }
  };
  try {
    for(;;) {
      signal.throwIfAborted();
      const chunk=await reader.read();
      try{buffered+=decoder.decode(chunk.value,{stream:!chunk.done});}
      catch{throw new HarnessAdapterError("native_sse_invalid_utf8","The native event stream contained invalid UTF-8.");}
      if(Buffer.byteLength(buffered)>maxFrameBytes)throw new HarnessAdapterError("native_sse_frame_limit","The native event frame exceeded its bounded retention.");
      lines(chunk.done);
      if(chunk.done) {
        if(signal.aborted)return;
        if(buffered||data.length)throw new HarnessAdapterError("native_sse_incomplete_frame","The native event stream ended inside a frame.");
        throw new HarnessAdapterError("native_event_stream_closed","The native observation stream closed unexpectedly.");
      }
    }
  } finally {
    signal.removeEventListener("abort",abort);
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
