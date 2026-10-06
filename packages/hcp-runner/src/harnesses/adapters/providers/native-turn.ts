import type {
  HarnessExecutionCapabilities,
  HarnessModelSelection,
  HarnessTurnFinalOutput,
} from "@harness-control/protocol";
import {
  HarnessAdapterError,
  type HarnessAdapterEvent,
  type HarnessAdapterStartInput,
  type HarnessAdapterTurnInput,
} from "../types.js";
import { turnFailedEvent, validateConfigurationInheritance, validateInstructionRoles } from "./shared.js";

export function nativeExecutionCapabilities(
  driver: "codex" | "claude",
): HarnessExecutionCapabilities {
  return {
    ...(driver === "claude" ? {execution_profiles: [
      {id: "isolated" as const, runtime_lifetime: "turn" as const, native_work: false, session_events: false},
      {id: "interactive" as const, runtime_lifetime: "session" as const, native_work: true, session_events: true, root_interrupt_effect: "root_only" as const, native_work_history: "live_owner" as const, idle_configuration_transition: true,
        account_limit_observations: "native_session" as const, native_async_output: "session" as const, native_retry_observations: "session" as const, mcp_detach: "idle_session" as const},
    ]} : {}),
    instruction_roles: driver === "codex" ? ["system", "developer"] : ["system"],
    configuration_inheritance: driver === "codex" ? {mcp_servers: false, plugins: false} :
      {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false},
    file_inputs: {delivery: ["file_context"], max_bytes: 32 * 1024 * 1024, max_files: 8},
    prompt_context: true,
    streaming: true,
    multi_turn: true,
    session_continuation: true,
    plan_mode: true,
    native_history: true,
    live_history_read: true,
    native_history_injection: driver === "codex",
    history_pagination: true,
    conversation_rollback: true,
    conversation_fork: true,
    active_steering: true,
    manual_compaction: true,
    content_retrieval: true,
    context_usage: true,
    portable_history: true,
    approval_policies: ["ask", "auto_edits", "full_access"],
    sandbox_modes:
      driver === "codex"
        ? ["read_only", "workspace_write", "danger_full_access"]
        : ["danger_full_access"],
  };
}

export function validateNativeStart(
  input: HarnessAdapterStartInput,
  driver: "codex" | "claude",
): void {
  const capabilities = nativeExecutionCapabilities(driver);
  validateConfigurationInheritance(input.payload, capabilities.configuration_inheritance);
  validateInstructionRoles(input.payload, capabilities.instruction_roles);
  if (input.payload.continue_session && !input.payload.continuation_group_key)
    throw new HarnessAdapterError("continuation_key_required", "Native continuation requires its durable conversation key.");
  if (input.payload.continue_session && !capabilities.session_continuation)
    throw new HarnessAdapterError(
      "continuation_unsupported",
      "Native continuation is not supported by this runner profile.",
    );
  if (!capabilities.approval_policies.includes(input.payload.approval_policy))
    throw new HarnessAdapterError(
      "approval_policy_unsupported",
      "Interactive approval policies are not supported by this runner profile.",
    );
  if (!capabilities.sandbox_modes.includes(input.payload.sandbox_mode))
    throw new HarnessAdapterError(
      "sandbox_unsupported",
      "The requested filesystem containment is not supported by this adapter.",
    );
  if (input.provider.launch_args.length)
    throw new HarnessAdapterError(
      "launch_args_unsupported",
      "Native drivers require structured configuration instead of launch arguments.",
    );
  selectedEffort(input.payload.model_selection, driver);
}

type RunningTurn = {
  id: string;
  controller: AbortController;
  done: Promise<void>;
};

export type NativeTurn = (
  input: HarnessAdapterTurnInput,
  signal: AbortSignal,
  emit: (event: HarnessAdapterEvent) => void,
) => Promise<HarnessTurnFinalOutput>;

/** Owns terminal decisions after the provider runtime has finished cleanup. */
export class NativeTurns {
  readonly #active = new Map<string, RunningTurn>();
  readonly #usedSessions = new Set<string>();

  constructor(
    readonly driver: string,
    readonly timeoutMs: number,
  ) {}

