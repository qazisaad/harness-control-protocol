import {createHash} from "node:crypto";
import {realpath} from "node:fs/promises";
import type {Options, Query, SDKUserMessage} from "@anthropic-ai/claude-agent-sdk";
import type {HarnessAdapterSession, HarnessAdapterTurnInput} from "../types.js";
import {HarnessAdapterError} from "../types.js";
import {NativeProcess} from "./native-process.js";
import {RuntimeProcessPool} from "./runtime-process-pool.js";
import type {ClaudeQueryFactory} from "./claude-runtime.js";

class InputQueue implements AsyncIterable<SDKUserMessage> {
  #value: SDKUserMessage | undefined;
  #waiting: ((value: IteratorResult<SDKUserMessage>) => void) | undefined;
  #closed = false;
  send(text: string): void {
    if (this.#closed || this.#value) throw new Error("Claude input queue is unavailable.");
    const value = {type: "user" as const, message: {role: "user" as const, content: text}, parent_tool_use_id: null};
    if (this.#waiting) {const resolve = this.#waiting; this.#waiting = undefined; resolve({done: false, value});}
    else this.#value = value;
  }
  close(): void {this.#closed = true; this.#value = undefined; this.#waiting?.({done: true, value: undefined}); this.#waiting = undefined;}
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {next: async () => {
      if (this.#value) {const value = this.#value; this.#value = undefined; return {done: false, value};}
      if (this.#closed) return {done: true, value: undefined};
      return new Promise(resolve => {this.#waiting = resolve;});
    }};
  }
}

/** A query carries history: it is reusable only by its original HCP session. */
export class ClaudeSessions {
  readonly #pool = new RuntimeProcessPool<ClaudeConversation>(async () => {throw new Error("Missing Claude launch settings");});
  readonly #bindings = new WeakMap<HarnessAdapterSession, string>();
  readonly #live = new Map<string, ClaudeConversation>();
  constructor(readonly queryFactory: ClaudeQueryFactory) {}

  async acquire(input: HarnessAdapterTurnInput, options: Options, signal: AbortSignal) {
    const id = input.payload.session_id;
    const binding = createHash("sha256").update(JSON.stringify({provider: input.provider,
      cwd: await realpath(input.startPayload.cwd), workspace: input.startPayload.workspace_id,
      policy: input.startPayload.approval_policy, sandbox: input.startPayload.sandbox_mode,
      instructions: options.systemPrompt, model: options.model, effort: options.effort, mcp: options.mcpServers, env: options.env})).digest("hex");
    const previous = this.#bindings.get(input.session);
    signal.throwIfAborted();
    if (previous && (previous !== binding || !this.#live.has(id))) {
      await this.stop(id);
      throw new HarnessAdapterError("claude_conversation_unavailable", "Claude conversation expired or its execution scope changed; start a new session.");
    }
    const lease = await this.#pool.acquire(`${id}:${binding}`, async () => {
      signal.throwIfAborted();
      const runtime = new ClaudeConversation();
      await runtime.start(this.queryFactory, options);
      this.#live.set(id, runtime);
      void runtime.process.closed.then(() => {if (this.#live.get(id) === runtime) this.#live.delete(id);});
      return runtime;
    });
    this.#bindings.set(input.session, binding);
    return lease;
  }
  async stop(id: string): Promise<void> {await this.#live.get(id)?.process.stop();}
  async close(): Promise<void> {await this.#pool.close();}
}

class ClaudeConversation {
  readonly inputs = new InputQueue();
  stream!: Query;
  #child: NativeProcess | undefined;
  readonly process: {closed: Promise<void>; stop(): Promise<void>};
  constructor() {
    let closed!: () => void;
    let stopping: Promise<void> | undefined;
    this.process = {closed: new Promise<void>(resolve => {closed = resolve;}), stop: () => {
      stopping ??= (async () => {
        this.inputs.close();
        let closeError: unknown;
        try {this.stream?.close();} catch (error) {closeError = error;}
        if (this.#child) await this.#child.stop();
        else if (closeError) throw closeError;
        closed();
      })();
      return stopping;
    }};
  }
  async start(factory: ClaudeQueryFactory, options: Options): Promise<void> {
    try {this.stream = factory({prompt: this.inputs, options: {...options, spawnClaudeCodeProcess: launch => {
      this.#child = new NativeProcess(launch.command, launch.args, options.cwd!, launch.env);
      this.#child.child.stderr.resume();
      void this.#child.closed.then(() => this.process.stop());
      return this.#child.child;
    }}});} catch (error) {await this.process.stop(); throw error;}
  }
}
