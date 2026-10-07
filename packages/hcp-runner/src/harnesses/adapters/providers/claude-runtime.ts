import {nativeTurnImages} from "./native-images.js";
import {portableItemObservation} from "../../portable-history.js";
import {nativePlanObservation} from "./native-plan.js";
import {claudeRootUsage} from "./claude-root-usage.js";
import {ClaudeTextParts, claudeCompletedTextParts} from "./claude-text-parts.js";
import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HarnessAdapterError } from "../types.js";
import { adapterMcpServers, assertCliMcpAttachmentProxied, nativeInstructions } from "./shared.js";
import { selectedEffort, type NativeTurn } from "./native-turn.js";
import { NativeProcess } from "./native-process.js";
import { randomUUID } from "node:crypto";
import {realpath} from "node:fs/promises";
import { NativeInteractions } from "../../native-interactions.js";
import {claudePermissions} from "./claude-permissions.js";
import {claudeElicitation} from "./claude-elicitation.js";
import {hasInheritedClaudePlugins} from "./claude-inventory.js";
import {claudeContextCapacity} from "./claude-context.js";
import { ClaudeInput } from "./claude-input.js";
import {retainedContent, retainedFinalText, textChunks} from "./content-projection.js";
import {measuredContext, unavailableContext} from "./native-context.js";

export const claudeResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.literal("success"),
  is_error: z.literal(false),
  result: z.string(),
  api_error_status: z.number().nullable().optional(),
  terminal_reason: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  modelUsage: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadInputTokens: z.number().int().nonnegative(),
        cacheCreationInputTokens: z.number().int().nonnegative(),
        contextWindow: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

export type ClaudeQueryFactory = (input: Parameters<typeof query>[0]) => Query;

