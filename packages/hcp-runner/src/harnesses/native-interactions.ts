import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { harnessNativeRequestIdentitySchema, hcpApprovalResponsePayloadSchema, nativeReviewActionBytes } from "@harness-control/protocol";
import type { HarnessNativeRequestIdentity, HcpApprovalResponsePayload, HcpInputResponsePayload, HcpSessionStartPayload, HcpTurnSendPayload } from "@harness-control/protocol";
import {nativeFormSchema} from "./native-form.js";
import { HarnessAdapterError, type HarnessAdapterEvent } from "./adapters/types.js";

type ApprovalReply = {decision: HcpApprovalResponsePayload["decision"]; feedback?: string};
type Approval = {rejectionFeedback?: boolean; nativeRequest?: HarnessNativeRequestIdentity; kind: "approval"; id: string; actionHash: string; expires: number; allowed: string[];
  settle: (reply: ApprovalReply) => void; reject: (error: Error) => void};
type Question = {nativeRequest?: HarnessNativeRequestIdentity; kind: "input"; id: string; expires: number; schema: z.ZodType; cancelledValue?: null;
  settle: (value: unknown) => void; reject: (error: Error) => void};

const bindingSchema = z.object({threadId: z.string().min(1), turnId: z.string().min(1).optional(), itemId: z.string().min(1)});
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
  #outstanding = 0;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #resolved = new Map<string, string>();
  constructor(readonly start: HcpSessionStartPayload, readonly turn: HcpTurnSendPayload | {session_id: string; request_scope: "session"; turn_id?: never},
    readonly native: {threadId: string; turnId: () => string | undefined}, readonly emit: (event: HarnessAdapterEvent) => void,
    readonly nativeWorkId?: string) {
    if (nativeWorkId !== undefined && (!turn.turn_id || !nativeWorkId || nativeWorkId.length > 512))
      throw new HarnessAdapterError("native_work_request_scope", "Native work input requires an admitted root origin and bounded work identity.");
  }

  #bind(params: unknown) {
    const value = bindingSchema.parse(params);
    if (value.threadId !== this.native.threadId || value.turnId !== this.native.turnId()
        || (this.turn.turn_id ? value.turnId === undefined : value.turnId !== undefined))
      throw new HarnessAdapterError("native_request_binding", "Native request targets another conversation or turn.");
    if (this.#closed) throw new HarnessAdapterError("native_request_closed", "Native turn is no longer active.");
    return value;
  }

  #requestIdentity(input: HarnessNativeRequestIdentity | undefined): HarnessNativeRequestIdentity | undefined {
    if (!input) return;
    const identity = harnessNativeRequestIdentitySchema.parse(input);
    if (identity.native_reference !== this.native.threadId)
      throw new HarnessAdapterError("native_request_binding", "Native request evidence targets another physical conversation.");
    return identity;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.turn.turn_id ? ++this.#count > 128 : this.#outstanding >= 128) throw new HarnessAdapterError("native_request_limit", "Native owner exceeded its bounded interaction limit.");
    this.#outstanding++;
    const result = this.#queue.then(operation).finally(() => {this.#outstanding--;});
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #expires(): number {
    const first = this.start.first_turn;
    const deadline = first && first.turn_id === this.turn.turn_id ? Date.parse(first.not_after) : Infinity;
    return Math.min(Date.now() + 5 * 60_000, Number.isFinite(deadline) ? deadline : Infinity);
  }
  #origin(): {turn_id: string; native_work_id?: string} | {request_scope: "session"} {
    return this.turn.turn_id ? {turn_id: this.turn.turn_id, ...(this.nativeWorkId ? {native_work_id: this.nativeWorkId} : {})} : {request_scope: "session"};
  }

  #wait<T>(signal: AbortSignal, pending: Omit<Approval, "settle" | "reject"> | Omit<Question, "settle" | "reject">,
    publish: () => void): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const finish = (value: T): void => { cleanup(); resolve(value); };
      const fail = (error: Error): void => {
        try {this.emit({event_type: "native.request.lost", ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}), data: {request_id: pending.id, session_id: this.start.session_id,
          ...this.#origin(), ...(pending.nativeRequest ? {native_request: pending.nativeRequest} : {}), request_kind: pending.kind, reason: error instanceof HarnessAdapterError && error.code === "native_request_expired" ? "expired"
            : error instanceof HarnessAdapterError && error.code === "native_request_closed" ? "owner_closed" : "interrupted", lost_at: new Date().toISOString()}});} catch { /* An unavailable journal cannot resurrect a callback. */ }
        cleanup(); reject(error);
      };
      const abort = (): void => fail(new HarnessAdapterError("native_request_lost", "Native request was interrupted or its provider process exited."));
      const timer = setTimeout(() => fail(new HarnessAdapterError("native_request_expired", "Native interaction expired without a decision.")), Math.max(0, pending.expires - Date.now()));
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.#pending = undefined; };
      this.#pending = {...pending, settle: finish, reject: fail} as Approval | Question;
      signal.addEventListener("abort", abort, {once: true});
      try { publish(); } catch (error) { fail(error instanceof Error ? error : new Error("Cannot publish native interaction")); }
    });
  }

  approval(params: unknown, requestType: "command" | "file_read" | "file_change" | "permissions" | "other", signal: AbortSignal, nativeRequest?: HarnessNativeRequestIdentity, options: {rejectionFeedback?: boolean} = {}): Promise<ApprovalReply> {
    const rejectionFeedback = options.rejectionFeedback === true;
    if (!this.turn.turn_id) throw new HarnessAdapterError("native_request_scope", "Native approvals require an admitted turn origin.");
    return this.#serialize(async () => {
      const binding = this.#bind(params);
      const identity = this.#requestIdentity(nativeRequest);
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
      const allowed = (["accept", "accept_for_session", "decline", "cancel"] as const).filter(decision =>
        (!advertised || advertised.includes(decision)) && (!["accept", "accept_for_session"].includes(decision) || permitsAccept)
        && (decision !== "accept_for_session" || !!this.start.execution_profile && this.start.execution_profile !== "isolated" && advertised?.includes(decision)));
      if (!allowed.length) throw new HarnessAdapterError("native_decisions_unsupported", "Native provider offered no supported decision.");
      const expires = this.#expires();
      const reply = await this.#wait<ApprovalReply>(signal,
        {kind: "approval", id, actionHash, expires, allowed, ...(rejectionFeedback ? {rejectionFeedback: true} : {}), ...(identity ? {nativeRequest: identity} : {})}, () => this.emit({event_type: "approval.requested", ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}),
          data: {request_id: id, session_id: this.start.session_id, ...(identity ? {native_request: identity} : {}), ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}), workspace_id: this.start.workspace_id,
            provider_instance_id: this.start.provider_instance_id, driver_kind: this.start.driver_kind, request_type: requestType,
            ...(this.nativeWorkId ? {native_work_id: this.nativeWorkId} : {}),
            risk_class: "high", action, action_hash: actionHash, ...(rejectionFeedback ? {rejection_feedback_supported: true} : {}), allowed_decisions: allowed,
            expires_at: new Date(expires).toISOString(), display: {title: {command: "Approve native command", file_read: "Approve native file read",
              file_change: "Approve native file change", permissions: "Approve native permissions", other: "Approve native action"}[requestType], detail: `Native item ${binding.itemId}`}}}));
      return reply;
    });
  }

  questions(params: unknown, signal: AbortSignal, nativeRequest?: HarnessNativeRequestIdentity): Promise<unknown> {
    if (!this.turn.turn_id) throw new HarnessAdapterError("native_request_scope", "Native tool questions require an admitted turn origin.");
    return this.#serialize(async () => {
      this.#bind(params);
      const identity = this.#requestIdentity(nativeRequest);
      const {questions} = questionSchema.parse(params);
      if (new Set(questions.map(question => question.id)).size !== questions.length)
        throw new HarnessAdapterError("native_question_duplicate", "Native questions have duplicate identities.");
      if (questions.some(question => question.isSecret))
        throw new HarnessAdapterError("native_secret_input_unsupported", "Native secret questions require an encrypted response contract.");
      const fields = Object.fromEntries(questions.map(question => {
        const choices = question.options?.map(option => option.label);
        const closedChoices = choices?.length && !question.isOther;
        // JSON Schema counts Unicode code points, including supplementary-plane characters.
        const baseAnswer = closedChoices ? z.enum(choices as [string, ...string[]]) : z.string().min(1)
          .refine(value => Array.from(value).length <= 8192, "An answer cannot exceed 8192 Unicode characters.").meta({maxLength: 8192});
        // Standard JSON Schema annotations retain native presentation without narrowing native validation.
        const answer = question.options?.length ? baseAnswer.meta({...(closedChoices ? {} : {maxLength: 8192}), anyOf: [
          ...question.options.map(option => ({const: option.label, description: option.description})),
          ...(question.isOther ? [{type: "string", minLength: 1, maxLength: 8192}] : []),
        ]}) : baseAnswer;
        return [question.id, z.object({answers: z.array(answer).min(1).max(question.multiSelect ? 16 : 1)
          .refine(answers => new Set(answers).size === answers.length, "Selections cannot repeat.").meta({uniqueItems: true})}).strict().describe(question.question).meta({title: question.header})];
      }));
      const schema = z.object({answers: z.object(fields).strict()}).strict();
      const id = `native-${randomUUID()}`;
      const expires = this.#expires();
      return this.#wait(signal, {kind: "input", id, expires, schema, ...(identity ? {nativeRequest: identity} : {})}, () => this.emit({event_type: "user_input.requested", ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}),
        data: {request_id: id, session_id: this.start.session_id, ...(identity ? {native_request: identity} : {}), ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}),
          ...(this.nativeWorkId ? {native_work_id: this.nativeWorkId} : {}),
          prompt: questions.map(question => question.question).join("\n\n"), input_kind: "form", required: true,
          form_schema: z.toJSONSchema(schema), expires_at: new Date(expires).toISOString(), redaction: "none"}}));
    });
  }

  owns(requestId: string): boolean { return this.#pending?.id === requestId || this.#resolved.has(requestId); }
  get outstanding(): boolean {return this.#outstanding > 0;}

  form(params: unknown, prompt: string, requestedSchema: unknown, signal: AbortSignal, nativeRequest?: HarnessNativeRequestIdentity): Promise<unknown | null> {
    return this.#serialize(async () => {
      this.#bind(params);
      const identity = this.#requestIdentity(nativeRequest);
      const schema = nativeFormSchema(requestedSchema);
      const boundedPrompt = z.string().min(1).max(8192).parse(prompt);
      const id = `native-${randomUUID()}`, expires = this.#expires();
      return this.#wait(signal, {kind: "input", id, expires, schema, cancelledValue: null, ...(identity ? {nativeRequest: identity} : {})}, () => this.emit({
        event_type: "user_input.requested", ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}), data: {request_id: id, session_id: this.start.session_id,
          ...this.#origin(), ...(identity ? {native_request: identity} : {}), prompt: boundedPrompt, input_kind: "form", required: true, form_schema: z.toJSONSchema(schema),
          expires_at: new Date(expires).toISOString(), redaction: "none"}}));
    });
  }

  respondApproval(response: HcpApprovalResponsePayload): void {
    this.#responseBinding(response);
    const fingerprint = JSON.stringify(response);
    if (this.#resolved.get(response.request_id) === fingerprint) return;
    const request = this.#pending;
    if (!request || request.kind !== "approval" || request.id !== response.request_id || request.actionHash !== response.action_hash
        || !request.allowed.includes(response.decision) || request.expires <= Date.now())
      throw new HarnessAdapterError("native_response_binding", "Native approval response is stale, invalid, or targets another request.");
    if (response.feedback !== undefined && (!request.rejectionFeedback || !hcpApprovalResponsePayloadSchema.safeParse(response).success))
      throw new HarnessAdapterError("native_feedback_unsupported", "The native callback does not support this rejection feedback.");
    this.emit({event_type: "approval.resolved", ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}), data: {...response, ...(request.nativeRequest ? {native_request: request.nativeRequest} : {}),
      ...(this.nativeWorkId ? {native_work_id: this.nativeWorkId} : {}), resolved_at: new Date().toISOString()}});
    this.#remember(request.id, fingerprint);
    request.settle({decision: response.decision, ...(response.feedback === undefined ? {} : {feedback: response.feedback})});
  }

  respondInput(response: HcpInputResponsePayload): void {
    this.#responseBinding(response);
    const fingerprint = JSON.stringify(response);
    if (this.#resolved.get(response.request_id) === fingerprint) return;
    const request = this.#pending;
    if (!request || request.kind !== "input" || request.id !== response.request_id || request.expires <= Date.now())
      throw new HarnessAdapterError("native_response_binding", "Native question response is stale or targets another request.");
    const value = response.cancelled ? request.cancelledValue === null ? null : {answers: {}} : request.schema.parse(response.value);
    this.emit({event_type: "user_input.resolved", ...(this.turn.turn_id ? {turn_id: this.turn.turn_id} : {}), data: {request_id: request.id, session_id: this.start.session_id,
      ...this.#origin(), ...(request.nativeRequest ? {native_request: request.nativeRequest} : {}), actor_id: response.actor_id, cancelled: response.cancelled ?? false, resolved_at: new Date().toISOString()}});
    this.#remember(request.id, fingerprint);
    request.settle(value);
  }

  #responseBinding(response: HcpApprovalResponsePayload | HcpInputResponsePayload): void {
    if (this.#closed || response.session_id !== this.start.session_id || response.turn_id !== this.turn.turn_id || !response.actor_id)
      throw new HarnessAdapterError("native_response_binding", "Native response targets another active session or turn.");
    if (("request_scope" in response ? response.request_scope ?? "turn" : "turn") !== (this.turn.turn_id ? "turn" : "session"))
      throw new HarnessAdapterError("native_response_binding", "Native response targets another request scope.");
  }
  #remember(id: string, fingerprint: string): void {
    this.#resolved.set(id, fingerprint);
    if (this.#resolved.size > 128) this.#resolved.delete(this.#resolved.keys().next().value!);
  }

  close(): void {
    this.#closed = true;
    this.#pending?.reject(new HarnessAdapterError("native_request_closed", "Native turn ended before the interaction completed."));
  }
}
