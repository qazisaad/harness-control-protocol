import {z} from "zod";
import type {CanUseTool} from "@anthropic-ai/claude-agent-sdk";
import type {NativeInteractions} from "../../native-interactions.js";

type Owner = {threadId: string; turnId: string; interactions: NativeInteractions; signal: AbortSignal; allowSessionPermissions?: boolean};
/** Native request identity is resolved by the runtime; application MCP decisions remain separate. */
export function claudePermissions(resolve: (options: Parameters<CanUseTool>[2]) => Owner | undefined): CanUseTool {
  return async (tool, arguments_, options) => {
    const owner = resolve(options);
    if (!owner) return {behavior: "deny", message: "The native request has no confirmed execution owner.", interrupt: false};
    const binding = {threadId: owner.threadId, turnId: owner.turnId, itemId: options.toolUseID};
    const signal = AbortSignal.any([owner.signal, options.signal]);
    if (tool === "AskUserQuestion") {
      const parsed = z.object({questions: z.array(z.object({question: z.string(), header: z.string(),
        options: z.array(z.object({label: z.string(), description: z.string()})), multiSelect: z.boolean().optional()})).min(1).max(16)}).parse(arguments_);
      const reply = z.object({answers: z.record(z.string(), z.object({answers: z.array(z.string())}))}).parse(await owner.interactions.questions({...binding,
        questions: parsed.questions.map((question, index) => ({...question, id: `question-${index}`, isOther: true}))}, signal));
      if (!Object.keys(reply.answers).length) return {behavior: "deny", message: "The user cancelled the native question.", interrupt: true};
      return {behavior: "allow", updatedInput: {...arguments_, answers: Object.fromEntries(parsed.questions.map((question, index) =>
        [question.question, reply.answers[`question-${index}`]?.answers.join(", ") ?? ""]))}};
    }
    const requestType = tool === "Bash" ? "command" : tool === "Read" ? "file_read" : ["Write", "Edit", "NotebookEdit"].includes(tool) ? "file_change" : "other";
    // Session-local allow rules only: never persist user/project settings or change the permission mode.
    const sessionPermissions = owner.allowSessionPermissions ? structuredClone((options.suggestions ?? []).filter(update =>
      update.type === "addRules" && update.destination === "session" && update.behavior === "allow" && update.rules.length > 0 && update.rules.every(rule => rule.toolName === tool))) : [];
    const answer = await owner.interactions.approval({...binding, tool, arguments: z.record(z.string(), z.json()).parse(arguments_),
      ...(sessionPermissions.length ? {session_permission_updates: z.array(z.json()).max(32).parse(sessionPermissions)} : {}),
      availableDecisions: ["accept", "decline", "cancel", ...(sessionPermissions.length ? ["accept_for_session"] : [])]}, requestType, signal);
    return answer.decision === "accept_for_session" ? {behavior: "allow", updatedInput: arguments_, updatedPermissions: sessionPermissions}
      : answer.decision === "accept" ? {behavior: "allow", updatedInput: arguments_}
      : {behavior: "deny", message: "The user declined the native action.", interrupt: answer.decision === "cancel"};
  };
}