  async run(
    input: HarnessAdapterTurnInput,
    execute: NativeTurn,
  ): Promise<HarnessAdapterEvent[]> {
    const { session_id: sessionId, turn_id: turnId } = input.payload;
    if (input.payload.action === "compact" && !["codex", "claude", "opencode"].includes(this.driver))
      throw new HarnessAdapterError("compaction_unsupported", "This provider profile does not implement manual compaction.");
    if (input.payload.action === "compact" && (input.payload.input !== "" || input.payload.images?.length || input.payload.mode === "plan"))
      throw new HarnessAdapterError("compaction_input_invalid", "Compaction accepts no prompt, images or Plan mode.");
    if (this.#active.has(sessionId)) {
      throw new HarnessAdapterError(
        `${this.driver}_turn_in_progress`,
        "The session already has an active turn.",
      );
    }
    if (!["codex", "claude", "opencode"].includes(this.driver) && this.#usedSessions.has(sessionId)) {
      throw new HarnessAdapterError(
        "session_turn_limit",
        "This provider profile supports one turn per session; native multi-turn sessions are not implemented.",
      );
    }
    this.#usedSessions.add(sessionId);
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#active.set(sessionId, { id: turnId, controller, done });
    const timeout = setTimeout(
      () => controller.abort("timeout"),
      this.timeoutMs,
    );
    const events: HarnessAdapterEvent[] = [];
    const emit = (event: HarnessAdapterEvent): void => {
      if (controller.signal.aborted) return;
      if (input.emitEvent) input.emitEvent(event);
      else events.push(event);
    };
    try {
      const output = await execute(input, controller.signal, emit);
      if (!controller.signal.aborted) {
        events.push({
          event_type: "turn.completed",
          turn_id: turnId,
          data: { status: "completed", final_output: output },
        });
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        events.push(
          turnFailedEvent(
            turnId,
            "provider_error",
            error instanceof HarnessAdapterError
              ? error.code
              : `${this.driver}_runtime_failed`,
            error instanceof HarnessAdapterError
              ? error.message
              : "Provider runtime failed; inspect local diagnostics.",
            false,
          ),
        );
      }
    } finally {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        events.push(
          controller.signal.reason === "timeout"
            ? turnFailedEvent(
                turnId,
                "timeout",
                `${this.driver}_turn_timeout`,
                "Provider turn timed out.",
                false,
              )
            : {
                event_type: "turn.cancelled",
                turn_id: turnId,
                data: {
                  status: "cancelled",
                  final_output: { exit_reason: "cancel_requested" },
                },
              },
        );
      }
      try {
        if (input.emitEvent) {
          for (const event of events) input.emitEvent(event);
          events.length = 0;
        }
      } finally {
        this.#active.delete(sessionId);
        finish();
      }
    }
    return events;
  }

  async cancel(
    sessionId: string,
    turnId?: string,
  ): Promise<HarnessAdapterEvent[]> {
    const active = this.#active.get(sessionId);
    if (active && (turnId === undefined || active.id === turnId)) {
      active.controller.abort("cancel_requested");
      await active.done;
    }
    // The running turn owns the single terminal event, including cancellation.
    return [];
  }

  async stop(sessionId: string): Promise<HarnessAdapterEvent[]> {
    await this.cancel(sessionId);
    this.#usedSessions.delete(sessionId);
    return [];
  }
}

export function selectedEffort(
  selection: HarnessModelSelection,
  driver: "codex" | "claude",
): string | undefined {
  let effort: string | undefined;
  for (const option of selection.options ?? []) {
    const expected = driver === "codex" ? "reasoningEffort" : "effort";
    const values = ["low", "medium", "high", "xhigh", "max"];
    if (
      option.id !== expected ||
      typeof option.value !== "string" ||
      option.value.length === 0 ||
      (driver === "claude" && !values.includes(option.value)) ||
      effort !== undefined
    ) {
      throw new HarnessAdapterError(
        "unsupported_model_option",
        "Unsupported or duplicate model option.",
      );
    }
    effort = option.value;
  }
  return effort;
}
