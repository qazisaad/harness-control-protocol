import type {HarnessAdapterConversationInput} from "../types.js";
import {HarnessAdapterError} from "../types.js";
import type {OpenCodeRuntime} from "./opencode.js";
import {openCodeConversation} from "./opencode-conversation.js";
import {controlledOpenCodeReference, readControlledOpenCodeReference} from "./opencode-controlled.js";

/** Keep native history mechanics in their native account while runner bindings remain opaque. */
export async function controlledOpenCodeConversation(input: HarnessAdapterConversationInput, runtime: OpenCodeRuntime) {
  const source = readControlledOpenCodeReference(input.conversation.native_thread_id);
  if (!source || !runtime.ownedAccount || source.provider_id !== runtime.ownedAccount.providerId || source.account_binding !== runtime.ownedAccount.binding)
    throw new HarnessAdapterError("native_continuation_binding", "The retained conversation has another controlled account owner.");
  const wrap = (session_id: string) => controlledOpenCodeReference({...source, session_id});
  const unwrap = (reference: string) => {
    const selected = readControlledOpenCodeReference(reference);
    if (!selected || selected.provider_id !== source.provider_id || selected.account_binding !== source.account_binding)
      throw new HarnessAdapterError("native_continuation_binding", "The replacement conversation belongs to another native account owner.");
    return selected.session_id;
  };
  const rollback = input.conversation.rollback;
  const result = await openCodeConversation({...input,
    conversation: {...input.conversation, native_thread_id: source.session_id,
      ...(rollback?.replacement_native_thread_id ? {rollback: {...rollback, replacement_native_thread_id: unwrap(rollback.replacement_native_thread_id)}} : {})},
    save: value => input.save({...value, native_thread_id: input.conversation.native_thread_id,
      ...(value.rollback?.replacement_native_thread_id ? {rollback: {...value.rollback, replacement_native_thread_id: wrap(value.rollback.replacement_native_thread_id)}} : {})}),
  }, runtime);
  return {...result, ...(result.native_reference ? {native_reference: wrap(result.native_reference)} : {}),
    ...(result.fork ? {fork: {...result.fork, native_reference: wrap(result.fork.native_reference)}} : {})};
}
