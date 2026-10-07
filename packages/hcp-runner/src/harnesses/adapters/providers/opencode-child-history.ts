import {realpath} from "node:fs/promises";
import {z} from "zod";
import type {NativeWorkCustody} from "../../../state/index.js";
import {HarnessAdapterError} from "../types.js";

interface Transport {
  metadata(id: string): Promise<unknown>;
  messages(id: string): Promise<unknown>;
  fork(id: string, beforeMessageId?: string): Promise<string>;
  configureFork(id: string): Promise<void>;
  verifyPermissions(permission: unknown): void;
  isClosed(): boolean;
}

/** Inspection admits only a durable child and successfully configured independent forks. */
export async function openCodeChildHistoryView(custody: NativeWorkCustody, cwd: string,
  signal: AbortSignal, transport: Transport) {
  const admitted = new Set([custody.native_reference]);
  const check = () => {
    signal.throwIfAborted();
    if (transport.isClosed()) throw new HarnessAdapterError("native_work_history_unavailable", "The inspection transport closed.");
  };
  const metadata = async (id: string) => {
    check();
    const native = z.object({id: z.string(), parentID: z.string().optional(), directory: z.string(), permission: z.array(z.json())})
      .parse(await transport.metadata(id));
    check();
    if (native.id !== id || await realpath(native.directory) !== await realpath(cwd))
      throw new HarnessAdapterError("native_work_history_binding", "Retained native child or parent left its admitted workspace.");
    return native;
  };
  const verify = async () => {
    const child = await metadata(custody.native_reference);
    if (child.parentID !== custody.parent_native_reference)
      throw new HarnessAdapterError("native_work_history_binding", "Retained native child ancestry changed.");
    for (const parent of new Set([custody.parent_native_reference, custody.root_native_reference])) await metadata(parent);
  };
  await verify();
  return {verify, readHistory: async (id: string) => {
    check();
    if (!admitted.has(id)) throw new HarnessAdapterError("native_work_history_binding", "The inspection view cannot read arbitrary native sessions.");
    if (id === custody.native_reference) await verify(); else transport.verifyPermissions((await metadata(id)).permission);
    const result = await transport.messages(id);
    check();
    return result;
  }, forkHistory: async (beforeMessageId?: string) => {
    await verify();
    const id = await transport.fork(custody.native_reference, beforeMessageId);
    check();
    if (id === custody.native_reference || id === custody.root_native_reference || id === custody.parent_native_reference)
      throw new HarnessAdapterError("native_fork_unknown", "The native child fork is not independent.");
    await transport.configureFork(id);
    check();
    transport.verifyPermissions((await metadata(id)).permission);
    await verify();
    admitted.add(id);
    return id;
  }};
}
