import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { nativeReviewActionBytes } from "@harness-control/protocol";
import type { HcpApprovalResponsePayload, HcpInputResponsePayload, HcpSessionStartPayload, HcpTurnSendPayload } from "@harness-control/protocol";
import { HarnessAdapterError, type HarnessAdapterEvent } from "./adapters/types.js";

type Approval = {kind: "approval"; id: string; actionHash: string; expires: number; allowed: string[];
  settle: (decision: HcpApprovalResponsePayload["decision"]) => void; reject: (error: Error) => void};
type Question = {kind: "input"; id: string; expires: number; schema: z.ZodType;
  settle: (value: unknown) => void; reject: (error: Error) => void};

const bindingSchema = z.object({threadId: z.string().min(1), turnId: z.string().min(1), itemId: z.string().min(1)});
const questionSchema = bindingSchema.extend({questions: z.array(z.object({
  id: z.string().min(1), header: z.string(), question: z.string(), isOther: z.boolean().optional(), isSecret: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.object({label: z.string(), description: z.string()})).nullish(),
})).min(1).max(16)});

/** Owns native requests only; an MCP decision cannot resolve one of these requests. */
export class NativeInteractions {
  #pending: Approval | Question | undefined;
  #closed = false;
  #count = 0;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #resolved = new Map<string, string>();
  constructor(readonly start: HcpSessionStartPayload, readonly turn: HcpTurnSendPayload,
    readonly native: {threadId: string; turnId: () => string | undefined}, readonly emit: (event: HarnessAdapterEvent) => void) {}

