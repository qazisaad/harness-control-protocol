import {randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {query, type Query, type Options, type SDKMessage, type SDKUserMessage} from "@anthropic-ai/claude-agent-sdk";
import {z} from "zod";
import {isNativeWorkTerminal, type HarnessContextUsage, type HarnessNativeWorkObservation, type HarnessTurnFinalOutput} from "@harness-control/protocol";
import {HarnessAdapterError, type HarnessAdapterStartInput, type HarnessAdapterTurnInput, type HarnessAdapterEvent, type HarnessNativeInteractions} from "../types.js";
import {NativeInteractions} from "../../native-interactions.js";
import {ClaudeInput} from "./claude-input.js";
import {claudePermissions} from "./claude-permissions.js";
import {claudeElicitation} from "./claude-elicitation.js";
import {hasInheritedClaudePlugins} from "./claude-inventory.js";
import {claudeContextCapacity} from "./claude-context.js";
import {claudeEffortControl} from "./claude-effort.js";
import {claudeResultSchema, type ClaudeQueryFactory} from "./claude-runtime.js";
import {NativeProcess} from "./native-process.js";
import {adapterMcpServers, assertCliMcpAttachmentProxied} from "./shared.js";
import {selectedEffort} from "./native-turn.js";
import {measuredContext, unavailableContext} from "./native-context.js";
import {retainedContent, retainedFinalText, textChunks} from "./content-projection.js";

type Root = {input: HarnessAdapterTurnInput; emit: (event: HarnessAdapterEvent) => void; ids: Set<string>;
  interactions: NativeInteractions; lifetime: AbortController; context: HarnessContextUsage; nativeModel?: string; streamed: boolean; compacted: boolean;
  commandStarted?: boolean; pendingCompactContext?: HarnessContextUsage;
  completion: Promise<HarnessTurnFinalOutput>; resolve: (result: HarnessTurnFinalOutput) => void; reject: (error: unknown) => void};
type Task = {work: HarnessNativeWorkObservation; root: Root; lifetime: AbortController; launch?: string};
const error = (code: string, message: string) => new HarnessAdapterError(code, message);
async function bounded<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(error("native_control_unknown", "The native control did not confirm its outcome.")), milliseconds);})]);}
  finally {if (timer) clearTimeout(timer);}
}

/** One session-owned SDK query and pump; native prompt UUIDs bind every root result. */
export class PersistentClaudeSession implements HarnessNativeInteractions {
  readonly nativeId: string;
  readonly #channel = new ClaudeInput();
  readonly #tasks = new Map<string, Task>();
  readonly #launches = new Map<string, {root: Root; parent?: string}>();
  readonly #roots = new Set<Root>();
  readonly #sessionLifetime = new AbortController();
  readonly #sessionInputs: NativeInteractions;
  #background = new Set<string>();
  #unconfirmedWork = false;
  #active: Root | undefined;
  #boundRoot: Root | undefined;
  #stream: Query | undefined;
  #process: NativeProcess | undefined;
  #pump: Promise<void> | undefined;
  #initialized = false;
  #lost = false;
  #stopping: Promise<void> | undefined;
  #selection: HarnessAdapterTurnInput["startPayload"]["model_selection"] | undefined;
  #mode: "execute" | "plan" | undefined;

