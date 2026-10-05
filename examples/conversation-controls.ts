import {randomUUID, createHash} from "node:crypto";
import type {HarnessAdapter, HarnessAdapterConversationInput, HarnessAdapterTurnInput, HarnessAdapterStartInput,
  HarnessAdapterEvent} from "@harness-control/runner/harnesses";
import {HarnessAdapterError} from "@harness-control/runner/harnesses";
import type {HcpConversationResultPayload, HarnessInstructions} from "@harness-control/protocol";

type Turn = {id: string; status: string; items: Array<Record<string, string>>};
const revision = (turns: Turn[]) => createHash("sha256").update(JSON.stringify(turns)).digest("hex");
/** A deterministic provider for public-package conformance; no native CLI or consumer-specific IDs. */
export class ControlHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "example.controls";
  readonly portableHistory = true;
  readonly sessionEvents = true;
  readonly nativeWork = true;
  nativeCancellations = 0;
  readonly observations = new Map<string, NonNullable<HarnessAdapterStartInput["emitSessionEvent"]>>();
  readonly instructionRoles = ["system"] as const;
  instructionsSeen: HarnessInstructions | undefined;
  readonly configurationInheritance = {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false};
  readonly conversationOperations = ["read", "rollback", "fork"] as const;
  readonly histories = new Map<string, Turn[]>();
  mutations = 0;
  async probe(provider: Parameters<HarnessAdapter["probe"]>[0]) {
    return {provider_instance_id: provider.id, driver_kind: this.driverKind, installed: true, available: true,
      status: "ready" as const, models: [{id: "fixture", label: "Fixture", capabilities: {option_descriptors: []}}],
      execution_capabilities: {streaming: true, multi_turn: true, session_continuation: true, native_history: true,
        instruction_roles: [...this.instructionRoles],
        session_events: true,
        native_work: true,
        context_usage: true,
        portable_history: true,
        history_pagination: true, conversation_fork: true, conversation_rollback: true, active_steering: true,
        manual_compaction: true, content_retrieval: true, configuration_inheritance: this.configurationInheritance,
        approval_policies: ["full_access" as const], sandbox_modes: ["read_only" as const]}};
  }
  async validateStart({payload}: HarnessAdapterStartInput) {
    if (payload.sandbox_mode !== "read_only" || payload.approval_policy !== "full_access" || payload.model_selection.model !== "fixture")
      throw new HarnessAdapterError("unsupported_configuration", "Use the advertised fixture profile.");
  }
  async startSession(input: HarnessAdapterStartInput) {
    this.instructionsSeen = input.payload.instructions;
    this.observations.set(input.payload.session_id, input.emitSessionEvent!);
    this.emitObservation(input.payload.session_id, "startup");
    const nativeId = input.nativeConversation?.native_thread_id ?? randomUUID();
    if (!input.nativeConversation) this.histories.set(nativeId, []);
    if (!this.histories.has(nativeId)) throw new HarnessAdapterError("history_unavailable", "Fixture history is unavailable.");
    return {adapter_session_id: nativeId, native_thread_id: nativeId};
  }
  emitObservation(sessionId: string, phase: string) {
    this.observations.get(sessionId)!({event_type: "extension.example.observation", data: {summary: "Native observation", fields: {phase}}});
  }
  emitWork(sessionId: string, originTurnId: string, status: "running" | "cancelled") {
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
    if (input.payload.action === "compact") text = "compacted";
    turns.push({id: input.payload.turn_id, status: "completed", items: [{id: input.payload.turn_id, type: "text", text}]});
    const full = text.repeat(30_000);
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
    if (!["read", "fork", "rollback"].includes(operation.kind))
      throw new HarnessAdapterError("unsupported_operation", "Fixture supports read, fork and rollback.");
    if ((operation.kind === "fork" || operation.kind === "rollback") && operation.expected_history_hash !== revision(turns))
      throw new HarnessAdapterError("history_changed", "Read current history before mutation.");
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
    return {command_id: commandId, session_id: request.session_id, operation: operation.kind, filesystem_undo: false,
      history: {history_hash: revision(current), turn_count: current.length, truncated: false, turns: current.map(turn => ({...turn,
        portable_fidelity: "full", portable_items: turn.items.map(item => ({id: item.id!, status: "completed", type: "message", role: "assistant",
          body: {storage: "inline", value: item.text!}}))}))}};
  }
  async cancelTurn(): Promise<HarnessAdapterEvent[]> {return [];}
  async stopSession(input: Parameters<HarnessAdapter["stopSession"]>[0]): Promise<HarnessAdapterEvent[]> {this.observations.delete(input.sessionId); return [];}
}
