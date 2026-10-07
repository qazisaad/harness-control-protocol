import {randomUUID, createHash} from "node:crypto";
import type {HarnessAdapter, HarnessAdapterConversationInput, HarnessAdapterTurnInput, HarnessAdapterStartInput,
  HarnessAdapterEvent} from "@harness-control/runner/harnesses";
import {HarnessAdapterError} from "@harness-control/runner/harnesses";
import type {HcpConversationResultPayload, HarnessInstructions, HarnessNativeRequestIdentity} from "@harness-control/protocol";

type Turn = {id: string; status: string; items: Array<Record<string, string>>};
const revision = (turns: Turn[]) => createHash("sha256").update(JSON.stringify(turns)).digest("hex");
/** A deterministic provider for public-package conformance; no native CLI or consumer-specific IDs. */
export class ControlHarnessAdapter implements HarnessAdapter {
  readonly fileContextInputs = true;
  readonly promptContextInputs = true;
  readonly driverKind = "example.controls";
  readonly portableHistory = true;
  readonly liveHistoryRead = true;
  readonly sessionEvents = true;
  readonly nativeWork = true;
  readonly executionProfiles = [{id: "interactive" as const, runtime_lifetime: "session" as const, native_work: true, session_events: true, native_work_history: "live_owner" as const,
    root_settings_readback: true, sandbox_options: ["network_access" as const],
    empty_conversation: true, idle_configuration_transition: true, idle_mcp_catalog_transition: true,
    native_feedback: {owner: "live_conversation" as const, classifications: ["bug"], diagnostics: true},
    account_limit_observations: "native_session" as const, native_async_output: "session" as const, native_retry_observations: "session" as const, mcp_detach: "idle_session" as const}];
  readonly mcpNames = new Map<string, Set<string>>();
  nativeMcpDetaches = 0;
  async detachNativeMcpServers(input: Parameters<NonNullable<HarnessAdapter["detachNativeMcpServers"]>>[0]) {
    const names = this.mcpNames.get(input.sessionId);
    if (!names || input.names.some(name => !names.has(name))) throw new HarnessAdapterError("native_mcp_detach_busy", "Fixture has no matching native MCP owner.");
    this.nativeMcpDetaches++;
    for (const name of input.names) names.delete(name);
    return {source: "native" as const, detached: [...input.names], remaining: [...names]};
  }
  readonly requests = new Map<string, {id: string; turnId?: string; nativeRequest: HarnessNativeRequestIdentity}>();
  readonly nativeReferences = new Map<string, string>();
  inputsReceived = 0;
  nativeCancellations = 0;
  feedbackSubmissions = 0;
  async submitNativeFeedback(input: Parameters<NonNullable<HarnessAdapter["submitNativeFeedback"]>>[0]) {
    if (!this.observations.has(input.sessionId)) throw new HarnessAdapterError("owner_lost", "Fixture owner is closed.");
    this.feedbackSubmissions++;
    return {feedback_id: "fixture-feedback-receipt"};
  }
  readonly observations = new Map<string, NonNullable<HarnessAdapterStartInput["emitSessionEvent"]>>();
  readonly workStatus = new Map<string, string>();
  readonly instructionRoles = ["system"] as const;
  instructionsSeen: HarnessInstructions | undefined;
  readonly configurationInheritance = {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false};
  readonly conversationOperations = ["read", "rollback", "fork", "inject"] as const;
  injectionsSeen: Array<{role: "user" | "assistant"; content: string}> = [];
  injectionDispatches = 0;
  readonly histories = new Map<string, Turn[]>();
  mutations = 0;
  async probe(provider: Parameters<HarnessAdapter["probe"]>[0]) {
    return {provider_instance_id: provider.id, driver_kind: this.driverKind, installed: true, available: true,
      status: "ready" as const, models: [{id: "fixture", label: "Fixture", capabilities: {option_descriptors: []}}],
      execution_capabilities: {streaming: true, multi_turn: true, session_continuation: true, native_history: true,
        live_history_read: true, native_history_injection: true,
        instruction_roles: [...this.instructionRoles],
        session_events: true,
        execution_profiles: this.executionProfiles,
        native_work: true,
        context_usage: true,
        portable_history: true,
        history_pagination: true, conversation_fork: true, conversation_rollback: true, active_steering: true,
        manual_compaction: true, content_retrieval: true, configuration_inheritance: this.configurationInheritance,
        approval_policies: ["full_access" as const, "ask" as const, "auto_edits" as const], sandbox_modes: ["read_only" as const]}};
  }
  async validateStart({payload}: HarnessAdapterStartInput) {
    if (typeof payload.instructions === "string")
      throw new HarnessAdapterError("instructions_unsupported", "Fixture requires explicit instruction roles.");
    if (payload.sandbox_mode !== "read_only" || payload.model_selection.model !== "fixture")
      throw new HarnessAdapterError("unsupported_configuration", "Use the advertised fixture profile.");
  }
  async startSession(input: HarnessAdapterStartInput) {
    if (typeof input.payload.instructions === "string")
      throw new HarnessAdapterError("instructions_unsupported", "Fixture requires explicit instruction roles.");
    this.mcpNames.set(input.payload.session_id, new Set(input.payload.mcp_servers.map(server => server.name)));
    this.instructionsSeen = input.payload.instructions;
    this.observations.set(input.payload.session_id, input.emitSessionEvent!);
    input.registerSessionInteractions!({
      owns: id => this.requests.get(input.payload.session_id)?.id === id,
      respondApproval: () => {throw new HarnessAdapterError("unexpected_approval", "Fixture expects input.");},
      respondInput: response => {
        const request = this.requests.get(input.payload.session_id);
        if (!request || response.request_id !== request.id || response.turn_id !== request.turnId || response.session_id !== input.payload.session_id
            || (response.request_scope ?? "turn") !== (request.turnId ? "turn" : "session"))
          throw new HarnessAdapterError("input_binding", "Wrong native input owner.");
        if (JSON.stringify(response.value) !== JSON.stringify({answer: "continue"})) throw new HarnessAdapterError("input_shape", "Expected fixture answer.");
        input.emitSessionEvent!({event_type: "user_input.resolved", ...(request.turnId ? {turn_id: request.turnId} : {}), data: {
          request_id: request.id, session_id: response.session_id, native_request: request.nativeRequest, ...(request.turnId ? {turn_id: request.turnId} : {request_scope: "session"}), actor_id: response.actor_id, cancelled: false, resolved_at: new Date().toISOString()}});
        this.inputsReceived++; this.requests.delete(input.payload.session_id);
      },
    });
    this.emitObservation(input.payload.session_id, "startup");
    const nativeId = input.nativeConversation?.native_thread_id ?? randomUUID();
    if (!input.nativeConversation) this.histories.set(nativeId, []);
    if (!this.histories.has(nativeId)) throw new HarnessAdapterError("history_unavailable", "Fixture history is unavailable.");
    this.nativeReferences.set(input.payload.session_id, nativeId);
    return {adapter_session_id: nativeId, native_thread_id: nativeId, native_policy_readback: {source: "native" as const,
      ...(input.payload.sandbox_options ? {sandbox_options: input.payload.sandbox_options} : {}),
      execution_profile: input.payload.execution_profile ?? "isolated", approval_policy: input.payload.approval_policy, sandbox_mode: input.payload.sandbox_mode},
      ...(input.payload.conversation_transition?.change === "mcp_catalog" ? {native_mcp_catalog_readback: {
        source: "native" as const, attachments: [...this.mcpNames.get(input.payload.session_id)!]}} : {})};
  }
  emitObservation(sessionId: string, phase: string) {
    this.observations.get(sessionId)!({event_type: "extension.example.observation", data: {summary: "Native observation", fields: {phase}}});
  }
  requestLateInput(sessionId: string, turnId?: string) {
    const id = randomUUID();
    const nativeRequest: HarnessNativeRequestIdentity = {source: "native", native_reference: this.nativeReferences.get(sessionId)!, request_reference: `fixture-request-${randomUUID()}`};
    this.requests.set(sessionId, {id, nativeRequest, ...(turnId ? {turnId} : {})});
    this.observations.get(sessionId)!({event_type: "user_input.requested", ...(turnId ? {turn_id: turnId} : {}), data: {
      request_id: id, session_id: sessionId, native_request: nativeRequest, ...(turnId ? {turn_id: turnId} : {request_scope: "session"}), prompt: "Continue background work?", input_kind: "form", required: true,
      form_schema: {type: "object", properties: {answer: {type: "string"}}, required: ["answer"], additionalProperties: false},
      expires_at: new Date(Date.now() + 60_000).toISOString(), redaction: "none"}});
    return id;
  }
  emitWork(sessionId: string, originTurnId: string, status: "running" | "cancelled") {
    this.workStatus.set(sessionId, status);
    this.observations.get(sessionId)!({event_type: "native.work.updated", data: {work: {
      work_id: "background-task", native_reference: "fixture-task", origin_turn_id: originTurnId,
      kind: "task", background: true, status, supports_cancel: true,
    }}});
  }
  loseWorkOwner(sessionId: string) {
    this.observations.get(sessionId)!({event_type: "native.work.owner_lost", data: {reason: "transport_lost"}});
  }
  async cancelNativeWork(input: Parameters<NonNullable<HarnessAdapter["cancelNativeWork"]>>[0]) {
    this.nativeCancellations++;
    this.emitWork(input.sessionId, input.work.origin_turn_id, "cancelled");
  }
  async readNativeWorkHistory(input: Parameters<NonNullable<HarnessAdapter["readNativeWorkHistory"]>>[0]) {
    input.signal.throwIfAborted();
    if (!this.observations.has(input.sessionId) || input.work.work_id !== "background-task")
      throw new HarnessAdapterError("native_work_history_binding", "No matching child transcript owner.");
    return {history_hash: "a".repeat(64), turn_count: 1, truncated: false, turns: [{id: "child-turn", status: "running",
      items: [{type: "text", text: "Owned child transcript"}]}]};
  }
  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    const nativeId = input.session.native_thread_id!;
    input.persistNativeThread?.(nativeId);
    let text = input.payload.input;
    if (text === "wait-for-steering") {
      text = await new Promise<string>(resolve => {
        input.registerActiveTurnControls?.({async steer(value) {resolve(value);}});
        input.emitEvent?.({event_type: "content.delta", turn_id: input.payload.turn_id, data: {delta: "ready"}});
      });
    }
    const turns = this.histories.get(nativeId)!;
    const admission = input.beginNativeExecution?.(nativeId);
    if (input.payload.action === "compact") text = "compacted";
    turns.push({id: input.payload.turn_id, status: "completed", items: [{id: input.payload.turn_id, type: "text", text}]});
    if (admission) input.confirmNativeExecution?.(admission, input.payload.turn_id);
    const full = input.payload.files?.length || input.payload.context ? text : text.repeat(30_000);
    const reference = input.publishContent!(full);
    const context = {status: "measured" as const, source: "example.native.context", observed_at: new Date().toISOString(),
      selection: input.payload.model_selection ?? input.startPayload.model_selection, measurement_scope: "last_request" as const,
      used_tokens: 160, capacity_tokens: 1000};
    input.emitEvent?.({event_type: "context.updated", turn_id: input.payload.turn_id, data: context});
    return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: text, content_ref: reference, context}}}];
  }
  async conversationOperation(input: HarnessAdapterConversationInput): Promise<HcpConversationResultPayload> {
    const {request, commandId, conversation} = input;
    const turns = this.histories.get(conversation.native_thread_id)!;
    const operation = request.operation;
    if (!["read", "fork", "rollback", "inject"].includes(operation.kind))
      throw new HarnessAdapterError("unsupported_operation", "Fixture supports read, fork, rollback and injection.");
    if ((operation.kind === "fork" || operation.kind === "rollback" || operation.kind === "inject") && operation.expected_history_hash !== revision(turns))
      throw new HarnessAdapterError("history_changed", "Read current history before mutation.");
    if (operation.kind === "inject") {
      input.beginMutation!(); this.injectionDispatches++;
      this.injectionsSeen.push(...structuredClone(operation.messages));
      return {command_id: commandId, session_id: request.session_id, operation: "inject", filesystem_undo: false,
        injection: {outcome: "applied", message_count: operation.messages.length}};
    }
    if (operation.kind === "fork") {
      const end = operation.last_turn_id ? turns.findIndex(turn => turn.id === operation.last_turn_id) + 1 : turns.length;
      if (!end && operation.last_turn_id) throw new HarnessAdapterError("history_boundary", "Unknown fork boundary.");
      input.beginMutation!(); this.mutations++;
      const nativeId = randomUUID(); this.histories.set(nativeId, structuredClone(turns.slice(0, end)));
      return {command_id: commandId, session_id: request.session_id, operation: "fork", filesystem_undo: false,
        fork: {session_id: operation.target_session_id, continuation_group_key: operation.continuation_group_key, native_reference: nativeId}};
    }
    if (operation.kind === "rollback") {
      const retained = turns.slice(0, -operation.num_turns);
      input.save({...conversation, rollback: {command_id: commandId, source_hash: revision(turns), target_hash: revision(retained), phase: "pending"}});
      this.histories.set(conversation.native_thread_id, retained); this.mutations++;
      input.save({...conversation, rollback: {command_id: commandId, source_hash: revision(turns), target_hash: revision(retained), phase: "completed"}});
    }
    const current = this.histories.get(conversation.native_thread_id)!;
    let offset = 0;
    if (operation.kind === "read" && operation.cursor) {
      const [sourceHash, value] = operation.cursor.split(":");
      offset = Number(value);
      if (sourceHash !== revision(current) || !Number.isSafeInteger(offset) || offset < 0 || offset > current.length)
        throw new HarnessAdapterError("history_changed", "The fixture cursor no longer identifies this native snapshot.");
    }
    const end = current.length - offset;
    const selected = operation.kind === "read" ? current.slice(Math.max(0, end - (operation.limit ?? 100)), end) : current;
    const consumed = offset + selected.length;
    return {command_id: commandId, session_id: request.session_id, operation: operation.kind, filesystem_undo: false,
      history: {history_hash: revision(current), turn_count: current.length, truncated: consumed < current.length,
        ...(consumed < current.length ? {next_cursor: `${revision(current)}:${consumed}`} : {}), turns: selected.map(turn => ({...turn,
        portable_fidelity: "full", portable_items: turn.items.map(item => ({id: item.id!, status: "completed", type: "message", role: "assistant",
          body: {storage: "inline", value: item.text!}}))}))}};
  }
  async cancelTurn(): Promise<HarnessAdapterEvent[]> {return [];}
  async stopSession(input: Parameters<HarnessAdapter["stopSession"]>[0]): Promise<HarnessAdapterEvent[]> {
    if (this.workStatus.get(input.sessionId) === "running") throw new HarnessAdapterError("native_work_shutdown_unknown", "Native work closure is unconfirmed.");
    this.observations.delete(input.sessionId); return [];
  }
}