  constructor(readonly start: HarnessAdapterStartInput, readonly factory: ClaudeQueryFactory = query) {
    this.nativeId = start.nativeConversation?.native_thread_id ?? randomUUID();
    this.#sessionInputs = new NativeInteractions(start.payload, {session_id: start.payload.session_id, request_scope: "session"},
      {threadId: this.nativeId, turnId: () => undefined}, event => this.#session(event));
    if (!start.emitSessionEvent || !start.registerSessionInteractions) throw error("native_session_owner_required", "Interactive Claude requires session observation and interaction ownership.");
    start.registerSessionInteractions(this);
  }
  owns(id: string): boolean {return this.#sessionInputs.owns(id) || [...this.#roots].some(root => root.interactions.owns(id));}
  respondApproval(response: Parameters<HarnessNativeInteractions["respondApproval"]>[0]): void {
    const root = [...this.#roots].find(root => root.interactions.owns(response.request_id));
    if (!root || this.#lost) throw error("native_response_binding", "The persistent native request owner is unavailable.");
    root.interactions.respondApproval(response);
  }
  respondInput(response: Parameters<HarnessNativeInteractions["respondInput"]>[0]): void {
    if (this.#sessionInputs.owns(response.request_id)) {
      if (this.#lost) throw error("native_response_binding", "The native session input owner is unavailable.");
      this.#sessionInputs.respondInput(response); return;
    }
    const root = [...this.#roots].find(root => root.interactions.owns(response.request_id));
    if (!root || this.#lost) throw error("native_response_binding", "The persistent native request owner is unavailable.");
    root.interactions.respondInput(response);
  }
  #session(event: HarnessAdapterEvent): void {this.start.emitSessionEvent!(event);}
  #observe(task: Task): void {this.#session({event_type: "native.work.updated", data: {work: task.work}});}
  #pending(): Task[] {return [...this.#tasks.values()].filter(task => !isNativeWorkTerminal(task.work.status));}
  #unownedBackground(): boolean {return this.#unconfirmedWork || [...this.#background].some(id => !this.#tasks.has(id));}
  #lose(reason: "native_exit" | "transport_lost" | "runtime_error", failure: unknown): void {
    if (this.#lost) return;
    this.#lost = true;
    this.#sessionLifetime.abort(); this.#sessionInputs.close();
    for (const root of this.#roots) {root.lifetime.abort(); root.interactions.close();}
    this.#active?.reject(failure);
    try {this.#session({event_type: "native.work.owner_lost", data: {reason, ...(this.#unownedBackground() ? {closure_unconfirmed: true} : {})}});} catch { /* Physical ownership remains lost when persistence is unavailable. */ }
    this.start.registerSessionInteractions?.(undefined);
    this.#channel.close(); try {this.#stream?.close();} catch { /* Losing the SDK transport does not restore physical ownership. */ }
    if (this.#process) void this.#process.stop();
  }
  #message(root: Root, text: string): SDKUserMessage {
    const uuid = randomUUID(); root.ids.add(uuid);
    return {type: "user", uuid, session_id: this.nativeId, parent_tool_use_id: null, message: {role: "user", content: text}};
  }
  async run(input: HarnessAdapterTurnInput, signal: AbortSignal, emit: (event: HarnessAdapterEvent) => void): Promise<HarnessTurnFinalOutput> {
    if (this.#lost || this.#stopping) throw error("native_owner_unavailable", "The persistent Claude owner cannot execute another turn.");
    if (this.#active) throw error("native_turn_busy", "A native root turn is already running.");
    if (input.payload.action === "compact" && (this.#pending().length || this.#background.size || this.#unconfirmedWork || this.#sessionInputs.outstanding))
      throw error("native_work_compaction_busy", "Manual compaction cannot establish exclusive command ownership while native work or session input is outstanding.");
    if (this.#roots.size >= 128) for (const root of this.#roots) {
      if (root.interactions.outstanding || this.#pending().some(task => task.root === root)) continue;
      root.lifetime.abort(); root.interactions.close(); this.#roots.delete(root);
      for (const [id, launch] of this.#launches) if (launch.root === root) this.#launches.delete(id);
      break;
    }
    if (this.#roots.size >= 128) throw error("native_session_turn_limit", "The persistent session reached its bounded live interaction ownership registry.");
    const selection = input.payload.model_selection ?? input.startPayload.model_selection;
    const mode = input.payload.mode ?? "execute";
    selectedEffort(selection, "claude");
    let effectiveOptions: Awaited<ReturnType<ReturnType<typeof claudeEffortControl>>> | undefined;
    if (this.#selection && (JSON.stringify(selection) !== JSON.stringify(this.#selection) || mode !== this.#mode)) {
      if (this.#pending().length || this.#background.size || this.#sessionInputs.outstanding) throw error("native_work_settings_busy", "Settings cannot change while native work or session input is outstanding or its owner is unresolved.");
      const changeEffort = JSON.stringify(selection.options ?? []) !== JSON.stringify(this.#selection.options ?? [])
        ? claudeEffortControl(this.#stream!, selectedEffort(selection, "claude")) : undefined;
      try {
        if (selection.model !== this.#selection.model) await bounded(this.#stream!.setModel(selection.model));
        if (changeEffort) effectiveOptions = await bounded(changeEffort());
        if (mode !== this.#mode) await bounded(this.#stream!.setPermissionMode(this.#permissionMode(mode)));
      } catch (failure) {this.#lose("transport_lost", failure); throw failure;}
    }
    this.#selection = structuredClone(selection); this.#mode = mode;
    let resolve!: Root["resolve"], reject!: Root["reject"];
    const completion = new Promise<HarnessTurnFinalOutput>((yes, no) => {resolve = yes; reject = no;});
    void completion.catch(() => undefined); // Factory failure can reject before run reaches its await.
    const root: Root = {input, emit, ids: new Set(), lifetime: new AbortController(), context: unavailableContext(selection, "new_native_request"),
      streamed: false, compacted: false, completion, resolve, reject,
      interactions: new NativeInteractions(input.startPayload, input.payload, {threadId: this.nativeId, turnId: () => input.payload.turn_id}, event => this.#session(event))};
    this.#active = root; this.#boundRoot = undefined; this.#roots.add(root);
    const abort = () => {void this.#interrupt(root);};
    signal.addEventListener("abort", abort, {once: true});
    try {
      signal.throwIfAborted();
      if (effectiveOptions) emit({event_type: "settings.options.effective", turn_id: input.payload.turn_id, data: {
        scope: "root", source: "native", model_selection: {model: effectiveOptions.model,
          options: effectiveOptions.effort === null ? [] : [{id: "effort", value: effectiveOptions.effort}]}}});
      emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: {...root.context}});
      const message = this.#message(root, input.payload.action === "compact" ? "/compact" : input.payload.input);
      if (input.payload.images?.length) message.message.content = [{type: "text", text: input.payload.input}, ...input.payload.images.map(image => ({type: "image" as const,
        source: {type: "base64" as const, media_type: image.mime_type, data: image.data_base64}}))];
      this.#channel.offer(message);
      if (!this.#stream) try {this.#open();} catch (failure) {this.#lose("runtime_error", failure); throw failure;}
      if (this.#initialized) {
        input.session.native_thread_id = this.nativeId; input.persistNativeThread?.(this.nativeId);
        this.#controls(root, signal);
      }
      return await completion;
    } catch (failure) {
      if (!this.#pending().some(task => task.root === root)) {root.lifetime.abort(); root.interactions.close();}
      if (this.#lost) {await this.#process?.stop(); if (this.#pump) await bounded(this.#pump);}
      throw failure;
    }
    finally {
      signal.removeEventListener("abort", abort);
      input.registerActiveTurnControls?.(undefined);
      if (this.#active === root) this.#active = undefined;
      if (this.#boundRoot === root) this.#boundRoot = undefined;
    }
  }
  #permissionMode(mode: "execute" | "plan"): NonNullable<Options["permissionMode"]> {
    return mode === "plan" ? "plan" : ({ask: "default", auto_edits: "acceptEdits", full_access: "bypassPermissions"} as const)[this.start.payload.approval_policy];
  }
  #controls(root: Root, signal: AbortSignal): void {
    root.input.registerActiveTurnControls?.({steer: async text => {signal.throwIfAborted(); if (this.#active !== root || this.#lost) throw error("active_turn_unavailable", "The native root owner changed."); this.#channel.offer(this.#message(root, text));}});
    root.emit({event_type: "session.configured", data: {execution_profile: "interactive", model_selection: this.#selection!, mode: this.#mode!, native_conversation_ready: true}});
  }
  #open(): void {
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    for (const attachment of adapterMcpServers(this.start.mcpServers, this.start.payload)) {
      assertCliMcpAttachmentProxied(attachment, "Claude", "claude"); mcpServers[attachment.name] = {type: "http", url: attachment.url};
    }
    const effort = selectedEffort(this.#selection!, "claude") as Options["effort"];
    this.#stream = this.factory({prompt: this.#channel, options: {
      pathToClaudeCodeExecutable: this.start.provider.executable_path ?? "claude", cwd: this.start.payload.cwd,
      model: this.#selection!.model, ...(effort ? {effort} : {}),
      env: {...process.env, ...this.start.provider.env, ...(this.start.provider.home ? {CLAUDE_CONFIG_DIR: this.start.provider.home} : {})},
      systemPrompt: this.start.payload.instructions?.system ?? {type: "preset", preset: "claude_code"}, settingSources: [], settings: {disableAllHooks: true},
      persistSession: true, ...(this.start.nativeConversation && !this.start.nativeConversation.fresh ? {resume: this.nativeId} : {sessionId: this.nativeId}),
      // This owner exposes stopTask through HCP work cancellation. Without this declaration,
      // native interrupt also kills independent background tasks on an open input stream.
      perTaskStopAffordance: true,
      includePartialMessages: true, strictMcpConfig: true, mcpServers, permissionMode: this.#permissionMode(this.#mode!),
      allowDangerouslySkipPermissions: this.start.payload.approval_policy === "full_access",
      onElicitation: claudeElicitation(() => {
        if (!this.#initialized || this.#lost) return undefined;
        return {threadId: this.nativeId, interactions: this.#sessionInputs, signal: this.#sessionLifetime.signal, serverNames: Object.keys(mcpServers)};
      }),
      canUseTool: claudePermissions(options => {
        if (!this.#initialized || this.#lost) return undefined;
        const task = options.agentID ? this.#tasks.get(options.agentID) : undefined;
        const origin = this.#launches.get(options.toolUseID)?.root;
        const root = options.agentID ? task?.root : origin ?? this.#boundRoot;
        if (!root || options.agentID && (!task || isNativeWorkTerminal(task.work.status))) return undefined;
        return {threadId: this.nativeId, turnId: root.input.payload.turn_id, interactions: root.interactions,
          signal: task ? AbortSignal.any([root.lifetime.signal, task.lifetime.signal]) : root.lifetime.signal, allowSessionPermissions: true};
      }),
      spawnClaudeCodeProcess: options => {
        this.#process = new NativeProcess(options.command, options.args, this.start.payload.cwd, options.env); this.#process.child.stderr.resume();
        void this.#process.closed.then(() => {if (!this.#stopping) this.#lose("native_exit", error("native_process_exited", "The persistent native process exited."));});
        return this.#process.child;
      },
    }});
    this.#pump = this.#consume();
  }
  async #consume(): Promise<void> {
    try {
      for await (const message of this.#stream!) await this.#handle(message);
      if (!this.#stopping) this.#lose("native_exit", error("native_stream_closed", "The native stream ended without an owned unload."));
    } catch (failure) {this.#lose("runtime_error", failure);}
  }
  async #handle(message: SDKMessage): Promise<void> {
    if ("session_id" in message && message.session_id !== this.nativeId) throw error("native_continuation_binding", "Claude emitted another native session identity.");
    const lifecycle = z.object({type: z.literal("command_lifecycle"), command_uuid: z.string(), state: z.enum(["queued", "started"])}).safeParse(message);
    if (lifecycle.success) {
      // CLI admission frames precede system/init. They prove neither policy nor execution results.
      if (!this.#active?.ids.has(lifecycle.data.command_uuid)) throw error("native_continuation_binding", "Claude admitted an unowned native command.");
      if (lifecycle.data.state === "started") this.#active.commandStarted = true;
      return;
    }
    // Fork restoration can announce display metadata before proving the runtime policy.
    if (z.object({type: z.literal("system"), subtype: z.literal("session_title_changed")}).safeParse(message).success) return;
    if (message.type === "system" && message.subtype === "init") {
      const init = z.object({cwd: z.string(), permissionMode: z.string(), mcp_servers: z.array(z.object({name: z.string(), status: z.string()})), plugins: z.array(z.unknown())}).parse(message);
      const expected = adapterMcpServers(this.start.mcpServers, this.start.payload).map(server => server.name).sort();
      if (await realpath(init.cwd) !== await realpath(this.start.payload.cwd) || init.permissionMode !== this.#permissionMode(this.#mode!)) throw error("policy_mismatch", "Claude did not confirm the requested workspace and permissions.");
      if (hasInheritedClaudePlugins(init.plugins) || init.mcp_servers.some(server => server.status !== "connected") || JSON.stringify(init.mcp_servers.map(server => server.name).sort()) !== JSON.stringify(expected)) throw error("mcp_scope_mismatch", "Claude did not confirm the exact native MCP and plugin inventory.");
      this.#initialized = true;
      if (this.#active) {this.#active.input.session.native_thread_id = this.nativeId; this.#active.input.persistNativeThread?.(this.nativeId);
        this.#controls(this.#active, this.#active.lifetime.signal);}
      return;
    }
    if (!this.#initialized) throw error("native_continuation_binding", `Claude emitted ${message.type}${"subtype" in message ? `/${message.subtype}` : ""} before its initialization proof.`);
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      // The SDK explicitly permits this level signal to precede its origin-bearing bookends.
      // It fences destructive controls; neither absence nor membership proves a terminal outcome or origin.
      const roster = z.object({tasks: z.array(z.object({task_id: z.string().min(1).max(512)})).max(1024)}).parse(message);
      this.#background = new Set(roster.tasks.map(task => task.task_id));
      return;
    }
    const echoed = z.object({user_message_uuid: z.string().optional(), user_message_uuids: z.array(z.string()).max(64).optional()}).parse(message);
    const ids = [...(echoed.user_message_uuids ?? []), ...(echoed.user_message_uuid ? [echoed.user_message_uuid] : [])];
    if (ids.length) this.#boundRoot = this.#active && ids.some(id => this.#active!.ids.has(id)) ? this.#active : undefined;
    if (message.type === "system" && ["task_started", "task_updated", "task_progress", "task_notification"].includes(message.subtype)) {
      try {this.#task(message);} catch (failure) {this.#unconfirmedWork = true; throw failure;}
      return;
    }
    const parent = "parent_tool_use_id" in message ? message.parent_tool_use_id : null;
    if (!parent && (message.type === "assistant" || message.type === "stream_event" && message.event.type === "message_start")) {
      // Each root message starts a correlation lane. Autonomous wakes must not inherit the prior app prompt's lane.
      this.#boundRoot = this.#active && ids.some(id => this.#active!.ids.has(id)) ? this.#active : undefined;
    }
    const root = parent ? this.#launches.get(parent)?.root : this.#boundRoot;
    if (message.type === "assistant") {
      if (root) for (const block of message.message.content) if (block.type === "tool_use") {
        if (this.#launches.size >= 10_000 && !this.#launches.has(block.id)) throw error("native_item_limit", "Claude exceeded the bounded tool ownership registry.");
        const parentTask = parent ? [...this.#tasks.values()].find(task => task.launch === parent)?.work.work_id : undefined;
        this.#launches.set(block.id, {root, ...(parentTask ? {parent: parentTask} : {})});
        if (!parent && root === this.#active) root.emit({event_type: "item.started", turn_id: root.input.payload.turn_id,
          data: {item_id: block.id, item_type: "tool_call", summary: block.name, content: retainedContent({arguments: block.input}, root.input.publishContent)}});
      }
      if (!parent && root && root === this.#active) {
        root.nativeModel = message.message.model;
        const counters = z.object({input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
          cache_read_input_tokens: z.number().int().nonnegative().nullish(), cache_creation_input_tokens: z.number().int().nonnegative().nullish()}).safeParse(message.message.usage);
        root.context = counters.success ? measuredContext(this.#selection!, "claude.sdk.assistant.usage", counters.data.input_tokens + counters.data.output_tokens + (counters.data.cache_read_input_tokens ?? 0) + (counters.data.cache_creation_input_tokens ?? 0)) : unavailableContext(this.#selection!, "native_measurement_unavailable");
        root.emit({event_type: "context.updated", turn_id: root.input.payload.turn_id, data: {...root.context}});
      }
    }
    if (!parent && root && root === this.#active && message.type === "stream_event" && message.event.type === "content_block_delta") {
      const delta = message.event.delta;
      if (delta.type === "text_delta" || delta.type === "thinking_delta") {
        if (delta.type === "text_delta") root.streamed = true;
        for (const chunk of textChunks(delta.type === "text_delta" ? delta.text : delta.thinking)) root.emit({event_type: delta.type === "text_delta" ? "content.delta" : "reasoning.delta", turn_id: root.input.payload.turn_id, data: {delta: chunk}});
      }
    }
    if (!parent && root === this.#active && root && message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content)
      if (block.type === "tool_result") root.emit({event_type: "item.completed", turn_id: root.input.payload.turn_id, data: {item_id: block.tool_use_id, item_type: "tool_call", status: block.is_error ? "failed" : "completed", content: retainedContent(block.content ?? [], root.input.publishContent)}});
    if (message.type === "system" && message.subtype === "compact_boundary") {
      const context = message.compact_metadata.post_tokens !== undefined ? measuredContext(this.#selection!, "claude.sdk.compact_boundary.post_tokens", message.compact_metadata.post_tokens, undefined, "retained_conversation") : unavailableContext(this.#selection!, "native_compaction_has_no_measurement");
      if (root && root === this.#active) {
        root.compacted = true; root.context = context;
        root.emit({event_type: "context.updated", turn_id: root.input.payload.turn_id, data: {...root.context}});
      } else if (this.#active?.input.payload.action === "compact" && this.#active.commandStarted
          && message.compact_metadata.trigger === "manual" && !this.#pending().length && !this.#background.size && !this.#unconfirmedWork) {
        // The local command emits an unstamped boundary. Keep it provisional until its UUID-bound result confirms ownership.
        this.#active.pendingCompactContext = context;
      }
    }
    if (message.type === "result") {
      // An unstamped result may be an autonomous background wake. It cannot complete an app's root.
      if (!ids.length) {
        if (this.#active && (this.#boundRoot === this.#active || this.#active.pendingCompactContext))
          throw error("native_result_binding_unconfirmed", "Persistent results require the admitted user-message identity.");
        return;
      }
      if (!root || root !== this.#active || !ids.some(id => root.ids.has(id))) return;
      const parsed = claudeResultSchema.safeParse(message);
      if (!parsed.success || parsed.data.api_error_status != null && parsed.data.api_error_status >= 400
          || parsed.success && (parsed.data.terminal_reason !== undefined && parsed.data.terminal_reason !== "completed" || parsed.data.stop_reason != null && !["end_turn", "stop_sequence"].includes(parsed.data.stop_reason)))
        {root.reject(error("claude_result_error", "Claude returned an unsuccessful or malformed native root result.")); this.#active = undefined; this.#boundRoot = undefined; return;}
      if (root.input.payload.action === "compact" && root.pendingCompactContext
          && z.object({local_command: z.literal("compact")}).safeParse(message).success) {
        root.compacted = true; root.context = root.pendingCompactContext;
      }
      if (root.input.payload.action === "compact" && !root.compacted) throw error("native_compaction_unknown", "Claude did not confirm native compaction.");
      const result = parsed.data;
      root.context = claudeContextCapacity(root.context, root.nativeModel, result.modelUsage);
      root.emit({event_type: "context.updated", turn_id: root.input.payload.turn_id, data: {...root.context}});
      if (!root.streamed) for (const delta of textChunks(result.result)) root.emit({event_type: "content.delta", turn_id: root.input.payload.turn_id, data: {delta}});
      const usages = Object.values(result.modelUsage ?? {});
      const inputTokens = usages.reduce((sum, usage) => sum + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens, 0);
      const outputTokens = usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
      root.resolve({...retainedFinalText(result.result, root.input.publishContent), context: root.context, usage: {scope: "conversation", status: result.modelUsage ? "complete" : "partial", source: "claude.sdk.query.modelUsage",
        ...(result.modelUsage ? {input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
          cached_input_tokens: usages.reduce((sum, usage) => sum + usage.cacheReadInputTokens, 0),
          cache_creation_input_tokens: usages.reduce((sum, usage) => sum + usage.cacheCreationInputTokens, 0)} : {}), ...(result.total_cost_usd !== undefined ? {cost_usd: result.total_cost_usd} : {})}});
      this.#active = undefined; this.#boundRoot = undefined;
    }
  }
  #task(message: SDKMessage): void {
    const candidate = z.object({subtype: z.string(), task_id: z.string().min(1).max(512), tool_use_id: z.string().optional(), description: z.string().optional(), summary: z.string().optional(),
      task_type: z.string().optional(), is_backgrounded: z.boolean().optional(), status: z.string().optional(), patch: z.object({status: z.string().optional(), description: z.string().optional(), is_backgrounded: z.boolean().optional()}).optional()}).parse(message);
    let task = this.#tasks.get(candidate.task_id);
    if (candidate.subtype === "task_started") {
      const launch = candidate.tool_use_id ? this.#launches.get(candidate.tool_use_id) : undefined;
      if (!launch) throw error("native_work_origin_unconfirmed", "Claude started work without a confirmed admitted launch.");
      if (task) {if (task.root !== launch.root || isNativeWorkTerminal(task.work.status)) throw error("native_work_identity_conflict", "Claude reused an owned task identity."); return;}
      if (this.#tasks.size >= 1024) throw error("native_work_limit", "Claude exceeded its bounded work ownership registry.");
      task = {root: launch.root, lifetime: new AbortController(), ...(candidate.tool_use_id ? {launch: candidate.tool_use_id} : {}), work: {work_id: candidate.task_id, native_reference: candidate.task_id,
        origin_turn_id: launch.root.input.payload.turn_id, kind: candidate.task_type === "local_agent" ? "agent" : candidate.task_type === "local_bash" ? "command" : "task",
        background: candidate.is_backgrounded ?? false, status: "running", supports_cancel: true, summary: (candidate.description ?? "Native work").slice(0, 2048), ...(launch.parent ? {parent_work_id: launch.parent} : {})}};
      this.#tasks.set(candidate.task_id, task);
    } else if (!task) throw error("native_work_origin_unconfirmed", "Claude observed an unowned native task.");
    const nativeStatus = candidate.patch?.status ?? candidate.status;
    if (nativeStatus) {
      const status = ({completed: "completed", failed: "failed", stopped: "cancelled", killed: "cancelled", paused: "waiting", pending: "waiting", running: "running"} as const)[nativeStatus as "running"];
      if (!status) throw error("native_work_status_unsupported", "Claude emitted an unknown task status.");
      if (isNativeWorkTerminal(task.work.status) && task.work.status !== status) throw error("native_work_terminal", "Claude reopened terminal native work.");
      task.work.status = status;
    }
    if (candidate.patch?.is_backgrounded !== undefined) task.work.background = candidate.patch.is_backgrounded;
    const summary = candidate.summary ?? candidate.patch?.description ?? candidate.description;
    if (summary !== undefined) task.work.summary = summary.slice(0, 2048);
    if (isNativeWorkTerminal(task.work.status)) task.lifetime.abort();
    this.#observe(task);
  }
  async cancel(workId: string, signal: AbortSignal): Promise<void> {
    const task = this.#tasks.get(workId);
    if (!task || this.#lost || !this.#stream) throw error("native_work_owner_unavailable", "The native task cancellation owner is unavailable.");
    signal.throwIfAborted();
    await bounded(this.#stream.stopTask(task.work.native_reference));
    signal.throwIfAborted();
  }
  async #interrupt(root: Root): Promise<void> {
    if (this.#active !== root) return;
    // A root's SDK interrupt is narrower than its retained background interaction owner.
    // Native per-request signals cancel root callbacks; independently running children retain theirs.
    if (!this.#pending().some(task => task.root === root)) {root.lifetime.abort(); root.interactions.close();}
    try {await bounded(this.#stream!.interrupt()); await bounded(root.completion.then(() => undefined, () => undefined));
      if (this.#active === root) {this.#lose("transport_lost", error("native_interrupt_unknown", "Claude did not provide terminal interruption proof.")); await this.#process?.stop();}}
    catch (failure) {this.#lose("transport_lost", failure);}
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const stopping = this.#stop(); this.#stopping = stopping;
    void stopping.catch(() => {if (this.#stopping === stopping) this.#stopping = undefined;});
    return stopping;
  }
  async #stop(): Promise<void> {
    if (this.#unownedBackground()) throw error("native_work_closure_unknown", "The native background roster contains work without confirmed ownership; unload cannot be certified.");
    if (this.#stream && !this.#lost) for (const task of this.#pending()) {
      try {await bounded(this.#stream.stopTask(task.work.native_reference));} catch {break;}
    }
    for (const root of this.#roots) {root.lifetime.abort(); root.interactions.close();}
    this.#sessionLifetime.abort(); this.#sessionInputs.close();
    this.start.registerSessionInteractions?.(undefined);
    this.#channel.close(); this.#stream?.close(); await this.#process?.stop();
    if (this.#pump) await bounded(this.#pump);
    this.#lost = true;
    if (this.#unownedBackground()) throw error("native_work_closure_unknown", "Native background ownership remained unresolved during unload.");
  }
}
