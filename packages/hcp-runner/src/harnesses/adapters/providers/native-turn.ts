import {HARNESS_OWNED_IMAGE_MAX_BYTES, HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES, HARNESS_OWNED_IMAGE_MAX_COUNT, HARNESS_OWNED_IMAGE_MIME_TYPES} from "@harness-control/protocol";
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
      {id: "interactive" as const, runtime_lifetime: "session" as const, native_work: true, session_events: true, mcp_attachments: true, native_owner_closure: "owned_session" as const, native_approval_review: true, native_approval_feedback: "rejection" as const, root_settings_readback: true, native_permission_prompting: "reject_unapproved" as const, root_interrupt_effect: "root_only" as const, native_tool_selection: {scope: "root_builtins" as const, tools: ["Read", "Glob", "Grep", "TodoWrite"]}, native_work_history: "live_owner" as const, retained_native_work_history: true, idle_configuration_transition: true, idle_mcp_catalog_transition: true,
        native_policy_control: "idle_native_owner" as const, account_limit_observations: "native_session" as const, native_async_output: "session" as const, native_retry_observations: "session" as const, native_plan_proposal_observations: ["tool_input"] as Array<"tool_input">, native_plan_observations: ["tool_input"] as Array<"tool_input">, native_goal_observations: "native_transcript" as const, native_execution_outcomes: true, mcp_detach: "idle_session" as const},
    ]} : {}),
    instruction_roles: driver === "codex" ? ["system", "developer"] : ["system"],
    configuration_inheritance: driver === "codex" ? {mcp_servers: false, plugins: false} :
      {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false},
    file_inputs: {delivery: ["file_context"], max_bytes: 50 * 1024 * 1024, max_files: 100},
    owned_image_inputs: {max_bytes: HARNESS_OWNED_IMAGE_MAX_BYTES, max_images: HARNESS_OWNED_IMAGE_MAX_COUNT,
      max_total_bytes: HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES, mime_types: [...HARNESS_OWNED_IMAGE_MIME_TYPES]},
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
  if (input.payload.tool_selection && (driver !== "claude" || input.payload.execution_profile !== "interactive"))
    throw new HarnessAdapterError("native_tool_selection_unsupported", "Native builtin selection requires the declared Claude interactive profile.");
  if (input.payload.approval_options) {
    const supported = "prompt_categories" in input.payload.approval_options
      ? driver === "codex" && input.payload.approval_policy === "auto_edits"
      : "permission_prompting" in input.payload.approval_options && driver === "claude" && input.payload.approval_policy === "ask" && (input.payload.approval_reviewer ?? "user") === "user";
    if (!supported || input.payload.execution_profile !== "interactive")
      throw new HarnessAdapterError("approval_options_unsupported", "Native approval options require their declared interactive driver and matching approval authority.");
  }
  if (input.payload.sandbox_options && (driver !== "codex" || input.payload.execution_profile !== "interactive" || input.payload.sandbox_mode !== "workspace_write"))
    throw new HarnessAdapterError("sandbox_options_unsupported", "Sandbox options require Codex interactive workspace-write enforcement and readback.");
  if (input.payload.approval_reviewer === "native_auto" && input.payload.execution_profile !== "interactive")
    throw new HarnessAdapterError("native_approval_review_unsupported", "Native automatic approval review requires the interactive profile.");
  if (driver === "claude" && input.payload.approval_reviewer === "native_auto" && input.payload.approval_policy !== "auto_edits")
    throw new HarnessAdapterError("native_approval_review_unsupported", "Claude native automatic mode requires auto_edits policy.");
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
  if (driver === "claude" && input.payload.execution_profile !== "interactive"
    && input.payload.model_selection.options?.some(option => ["thinking", "ultracode", "fastMode"].includes(option.id)))
    throw new HarnessAdapterError("native_option_transition_unsupported", "Claude session options require interactive native settings readback.");
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
  #closed = false;
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#active.keys()].map(id => this.stop(id)));
  }
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
    if (this.#closed) throw new HarnessAdapterError("runner_closed", "Native turn owner is closed.");
    if (input.payload.action === "compact" && !["codex", "claude", "opencode"].includes(this.driver))
      throw new HarnessAdapterError("compaction_unsupported", "This provider profile does not implement manual compaction.");
    if (input.payload.goal && (this.driver !== "codex" || input.startPayload.execution_profile !== "interactive" || !input.beginNativeGoal))
      throw new HarnessAdapterError("native_goal_unsupported", "Native goal dispatch requires a declared interactive job owner.");
    if (input.payload.action === "compact" && (input.payload.goal || input.payload.input !== "" || input.payload.images?.length || input.payload.image_files?.length || input.inputFileImages?.length || input.payload.mode === "plan"))
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
  const seen = new Set<string>();
  for (const option of selection.options ?? []) {
    if (seen.has(option.id)) throw new HarnessAdapterError("unsupported_model_option", "Duplicate model option.");
    seen.add(option.id);
    if (driver === "claude" && ["thinking", "ultracode", "fastMode"].includes(option.id)) {
      if (typeof option.value !== "boolean")
        throw new HarnessAdapterError("unsupported_model_option", "Claude session options require boolean values.");
      continue;
    }
    if (driver === "codex" && option.id === "reasoningSummary") {
      if (!["auto", "concise", "detailed", "none"].includes(String(option.value)) || typeof option.value !== "string")
        throw new HarnessAdapterError("unsupported_model_option", "Unsupported native reasoning summary selection.");
      continue;
    }
    if (driver === "codex" && option.id === "serviceTier") {
      if (typeof option.value !== "string" || option.value.length === 0 || option.value.length > 128)
        throw new HarnessAdapterError("unsupported_model_option", "Codex service tier must be a bounded native string.");
      continue;
    }
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
