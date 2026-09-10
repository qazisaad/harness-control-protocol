import { z } from "zod";
import { realpath } from "node:fs/promises";
import type {
  HarnessTurnFinalOutput,
  HarnessUsageSnapshot,
} from "@harness-control/protocol";
import { HarnessAdapterError } from "../types.js";
import { adapterMcpServers, assertCliMcpAttachmentProxied } from "./shared.js";
import { selectedEffort, type NativeTurn } from "./native-turn.js";
import { CodexRpc } from "./codex-rpc.js";

const object = z.record(z.string(), z.unknown());
const idObject = z.object({ id: z.string() });
const startedSchema = z.object({
  thread: idObject,
  sandbox: z.object({
    type: z.string(),
    writableRoots: z.array(z.string()).optional(),
    excludeTmpdirEnvVar: z.boolean().optional(),
    excludeSlashTmp: z.boolean().optional(),
  }),
  approvalPolicy: z.string(),
});
const deltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  delta: z.string(),
});
const itemSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
    phase: z.string().nullable().optional(),
  }),
});
const terminalSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.unknown().nullable().optional(),
  }),
});

export const runCodexTurn: NativeTurn = async (input, signal, emit) => {
  signal.throwIfAborted();
  const selection =
    input.payload.model_selection ?? input.startPayload.model_selection;
  const effort = selectedEffort(selection, "codex");
  const rpc = new CodexRpc(
    input.provider.executable_path ?? "codex",
    input.startPayload.cwd,
    {
      ...process.env,
      ...input.provider.env,
      ...(input.provider.home ? { CODEX_HOME: input.provider.home } : {}),
    },
  );
  const abort = (): void => {
    void rpc.process.stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "hcp-runner", version: "0.0.0" },
      capabilities: {},
    });
    rpc.notify("initialized");
    const configResult = z.object({ config: object }).parse(
      await rpc.request("config/read", {
        cwd: input.startPayload.cwd,
        includeLayers: false,
      }),
    );
    const inherited = object.parse(configResult.config.mcp_servers ?? {});
    const servers: Record<string, unknown> = {};
    for (const name of Object.keys(inherited))
      servers[name] = { enabled: false };
    for (const attachment of adapterMcpServers(
      input.mcpServers,
      input.startPayload,
    )) {
      assertCliMcpAttachmentProxied(attachment, "Codex", "codex");
      if (Object.hasOwn(inherited, attachment.name)) {
        throw new HarnessAdapterError(
          "mcp_name_conflict",
          "An attachment conflicts with an inherited MCP server name.",
        );
      }
      servers[attachment.name] = { url: attachment.url, enabled: true };
    }
    const sandbox = input.startPayload.sandbox_mode.replaceAll("_", "-");
    const started = startedSchema.parse(
      await rpc.request("thread/start", {
        cwd: input.startPayload.cwd,
        model: selection.model,
        sandbox,
        approvalPolicy: "never",
        ephemeral: true,
        config: {
          mcp_servers: servers,
          "features.apps": false,
          "features.multi_agent": false,
          "sandbox_workspace_write.writable_roots": [],
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
      }),
    );
    const expectedSandbox = {
      read_only: "readOnly",
      workspace_write: "workspaceWrite",
      danger_full_access: "dangerFullAccess",
    }[input.startPayload.sandbox_mode];
    if (
      started.sandbox.type !== expectedSandbox ||
      started.approvalPolicy !== "never"
    ) {
      throw new HarnessAdapterError(
        "policy_mismatch",
        "Codex did not accept the requested execution policy.",
      );
    }
    if (started.sandbox.type === "workspaceWrite") {
      const cwd = await realpath(input.startPayload.cwd);
      const roots = await Promise.all(
        (started.sandbox.writableRoots ?? []).map((root) => realpath(root)),
      );
      if (
        started.sandbox.writableRoots === undefined ||
        roots.some((root) => root !== cwd) ||
        started.sandbox.excludeTmpdirEnvVar !== true ||
        started.sandbox.excludeSlashTmp !== true
      ) {
        throw new HarnessAdapterError(
          "policy_mismatch",
          "Codex granted writes beyond the requested workspace.",
        );
      }
    }
    const threadId = started.thread.id;
    const allowedServers = new Set(
      adapterMcpServers(input.mcpServers, input.startPayload).map(
        (attachment) => attachment.name,
      ),
    );
    let cursor: string | undefined;
    do {
      const inventory = z
        .object({
          data: z.array(
            z.object({
              name: z.string(),
              runtimeStatus: z.string().nullable().optional(),
              tools: object.optional(),
            }),
          ),
          nextCursor: z.string().nullable().optional(),
        })
        .parse(
          await rpc.request("mcpServerStatus/list", {
            threadId,
            ...(cursor ? { cursor } : {}),
          }),
        );
      if (
        inventory.data.some(
          (server) =>
            !allowedServers.has(server.name) &&
            !(
              Object.hasOwn(inherited, server.name) &&
              server.runtimeStatus === "disabled" &&
              Object.keys(server.tools ?? {}).length === 0
            ),
        )
      ) {
        throw new HarnessAdapterError(
          "mcp_scope_mismatch",
          "Codex exposed an MCP server outside the selected attachment scope.",
        );
      }
      cursor = inventory.nextCursor ?? undefined;
    } while (cursor);
    let nativeTurnId: string | undefined;
    let finalText: string | undefined;
    let usage: HarnessUsageSnapshot | undefined;
    let settled = false;
    let resolve!: (output: HarnessTurnFinalOutput) => void;
    let reject!: (error: Error) => void;
    const terminal = new Promise<HarnessTurnFinalOutput>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Attach immediately: the server can emit a terminal event before turn/start replies.
    void terminal.catch(() => {});
    rpc.onFailure = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    rpc.onNotification = (message) => {
      if (settled) return;
      if (message.method === "turn/started") {
        const event = z
          .object({ threadId: z.string(), turn: idObject })
          .parse(message.params);
        if (event.threadId === threadId) nativeTurnId = event.turn.id;
      } else if (
        message.method === "item/agentMessage/delta" ||
        message.method === "item/reasoning/summaryTextDelta"
      ) {
        const event = deltaSchema.parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turnId !== nativeTurnId)
        )
          return;
        emit({
          event_type:
            message.method === "item/agentMessage/delta"
              ? "content.delta"
              : "reasoning.delta",
          turn_id: input.payload.turn_id,
          data: { delta: event.delta },
        });
      } else if (
        message.method === "item/started" ||
        message.method === "item/completed"
      ) {
        const event = itemSchema.parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turnId !== nativeTurnId)
        )
          return;
        emit({
          event_type:
            message.method === "item/started"
              ? "item.started"
              : "item.completed",
          turn_id: input.payload.turn_id,
          data: {
            item_id: event.item.id,
            item_type: event.item.type,
            ...(event.item.text !== undefined
              ? { content: event.item.text }
              : {}),
          },
        });
        if (
          message.method === "item/completed" &&
          event.item.type === "agentMessage" &&
          event.item.phase !== "commentary"
        )
          finalText = event.item.text;
      } else if (message.method === "thread/tokenUsage/updated") {
        const event = z
          .object({
            threadId: z.string(),
            turnId: z.string(),
            tokenUsage: z.object({
              total: z.object({
                inputTokens: z.number().int().nonnegative(),
                outputTokens: z.number().int().nonnegative(),
                totalTokens: z.number().int().nonnegative(),
              }),
            }),
          })
          .parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turnId !== nativeTurnId)
        )
          return;
        usage = {
          input_tokens: event.tokenUsage.total.inputTokens,
          output_tokens: event.tokenUsage.total.outputTokens,
          total_tokens: event.tokenUsage.total.totalTokens,
        };
        emit({
          event_type: "usage.updated",
          turn_id: input.payload.turn_id,
          data: { ...usage },
        });
      } else if (message.method === "turn/completed") {
        const event = terminalSchema.parse(message.params);
        if (
          event.threadId !== threadId ||
          (nativeTurnId && event.turn.id !== nativeTurnId)
        )
          return;
        settled = true;
        if (
          event.turn.status !== "completed" ||
          event.turn.error != null ||
          finalText === undefined
        ) {
          reject(
            new HarnessAdapterError(
              "codex_turn_failed",
              "Codex ended without a successful final answer.",
            ),
          );
        } else resolve({ final_text: finalText, ...(usage ? { usage } : {}) });
      }
    };
    const turn = z.object({ turn: idObject }).parse(
      await rpc.request("turn/start", {
        threadId,
        model: selection.model,
        ...(effort ? { effort } : {}),
        input: [{ type: "text", text: input.payload.input, text_elements: [] }],
      }),
    );
    if (nativeTurnId !== undefined && nativeTurnId !== turn.turn.id)
      throw new HarnessAdapterError(
        "codex_turn_mismatch",
        "Codex returned conflicting turn identities.",
      );
    nativeTurnId = turn.turn.id;
    return await terminal;
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.process.stop();
  }
};