export function createClaudeTurn(
  queryFactory: ClaudeQueryFactory = query,
): NativeTurn {
  return async (input, signal, emit) => {
    const resume = input.session.native_fresh ? undefined : input.session.native_thread_id;
    const nativeId = resume ?? (input.session.native_fresh ? input.session.native_thread_id! : randomUUID());
    // Reserve the requested identity privately; only native initialization proves readiness.
    input.session.native_thread_id = nativeId;
    const channel = new ClaudeInput();
    const admissions = new Map<string, string>();
    const userMessage = (text: string): SDKUserMessage => {
      const uuid = randomUUID();
      const admission = input.beginNativeExecution?.(nativeId);
      if (admission) admissions.set(uuid, admission);
      return {type: "user", uuid, session_id: nativeId, parent_tool_use_id: null, message: {role: "user", content: text}};
    };
    const message = userMessage(input.payload.action === "compact" ? "/compact" : input.payload.input);
    const images = nativeTurnImages(input);
    if (images.length) message.message.content = [{type: "text", text: input.payload.input},
      ...images.map(image => ({type: "image" as const, source: {type: "base64" as const,
        media_type: image.mime_type, data: image.data_base64}}))];
    channel.offer(message);
    const interactions = new NativeInteractions(input.startPayload, input.payload, {threadId: nativeId, turnId: () => input.payload.turn_id}, emit);
    let initialized = false;
    const selection =
      input.payload.model_selection ?? input.startPayload.model_selection;
    let context = unavailableContext(selection, input.payload.action === "compact" ? "compaction_started" : "new_native_request");
    let nativeModel: string | undefined;
    emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
    const effort = selectedEffort(selection, "claude") as Options["effort"];
    if (selection.options?.some(option => ["thinking", "ultracode", "fastMode"].includes(option.id)))
      throw new HarnessAdapterError("native_option_transition_unsupported", "Claude session options require the interactive native settings owner.");
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    for (const attachment of adapterMcpServers(
      input.mcpServers,
      input.startPayload,
    )) {
      assertCliMcpAttachmentProxied(attachment, "Claude Code", "claude");
      mcpServers[attachment.name] = { type: "http", url: attachment.url };
    }
    let processHandle: NativeProcess | undefined;
    const abort = (): void => {
      if (processHandle) void processHandle.stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    let stream: Query | undefined;
    const textParts = new ClaudeTextParts();
    const permissionMode = input.payload.mode === "plan" ? "plan" : ({ask: "default", auto_edits: "acceptEdits", full_access: "bypassPermissions"} as const)[input.startPayload.approval_policy];
    try {
      signal.throwIfAborted();
      stream = queryFactory({
        prompt: channel,
        options: {
          pathToClaudeCodeExecutable:
            input.provider.executable_path ?? "claude",
          cwd: input.startPayload.cwd,
          model: selection.model,
          ...(effort ? { effort } : {}),
          env: {
            ...globalThis.process.env,
            ...input.provider.env,
            ...(input.provider.home
              ? { CLAUDE_CONFIG_DIR: input.provider.home }
              : {}),
          },
          systemPrompt: typeof input.startPayload.instructions === "string"
            ? {type: "preset", preset: "claude_code", append: input.startPayload.instructions}
            : nativeInstructions(input.startPayload).system ?? { type: "preset", preset: "claude_code" },
          settingSources: [],
          settings: {disableAllHooks: true},
          persistSession: true,
          ...(resume ? {resume} : {sessionId: nativeId}),
          includePartialMessages: true,
          strictMcpConfig: true,
          mcpServers,
          permissionMode,
          allowDangerouslySkipPermissions: input.startPayload.approval_policy === "full_access",
          canUseTool: claudePermissions(() => initialized ? {threadId: nativeId, turnId: input.payload.turn_id, interactions, signal} : undefined),
          onElicitation: claudeElicitation(() => initialized ? {threadId: nativeId, turnId: input.payload.turn_id, interactions, signal, serverNames: Object.keys(mcpServers)} : undefined),
          disallowedTools: [
            ...(input.startPayload.approval_policy === "full_access" ? ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"] : []),
            "Agent",
            "Task",
          ],
          spawnClaudeCodeProcess: (options) => {
            processHandle = new NativeProcess(
              options.command,
              options.args,
              input.startPayload.cwd,
              options.env,
            );
            processHandle.child.stderr.resume();
            if (signal.aborted) abort();
            return processHandle.child;
          },
        },
      });
      let result: z.infer<typeof claudeResultSchema> | undefined;
      let compacted = false;
      let streamed = false;
      for await (const message of stream) {
        if ("session_id" in message && message.session_id !== nativeId)
          throw new HarnessAdapterError("native_continuation_binding", "Claude returned another native conversation identity.");
        const lifecycle = z.object({type: z.literal("command_lifecycle"), command_uuid: z.string(), state: z.enum(["queued", "started"])}).safeParse(message);
        if (lifecycle.success) {
          const admission = admissions.get(lifecycle.data.command_uuid);
          if (!admission && input.beginNativeExecution)
            throw new HarnessAdapterError("native_execution_binding", "Claude admitted an unowned native command.");
          if (admission && lifecycle.data.state === "started") input.confirmNativeExecution?.(admission, lifecycle.data.command_uuid);
          continue;
        }
        const echoed = z.object({user_message_uuid: z.string().optional(), user_message_uuids: z.array(z.string()).max(64).optional()}).parse(message);
        for (const id of [...(echoed.user_message_uuids ?? []), ...(echoed.user_message_uuid ? [echoed.user_message_uuid] : [])]) {
          const admission = admissions.get(id);
          if (admission) input.confirmNativeExecution?.(admission, id);
        }
        if (message.type === "system" && message.subtype === "init") {
          const confirmed = z.object({cwd: z.string(), permissionMode: z.string(),
            mcp_servers: z.array(z.object({name: z.string(), status: z.string()})), plugins: z.array(z.unknown())}).parse(message);
          if (await realpath(confirmed.cwd) !== await realpath(input.startPayload.cwd) || confirmed.permissionMode !== permissionMode)
            throw new HarnessAdapterError("policy_mismatch", "Claude did not confirm the requested workspace and permission mode.");
          const expectedServers = Object.keys(mcpServers);
          if (hasInheritedClaudePlugins(confirmed.plugins) || confirmed.mcp_servers.length !== expectedServers.length ||
              new Set(confirmed.mcp_servers.map(server => server.name)).size !== expectedServers.length ||
              confirmed.mcp_servers.some(server => !expectedServers.includes(server.name) || server.status !== "connected"))
            throw new HarnessAdapterError("mcp_scope_mismatch", "Claude exposed an unexpected plugin or did not confirm the selected MCP inventory.");
          initialized = true;
          input.session.native_thread_id = nativeId;
          delete input.session.native_fresh;
          input.persistNativeThread?.(nativeId);
          input.registerNativeInteractions?.(interactions);
          input.registerActiveTurnControls?.({async steer(text) {signal.throwIfAborted(); channel.offer(userMessage(text));}});
          if (input.persistNativeThread) emit({event_type: "session.configured", data: {native_conversation_ready: true, native_reference: nativeId}});
        }
        if (message.type === "system" && message.subtype === "compact_boundary") {
          compacted = true;
          const tokens = message.compact_metadata.post_tokens;
          context = tokens !== undefined ? measuredContext(selection, "claude.sdk.compact_boundary.post_tokens", tokens, undefined, "retained_conversation")
            : unavailableContext(selection, "native_compaction_has_no_measurement");
          emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
        }
        if (message.type === "stream_event" && message.parent_tool_use_id == null) {
          const part = textParts.observe(message.event);
          if (part) {
            if (part.state && part.native_part) emit({event_type: part.state === "started" ? "item.started" : "item.completed",
              turn_id: input.payload.turn_id, data: {item_type: part.kind === "thinking" ? "reasoning" : "text",
                native_part: part.native_part, status: part.state === "started" ? "running" : "completed"}});
            if (part.delta) {
              if (part.kind === "text") streamed = true;
              const {kind, delta, state: _state, ...location} = part;
              for (const chunk of textChunks(delta)) emit({event_type: kind === "text" ? "content.delta" : "reasoning.delta",
                turn_id: input.payload.turn_id, data: {delta: chunk, stream_kind: kind, ...location}});
            }
          }
        } else if (message.type === "assistant") {
          if (!message.parent_tool_use_id) for (const data of claudeCompletedTextParts(message.message, input.publishContent))
            emit({event_type: "item.completed", turn_id: input.payload.turn_id, data});
          // Nested agents have their own context; do not project them onto the root conversation.
          if (!message.parent_tool_use_id && message.message.model !== "<synthetic>") {
            nativeModel = message.message.model;
            const counters = z.object({input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
              cache_read_input_tokens: z.number().int().nonnegative().nullish(), cache_creation_input_tokens: z.number().int().nonnegative().nullish()}).safeParse(message.message.usage);
            context = counters.success ? measuredContext(selection, "claude.sdk.assistant.usage", counters.data.input_tokens + counters.data.output_tokens
              + (counters.data.cache_read_input_tokens ?? 0) + (counters.data.cache_creation_input_tokens ?? 0))
              : unavailableContext(selection, "native_request_has_no_measurement");
            emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
          }
          for (const block of message.message.content) {
            if (block.type === "tool_use" && !message.parent_tool_use_id && block.name === "TodoWrite") {
              const native_plan = nativePlanObservation("todo_list", (block.input as {todos?: unknown})?.todos,
                {observation: "tool_input", native_reference: nativeId, native_item_reference: block.id}, input.publishContent);
              if (native_plan) emit({event_type: "turn.plan.updated", turn_id: input.payload.turn_id,
                data: {item_id: block.id, plan: retainedContent((block.input as {todos?: unknown}).todos, input.publishContent), native_plan}});
            }
            if (block.type === "tool_use")
              emit({
                event_type: "item.started",
                turn_id: input.payload.turn_id,
                data: {
                  item_id: block.id,
                  item_type: "tool_call",
                  summary: block.name,
                  portable: portableItemObservation({id: block.id, type: "tool_call", tool_name: block.name, arguments: block.input, status: "running"}, "claude",
                    {native_reference: nativeId!, native_item_reference: block.id, native_call_reference: block.id}, input.publishContent),
                  content: retainedContent({arguments: block.input}, input.publishContent),
                },
              });
          }
        } else if (
          message.type === "user" &&
          Array.isArray(message.message.content)
        ) {
          for (const block of message.message.content) {
            if (block.type === "tool_result")
              emit({
                event_type: "item.completed",
                turn_id: input.payload.turn_id,
                data: {
                  item_id: block.tool_use_id,
                  item_type: "tool_call",
                  status: block.is_error ? "failed" : "completed",
                  portable: portableItemObservation({id: block.tool_use_id, type: "tool_result", content: block.content ?? [], status: block.is_error ? "failed" : "completed"}, "claude",
                    {native_reference: nativeId!, native_item_reference: block.tool_use_id, native_call_reference: block.tool_use_id}, input.publishContent),
                  content: retainedContent(block.content ?? [], input.publishContent),
                },
              });
          }
        } else if (message.type === "result") {
          if (!initialized) throw new HarnessAdapterError("native_continuation_binding", "Claude ended without confirming its native conversation identity.");
          const parsed = claudeResultSchema.safeParse(message);
          if (!parsed.success || result !== undefined)
            throw new HarnessAdapterError(
              "claude_result_error",
              "Claude returned an unsuccessful or malformed terminal result.",
            );
          result = parsed.data;
          if (
            (result.api_error_status != null &&
              result.api_error_status >= 400) ||
            (result.terminal_reason !== undefined &&
              result.terminal_reason !== "completed") ||
            (result.stop_reason != null &&
              !["end_turn", "stop_sequence"].includes(result.stop_reason))
          ) {
            throw new HarnessAdapterError(
              "claude_result_error",
              "Claude ended with a provider error or execution limit.",
            );
          }
          emit({event_type: "usage.updated", turn_id: input.payload.turn_id, data: {...claudeRootUsage(nativeId, message, true)}});
          channel.close();
          input.registerActiveTurnControls?.(undefined);
          break;
        }
      }
      if (!result)
        throw new HarnessAdapterError(
          "claude_missing_result",
          "Claude closed without a terminal result.",
        );
      if (input.payload.action === "compact" && !compacted)
        throw new HarnessAdapterError("native_compaction_unknown", "Claude did not confirm a native compaction boundary.");
      if (!streamed && result.result)
        for (const delta of textChunks(result.result)) emit({
          event_type: "content.delta",
          turn_id: input.payload.turn_id,
          data: { delta },
        });
      let inputTokens = 0;
      context = claudeContextCapacity(context, nativeModel, result.modelUsage);
      emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...context}});
      let outputTokens = 0;
      let cachedInputTokens = 0;
      let cacheCreationInputTokens = 0;
      for (const usage of Object.values(result.modelUsage ?? {})) {
        inputTokens +=
          usage.inputTokens +
          usage.cacheReadInputTokens +
          usage.cacheCreationInputTokens;
        outputTokens += usage.outputTokens;
        cachedInputTokens += usage.cacheReadInputTokens;
        cacheCreationInputTokens += usage.cacheCreationInputTokens;
      }
      return {
        ...retainedFinalText(result.result, input.publishContent),
        context,
        usage: {
          scope: "turn", status: result.modelUsage ? "complete" : "partial", source: "claude.sdk.result.modelUsage",
          ...(result.modelUsage
            ? {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                cached_input_tokens: cachedInputTokens,
                cache_creation_input_tokens: cacheCreationInputTokens,
              }
            : {}),
          ...(result.total_cost_usd !== undefined
            ? { cost_usd: result.total_cost_usd }
            : {}),
        },
      };
    } finally {
      channel.close();
      interactions.close();
      input.registerNativeInteractions?.(undefined);
      input.registerActiveTurnControls?.(undefined);
      signal.removeEventListener("abort", abort);
      stream?.close();
      if (processHandle) await processHandle.stop();
    }
  };
}
