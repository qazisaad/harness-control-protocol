import {
  query,
  type Options,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HarnessAdapterError } from "../types.js";
import { adapterMcpServers, assertCliMcpAttachmentProxied } from "./shared.js";
import { selectedEffort, type NativeTurn } from "./native-turn.js";
import { NativeProcess } from "./native-process.js";

const resultSchema = z.object({
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
      }),
    )
    .optional(),
});

export type ClaudeQueryFactory = (input: Parameters<typeof query>[0]) => Query;

export function createClaudeTurn(
  queryFactory: ClaudeQueryFactory = query,
): NativeTurn {
  return async (input, signal, emit) => {
    const selection =
      input.payload.model_selection ?? input.startPayload.model_selection;
    const effort = selectedEffort(selection, "claude") as Options["effort"];
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
    try {
      signal.throwIfAborted();
      stream = queryFactory({
        prompt: input.payload.input,
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
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: [],
          persistSession: false,
          includePartialMessages: true,
          strictMcpConfig: true,
          mcpServers,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          disallowedTools: [
            "AskUserQuestion",
            "EnterPlanMode",
            "ExitPlanMode",
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
      let result: z.infer<typeof resultSchema> | undefined;
      let streamed = false;
      for await (const message of stream) {
        if (
          message.type === "stream_event" &&
          message.event.type === "content_block_delta"
        ) {
          const delta = message.event.delta;
          if (delta.type === "text_delta" || delta.type === "thinking_delta") {
            if (delta.type === "text_delta") streamed = true;
            emit({
              event_type:
                delta.type === "text_delta"
                  ? "content.delta"
                  : "reasoning.delta",
              turn_id: input.payload.turn_id,
              data: {
                delta:
                  delta.type === "text_delta" ? delta.text : delta.thinking,
              },
            });
          }
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "tool_use")
              emit({
                event_type: "item.started",
                turn_id: input.payload.turn_id,
                data: {
                  item_id: block.id,
                  item_type: "tool_call",
                  summary: block.name,
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
                },
              });
          }
        } else if (message.type === "result") {
          const parsed = resultSchema.safeParse(message);
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
        }
      }
      if (!result)
        throw new HarnessAdapterError(
          "claude_missing_result",
          "Claude closed without a terminal result.",
        );
      if (!streamed && result.result)
        emit({
          event_type: "content.delta",
          turn_id: input.payload.turn_id,
          data: { delta: result.result },
        });
      let inputTokens = 0;
      let outputTokens = 0;
      for (const usage of Object.values(result.modelUsage ?? {})) {
        inputTokens +=
          usage.inputTokens +
          usage.cacheReadInputTokens +
          usage.cacheCreationInputTokens;
        outputTokens += usage.outputTokens;
      }
      return {
        final_text: result.result,
        usage: {
          ...(result.modelUsage
            ? {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              }
            : {}),
          ...(result.total_cost_usd !== undefined
            ? { cost_usd: result.total_cost_usd }
            : {}),
        },
      };
    } finally {
      signal.removeEventListener("abort", abort);
      stream?.close();
      if (processHandle) await processHandle.stop();
    }
  };
}