  #bind(params: unknown) {
    const value = bindingSchema.parse(params);
    if (value.threadId !== this.native.threadId || value.turnId !== this.native.turnId())
      throw new HarnessAdapterError("native_request_binding", "Native request targets another conversation or turn.");
    if (this.#closed) throw new HarnessAdapterError("native_request_closed", "Native turn is no longer active.");
    return value;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (++this.#count > 128) throw new HarnessAdapterError("native_request_limit", "Native turn exceeded its interaction limit.");
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #expires(): number {
    const first = this.start.first_turn;
    const deadline = first?.turn_id === this.turn.turn_id ? Date.parse(first.not_after) : Infinity;
    return Math.min(Date.now() + 5 * 60_000, Number.isFinite(deadline) ? deadline : Infinity);
  }

  #wait<T>(signal: AbortSignal, pending: Omit<Approval, "settle" | "reject"> | Omit<Question, "settle" | "reject">,
    publish: () => void): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const finish = (value: T): void => { cleanup(); resolve(value); };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const abort = (): void => fail(new HarnessAdapterError("native_request_lost", "Native request was interrupted or its provider process exited."));
      const timer = setTimeout(() => fail(new HarnessAdapterError("native_request_expired", "Native interaction expired without a decision.")), Math.max(0, pending.expires - Date.now()));
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.#pending = undefined; };
      this.#pending = {...pending, settle: finish, reject: fail} as Approval | Question;
      signal.addEventListener("abort", abort, {once: true});
      try { publish(); } catch (error) { fail(error instanceof Error ? error : new Error("Cannot publish native interaction")); }
    });
  }

  approval(params: unknown, requestType: "command" | "file_read" | "file_change" | "permissions" | "other", signal: AbortSignal): Promise<{decision: string}> {
    return this.#serialize(async () => {
      const binding = this.#bind(params);
      const action = JSON.stringify({kind: "native_operation", operation: requestType, details: z.record(z.string(), z.json()).parse(params)});
      nativeReviewActionBytes(action);
      const actionHash = createHash("sha256").update(action).digest("hex");
      const id = `native-${randomUUID()}`;
      const advertised = z.object({availableDecisions: z.array(z.json()).nullish()}).parse(params).availableDecisions;
      const scope = z.object({additionalPermissions: z.json().nullish(), grantRoot: z.string().nullish()}).parse(params);
      const grantPath = scope.grantRoot ? relative(await realpath(this.start.cwd), await realpath(scope.grantRoot)) : "";
      // A native approval cannot broaden a restricted consumer's filesystem contract.
      const permitsAccept = this.start.sandbox_mode === "danger_full_access" ||
        (scope.additionalPermissions == null && (!scope.grantRoot || (!isAbsolute(grantPath) && grantPath !== ".." && !grantPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)))
          && (requestType !== "file_change" || this.start.sandbox_mode === "workspace_write"));
      const allowed = (["accept", "decline", "cancel"] as const).filter(decision => (!advertised || advertised.includes(decision)) && (decision !== "accept" || permitsAccept));
      if (!allowed.length) throw new HarnessAdapterError("native_decisions_unsupported", "Native provider offered no supported decision.");
      const expires = this.#expires();
      const decision = await this.#wait<HcpApprovalResponsePayload["decision"]>(signal,
        {kind: "approval", id, actionHash, expires, allowed}, () => this.emit({event_type: "approval.requested", turn_id: this.turn.turn_id,
          data: {request_id: id, session_id: this.start.session_id, turn_id: this.turn.turn_id, workspace_id: this.start.workspace_id,
            provider_instance_id: this.start.provider_instance_id, driver_kind: this.start.driver_kind, request_type: requestType,
            risk_class: "high", action, action_hash: actionHash, allowed_decisions: allowed,
            expires_at: new Date(expires).toISOString(), display: {title: {command: "Approve native command", file_read: "Approve native file read",
              file_change: "Approve native file change", permissions: "Approve native permissions", other: "Approve native action"}[requestType], detail: `Native item ${binding.itemId}`}}}));
      return {decision};
    });
  }

  questions(params: unknown, signal: AbortSignal): Promise<unknown> {
    return this.#serialize(async () => {
      this.#bind(params);
      const {questions} = questionSchema.parse(params);
      if (new Set(questions.map(question => question.id)).size !== questions.length)
        throw new HarnessAdapterError("native_question_duplicate", "Native questions have duplicate identities.");
      if (questions.some(question => question.isSecret))
        throw new HarnessAdapterError("native_secret_input_unsupported", "Native secret questions require an encrypted response contract.");
      const fields = Object.fromEntries(questions.map(question => {
        const choices = question.options?.map(option => option.label);
        const answer = choices?.length && !question.isOther ? z.enum(choices as [string, ...string[]]) : z.string().min(1).max(8192);
        return [question.id, z.object({answers: z.array(answer).min(1).max(question.multiSelect ? 16 : 1)
          .refine(answers => new Set(answers).size === answers.length, "Selections cannot repeat.")}).strict().describe(question.question)];
      }));
      const schema = z.object({answers: z.object(fields).strict()}).strict();
      const id = `native-${randomUUID()}`;
      const expires = this.#expires();
      return this.#wait(signal, {kind: "input", id, expires, schema}, () => this.emit({event_type: "user_input.requested", turn_id: this.turn.turn_id,
        data: {request_id: id, session_id: this.start.session_id, turn_id: this.turn.turn_id,
          prompt: questions.map(question => question.question).join("\n\n"), input_kind: "form", required: true,
          form_schema: z.toJSONSchema(schema), expires_at: new Date(expires).toISOString(), redaction: "none"}}));
    });
  }

  owns(requestId: string): boolean { return this.#pending?.id === requestId || this.#resolved.has(requestId); }

  respondApproval(response: HcpApprovalResponsePayload): void {
    this.#responseBinding(response);
    const fingerprint = JSON.stringify(response);
    if (this.#resolved.get(response.request_id) === fingerprint) return;
    const request = this.#pending;
    if (!request || request.kind !== "approval" || request.id !== response.request_id || request.actionHash !== response.action_hash
        || !request.allowed.includes(response.decision) || request.expires <= Date.now())
      throw new HarnessAdapterError("native_response_binding", "Native approval response is stale, invalid, or targets another request.");
    this.emit({event_type: "approval.resolved", turn_id: this.turn.turn_id, data: {...response, resolved_at: new Date().toISOString()}});
    this.#resolved.set(request.id, fingerprint);
    request.settle(response.decision);
  }

  respondInput(response: HcpInputResponsePayload): void {
    this.#responseBinding(response);
    const fingerprint = JSON.stringify(response);
    if (this.#resolved.get(response.request_id) === fingerprint) return;
    const request = this.#pending;
    if (!request || request.kind !== "input" || request.id !== response.request_id || request.expires <= Date.now())
      throw new HarnessAdapterError("native_response_binding", "Native question response is stale or targets another request.");
    const value = response.cancelled ? {answers: {}} : request.schema.parse(response.value);
    this.emit({event_type: "user_input.resolved", turn_id: this.turn.turn_id, data: {request_id: request.id, session_id: this.start.session_id,
      turn_id: this.turn.turn_id, actor_id: response.actor_id, cancelled: response.cancelled ?? false, resolved_at: new Date().toISOString()}});
    this.#resolved.set(request.id, fingerprint);
    request.settle(value);
  }

  #responseBinding(response: HcpApprovalResponsePayload | HcpInputResponsePayload): void {
    if (this.#closed || response.session_id !== this.start.session_id || response.turn_id !== this.turn.turn_id || !response.actor_id)
      throw new HarnessAdapterError("native_response_binding", "Native response targets another active session or turn.");
  }

  close(): void {
    this.#closed = true;
    this.#pending?.reject(new HarnessAdapterError("native_request_closed", "Native turn ended before the interaction completed."));
  }
}
