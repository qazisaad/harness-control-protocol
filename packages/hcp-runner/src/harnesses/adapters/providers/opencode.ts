import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { NativeProcess } from "./native-process.js";
import {fetchNativeResponse} from "./native-http.js";
import { NativeTurns } from "./native-turn.js";
import { NativeInteractions } from "../../native-interactions.js";
import {OpenCodeUsage, openCodeMessageId} from "./opencode-usage.js";
import {OpenCodeText} from "./opencode-text.js";
import {OpenCodeItems} from "./opencode-items.js";
import {projectOpenCodeCatalog} from "./opencode-models.js";
import {openCodeContext} from "./opencode-context.js";
import {prepareControlledOpenCode, controlledOpenCodeInheritance, controlledOpenCodeReference, readControlledOpenCodeReference, assertControlledOpenCodeInventory} from "./opencode-controlled.js";
import {verifyOpenCodeRequestOrigin} from "./opencode-request-binding.js";
import {unavailableContext} from "./native-context.js";
import {retainedContent, retainedFinalText, type ContentPublisher} from "./content-projection.js";

import { z } from "zod";
import type { HarnessExecutionCapabilities, HarnessModelSelection, HarnessUsageSnapshot } from "@harness-control/protocol";
import { hcpImageInputSchema } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../../../config/index.js";
import type { ProviderDriverStatus } from "../../../host/provider-registry.js";
import { HarnessAdapterError } from "../types.js";
import type {
  HarnessAdapter,
  HarnessAdapterCancelInput,
  HarnessAdapterEvent,
  HarnessAdapterSession,
  HarnessAdapterStartInput,
  HarnessAdapterStopInput,
  HarnessAdapterTurnInput,
  HarnessAdapterConversationInput,
} from "../types.js";
import {
  type CliProcessResult,
  firstLine,
  processFailureMessage,
  spawnProviderCliProcess,
} from "./cli-process.js";
import {
  adapterMcpServers,
  assertCliMcpAttachmentProxied,
  cliMcpServerConfigName,
  normalizeProviderModels,
  validateConfigurationInheritance,
  validateInstructionRoles,
} from "./shared.js";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SERVER_START_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_SETTLE_TIMEOUT_MS = 5_000;
const executionProfiles = [
  {id: "isolated", runtime_lifetime: "session", native_work: false, session_events: false},
  {id: "interactive", runtime_lifetime: "session", native_work: false, session_events: false},
] as const;

const executionCapabilities: HarnessExecutionCapabilities = {
  instruction_roles: ["system"],
  configuration_inheritance: {user_settings: true, project_settings: true, hooks: true, mcp_servers: true, plugins: true},
  streaming: true, multi_turn: true, session_continuation: true, plan_mode: true, manual_compaction: true, content_retrieval: true, context_usage: true,
  native_history: true, portable_history: true, history_pagination: true, conversation_fork: true, conversation_rollback: true,
  live_history_read: true,
  native_history_injection: false,
  sandbox_modes: ["danger_full_access"], approval_policies: ["ask", "auto_edits", "full_access"],
};

function supportedVersion(version: string | undefined): boolean {
  const match = version?.match(/^(?:opencode\s+)?1\.(\d+)\.(\d+)(?:[-+][^\s]+)?$/);
  return !!match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 15));
}
function controlledVersion(version: string | undefined): boolean {return /^(?:opencode\s+)?1\.18\.34$/.test(version ?? "");}
function nativeReference(runtime: OpenCodeRuntime): string {
  return runtime.ownedAccount ? controlledOpenCodeReference({session_id: runtime.sessionId, provider_id: runtime.ownedAccount.providerId,
    account_binding: runtime.ownedAccount.binding}) : runtime.sessionId;
}

function openCodeModels(provider: ProviderInstanceConfig) {
  return normalizeProviderModels(provider.models).map(model => ({...model,
    capabilities: {option_descriptors: model.capabilities.option_descriptors.filter(option => option.id === "variant"), image_input: true}}));
}

function validateTurnOptions(input: {action?: "prompt" | "compact"; mode?: "execute" | "plan"; images?: unknown[]; model_selection?: HarnessModelSelection}): void {
  const options = input.model_selection?.options ?? [];
  if (input.images?.some(image => !hcpImageInputSchema.safeParse(image).success))
    throw new HarnessAdapterError("image_input_invalid", "OpenCode requires valid bounded image inputs.");
  if (options.length > 1 || options.some(option => option.id !== "variant" || typeof option.value !== "string" || !option.value || option.value.length > 128))
    throw new HarnessAdapterError("unsupported_model_option", "OpenCode supports one string variant option.");
  if (input.model_selection && !parseModel(input.model_selection.model))
    throw new HarnessAdapterError("unsupported_model", "OpenCode requires a provider/model identifier.");
}

const sessionSchema = z.object({ id: z.string().min(1) }).passthrough();
const promptResponseSchema = z
  .object({
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).default([]),
  })
  .passthrough();
const eventSchema = z
  .object({
    type: z.string(),
    properties: z.record(z.string(), z.unknown()),
  })
  .passthrough();

type OpenCodeRuntimeStartInput = {
  interactive?: true;
  controlled?: {providerId: string; expectedAccountBinding?: string; ownershipRoot?: string};
  executable: string;
  launchArgs: string[];
  cwd: string;
  env: Record<string, string>;
  mcpServers: Record<string, { type: "remote"; url: string; enabled: true }>;
  nativeThreadId?: string;
  approvalPolicy?: "ask" | "auto_edits" | "full_access";
};

export type OpenCodeRuntimeTurnInput = {
  allowSessionPermissions?: true;
  turnId: string;
  input: string;
  model: string;
  systemInstructions?: string;
  emitEvent: (event: HarnessAdapterEvent) => void;
  signal?: AbortSignal;
  mode?: "execute" | "plan";
  action?: "prompt" | "compact";
  images?: import("@harness-control/protocol").HcpImageInput[];
  variant?: string;
  interactions?: NativeInteractions;
  publishContent?: ContentPublisher;
  onUsage?: (usage: HarnessUsageSnapshot) => void;
  onContext?: (context: import("@harness-control/protocol").HarnessContextUsage) => void;
  modelSelection?: HarnessModelSelection;
};

export type OpenCodeRuntime = {
  readonly sessionPermissions?: true;
  readonly ownedAccount?: {providerId: string; binding: string};
  readonly sessionId: string;
  sendTurn(input: OpenCodeRuntimeTurnInput): Promise<string>;
  cancelTurn(): Promise<void>;
  close(): Promise<void>;
  readHistory?(sessionId: string): Promise<unknown>;
  forkHistory?(beforeMessageId?: string): Promise<string>;
};

export type OpenCodeRuntimeFactory = (input: OpenCodeRuntimeStartInput) => Promise<OpenCodeRuntime>;

export type OpenCodeHarnessAdapterOptions = {
  controlledStorageRoot?: string;
  runtimeFactory?: OpenCodeRuntimeFactory;
  probeTimeoutMs?: number;
  modelCatalog?: (provider: ProviderInstanceConfig) => Promise<ReturnType<typeof projectOpenCodeCatalog>>;
};

export class OpenCodeHarnessAdapter implements HarnessAdapter {
  readonly executionProfiles = executionProfiles;
  readonly instructionRoles = ["system"] as const;
  readonly portableHistory = true;
  readonly liveHistoryRead = true;
  readonly configurationInheritance = executionCapabilities.configuration_inheritance!;
  readonly configurationInheritanceOptions = [controlledOpenCodeInheritance];
  readonly driverKind = "opencode";
  readonly conversationOperations = ["read", "rollback", "fork"] as const;

  readonly #runtimeFactory: OpenCodeRuntimeFactory;
  readonly #probeTimeoutMs: number;
  readonly #modelCatalog: NonNullable<OpenCodeHarnessAdapterOptions["modelCatalog"]>;
  readonly #controlledStorageRoot: string | undefined;
  readonly #runtimes = new Map<string, OpenCodeRuntime>();
  readonly #turns = new NativeTurns("opencode", 10 * 60_000);

  constructor(options: OpenCodeHarnessAdapterOptions = {}) {
    this.#runtimeFactory = options.runtimeFactory ?? startOpenCodeRuntime;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#modelCatalog = options.modelCatalog ?? openCodeModelCatalog;
    this.#controlledStorageRoot = options.controlledStorageRoot;
  }

  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    const executable: string = provider.executable_path ?? "opencode";
    const result: CliProcessResult = await runProbe(executable, [...provider.launch_args, "--version"], provider, this.#probeTimeoutMs);
    const version: string | undefined = firstLine(result.stdout);
    if (result.timedOut || result.error || result.exitCode !== 0) {
      return {
        provider_instance_id: provider.id,
        driver_kind: this.driverKind,
        installed: false,
        available: false,
        status: "unavailable",
        message: result.timedOut
          ? "OpenCode version probe timed out."
          : processFailureMessage(
              result,
              "OpenCode executable is not available.",
              provider.home ? [executable, provider.home] : [executable],
            ),
        models: openCodeModels(provider),
      };
    }
    let models: import("@harness-control/protocol").HarnessModel[] = openCodeModels(provider);
    let catalogUnavailable = false;
    if (supportedVersion(version) && !models.length) {
      try {models = (await this.#modelCatalog(provider)).models;} catch {catalogUnavailable = true;}
    }
    return {
      provider_instance_id: provider.id,
      driver_kind: this.driverKind,
      installed: true,
      available: supportedVersion(version),
      status: supportedVersion(version) ? "ready" : "unavailable",
      ...(supportedVersion(version) ? {execution_capabilities: {...executionCapabilities,
        ...(controlledVersion(version) ? {configuration_inheritance_options: [...this.configurationInheritanceOptions], execution_profiles: [...executionProfiles]} : {})}} :
        {message: "This OpenCode adapter requires the 1.3.15+ HTTP/SSE contract within major version 1."}),
      ...(version ? { version } : {}),
      models,
      ...(catalogUnavailable ? {message: "OpenCode is installed; its native model catalog is unavailable."} : {}),
    };
  }

  async validateStart(input: HarnessAdapterStartInput): Promise<void> {
    validateConfigurationInheritance(input.payload, this.configurationInheritance, this.configurationInheritanceOptions);
    validateInstructionRoles(input.payload, this.instructionRoles);
    if (input.payload.sandbox_mode !== "danger_full_access")
      throw new HarnessAdapterError("sandbox_unsupported", "This OpenCode adapter does not implement filesystem containment.");
    if (input.payload.continue_session && !input.payload.continuation_group_key)
      throw new HarnessAdapterError("continuation_key_required", "OpenCode continuation requires its retained conversation key.");
    validateTurnOptions({model_selection: input.payload.model_selection});
    if (input.payload.first_turn) validateTurnOptions(input.payload.first_turn);
  }

  async conversationOperation(input: HarnessAdapterConversationInput) {
    if (!input.conversation.approval_policy)
      throw new HarnessAdapterError("native_policy_unknown", "Resume this retained conversation to establish its authorized permission policy before reading or changing it.");
    const controlled = readControlledOpenCodeReference(input.conversation.native_thread_id);
    const runtime = await this.#runtimeFactory({executable: input.provider.executable_path ?? "opencode",
      launchArgs: input.provider.launch_args, cwd: input.conversation.cwd, env: providerEnvironment(input.provider),
      mcpServers: {}, nativeThreadId: controlled?.session_id ?? input.conversation.native_thread_id, approvalPolicy: input.conversation.approval_policy,
      ...(controlled ? {controlled: {providerId: controlled.provider_id, expectedAccountBinding: controlled.account_binding,
        ...(this.#controlledStorageRoot ? {ownershipRoot: this.#controlledStorageRoot} : {})}} : {})});
    try {
      if (controlled) {
        const {controlledOpenCodeConversation} = await import("./opencode-controlled-conversation.js");
        return await controlledOpenCodeConversation(input, runtime);
      }
      const {openCodeConversation} = await import("./opencode-conversation.js");
      return await openCodeConversation(input, runtime);
    } finally {await runtime.close();}
  }

  async startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
    await this.validateStart(input);
    if (input.payload.continue_session && !input.nativeConversation)
      throw new HarnessAdapterError("native_continuation_binding", "OpenCode resume requires the runner-authorized retained binding.");
    if (this.#runtimes.has(input.payload.session_id)) {
      throw new HarnessAdapterError("opencode_session_exists", `OpenCode session '${input.payload.session_id}' already exists.`);
    }
    const mcpServers: Record<string, { type: "remote"; url: string; enabled: true }> = {};
    const inheritance = validateConfigurationInheritance(input.payload, this.configurationInheritance, this.configurationInheritanceOptions);
    const controlled = inheritance?.user_settings === false;
    const retained = input.nativeConversation ? readControlledOpenCodeReference(input.nativeConversation.native_thread_id) : undefined;
    const model = parseModel(input.payload.model_selection.model)!;
    if (retained && (!controlled || retained.provider_id !== model.providerID) || controlled && input.nativeConversation && !retained)
      throw new HarnessAdapterError("native_continuation_binding", "Resume must preserve the controlled native provider and configuration owner.");
    for (const attachment of adapterMcpServers(input.mcpServers, input.payload)) {
      assertCliMcpAttachmentProxied(attachment, "OpenCode", "opencode");
      const name: string = cliMcpServerConfigName(attachment.name, "opencode");
      mcpServers[name] = { type: "remote", url: attachment.url, enabled: true };
    }
    const runtime: OpenCodeRuntime = await this.#runtimeFactory({
      executable: input.provider.executable_path ?? "opencode",
      launchArgs: input.provider.launch_args,
      cwd: input.payload.cwd,
      env: providerEnvironment(input.provider),
      mcpServers,
      ...(input.payload.execution_profile === "interactive" ? {interactive: true} : {}),
      ...(input.nativeConversation ? {nativeThreadId: retained?.session_id ?? input.nativeConversation.native_thread_id} : {}),
      ...(controlled ? {controlled: {providerId: model.providerID, ...(retained ? {expectedAccountBinding: retained.account_binding} : {}),
        ...(this.#controlledStorageRoot ? {ownershipRoot: this.#controlledStorageRoot} : {})}} : {}),
      approvalPolicy: input.payload.approval_policy,
    });
    if (controlled && (!runtime.ownedAccount || runtime.ownedAccount.providerId !== model.providerID)) {
      await runtime.close(); throw new HarnessAdapterError("native_configuration_mismatch", "The runtime did not establish the requested controlled owner.");
    }
    if (input.payload.execution_profile === "interactive" && !runtime.sessionPermissions) {
      await runtime.close(); throw new HarnessAdapterError("native_profile_mismatch", "The native runtime did not confirm interactive permission ownership.");
    }
    this.#runtimes.set(input.payload.session_id, runtime);
    return { adapter_session_id: runtime.sessionId, native_thread_id: nativeReference(runtime) };
  }

  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    validateTurnOptions(input.payload);
    const runtime: OpenCodeRuntime = this.#requireRuntime(input.payload.session_id);
    if (input.session.native_thread_id !== nativeReference(runtime))
      throw new HarnessAdapterError("native_continuation_binding", "The OpenCode runtime does not own this conversation.");
    if (runtime.ownedAccount && parseModel((input.payload.model_selection ?? input.startPayload.model_selection).model)?.providerID !== runtime.ownedAccount.providerId)
      throw new HarnessAdapterError("native_account_selection_unsupported", "A controlled conversation cannot switch to another native provider account.");
    input.persistNativeThread?.(nativeReference(runtime));
    if (input.persistNativeThread) input.emitEvent?.({event_type: "session.configured", data: {native_conversation_ready: true}});
    return this.#turns.run(input, async (_input, signal, emit) => {
      const interactions = new NativeInteractions(input.startPayload, input.payload, {threadId: runtime.sessionId, turnId: () => input.payload.turn_id}, emit);
      input.registerNativeInteractions?.(interactions);
      let cancellation: Promise<void> | undefined;
      const abort = () => {cancellation = runtime.cancelTurn().catch(async () => {await runtime.close();});};
      signal.addEventListener("abort", abort, {once: true});
      try {
      let usage: HarnessUsageSnapshot | undefined;
      const selection = input.payload.model_selection ?? input.startPayload.model_selection;
      let context = unavailableContext(selection, input.payload.action === "compact" ? "compaction_started" : "request_started");
      emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: context});
      const finalText = await runtime.sendTurn({
        turnId: input.payload.turn_id,
        ...(runtime.sessionPermissions ? {allowSessionPermissions: true} : {}),
        input: input.payload.input,
        model: input.payload.model_selection?.model ?? input.startPayload.model_selection.model,
        ...(input.startPayload.instructions?.system ? {systemInstructions: input.startPayload.instructions.system} : {}),
        emitEvent: emit, signal, interactions,
        onUsage: value => {usage = value; emit({event_type: "usage.updated", turn_id: input.payload.turn_id, data: {...value}});},
        modelSelection: selection,
        onContext: value => {context = value; emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: value});},
        ...(input.publishContent ? {publishContent: input.publishContent} : {}),
        ...(input.payload.mode ? {mode: input.payload.mode} : {}),
        ...(input.payload.action ? {action: input.payload.action} : {}),
        ...(input.payload.images ? {images: input.payload.images} : {}),
        ...((input.payload.model_selection ?? input.startPayload.model_selection).options?.[0] ?
          {variant: String((input.payload.model_selection ?? input.startPayload.model_selection).options![0]!.value)} : {}),
      });
      return {...retainedFinalText(finalText, input.publishContent), ...(usage ? {usage} : {}), context};
      } finally {
        interactions.close(); input.registerNativeInteractions?.(undefined);
        signal.removeEventListener("abort", abort);
        await cancellation;
      }
    });
  }

  async cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]> {
    return this.#turns.cancel(input.sessionId, input.turnId);
  }

  async stopSession(input: HarnessAdapterStopInput): Promise<HarnessAdapterEvent[]> {
    const runtime: OpenCodeRuntime | undefined = this.#runtimes.get(input.sessionId);
    if (!runtime) {
      return [];
    }
    await this.#turns.stop(input.sessionId);
    this.#runtimes.delete(input.sessionId);
    await runtime.close();
    return [];
  }

  #requireRuntime(sessionId: string): OpenCodeRuntime {
    const runtime: OpenCodeRuntime | undefined = this.#runtimes.get(sessionId);
    if (!runtime) {
      throw new HarnessAdapterError("opencode_session_not_found", `OpenCode session '${sessionId}' is not active.`);
    }
    return runtime;
  }
}

async function runProbe(
  executable: string,
  args: string[],
  provider: Pick<ProviderInstanceConfig, "env" | "home">,
  timeoutMs: number,
): Promise<CliProcessResult> {
  const handle = spawnProviderCliProcess(executable, args, { cwd: process.cwd(), env: providerEnvironment(provider) });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut: Promise<CliProcessResult> = new Promise<CliProcessResult>((resolve) => {
    timeout = setTimeout((): void => {
      handle.kill("SIGKILL");
      resolve({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", error: undefined, timedOut: true });
    }, timeoutMs);
  });
  const result: CliProcessResult = await Promise.race([handle.result, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function openCodeModelCatalog(provider: ProviderInstanceConfig): Promise<ReturnType<typeof projectOpenCodeCatalog>> {
  const cwd = process.cwd();
  const runtime = new NativeProcess(provider.executable_path ?? "opencode",
    [...provider.launch_args, "serve", "--hostname=127.0.0.1", "--port=0"], cwd,
    {...process.env, ...providerEnvironment(provider)});
  runtime.child.stdin.end();
  try {
    const baseUrl = await waitForServerUrl(runtime.child, DEFAULT_SERVER_START_TIMEOUT_MS);
    return projectOpenCodeCatalog(await fetchJson(new URL(`/provider?directory=${encodeURIComponent(cwd)}`, baseUrl), {method: "GET"}));
  } finally {await runtime.stop();}
}

async function startOpenCodeRuntime(input: OpenCodeRuntimeStartInput): Promise<OpenCodeRuntime> {
  // Check at launch too: a cached capability snapshot cannot authorize another runtime version.
  const probe = await runProbe(input.executable, [...input.launchArgs, "--version"],
    {env: input.env}, DEFAULT_PROBE_TIMEOUT_MS);
  if (probe.timedOut || probe.error || probe.exitCode !== 0 || !supportedVersion(firstLine(probe.stdout)))
    throw new HarnessAdapterError("provider_version_unsupported", "A readable OpenCode 1.3.15+ runtime within major version 1 is required before launch.");
  if ((input.controlled || input.interactive) && !controlledVersion(firstLine(probe.stdout)))
    throw new HarnessAdapterError("configuration_isolation_unsupported", "Controlled configuration and interactive permissions require the verified OpenCode 1.18.34 runtime.");
  const controlled = input.controlled ? await prepareControlledOpenCode({env: {...process.env, ...input.env}, cwd: input.cwd,
    providerId: input.controlled.providerId,
    ...(input.controlled.expectedAccountBinding ? {expectedAccountBinding: input.controlled.expectedAccountBinding} : {}),
    ...(input.controlled.ownershipRoot ? {ownershipRoot: input.controlled.ownershipRoot} : {}), mcpServers: input.mcpServers}) : undefined;
  const config: Record<string, unknown> = Object.keys(input.mcpServers).length > 0 ? { mcp: input.mcpServers } : {};
  let processHandle: NativeProcess;
  try {processHandle = new NativeProcess(
    input.executable,
    [...input.launchArgs, "serve", "--hostname=127.0.0.1", "--port=0"],
    input.cwd,
    controlled?.env ?? { ...process.env, ...input.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  );} catch (failure) {await controlled?.cleanup(); throw failure;}
  const child = processHandle.child;
  try {
    child.stdin.end();
    const baseUrl: string = await waitForServerUrl(child, DEFAULT_SERVER_START_TIMEOUT_MS);
    if (input.controlled) assertControlledOpenCodeInventory(await fetchJson(
      new URL(`/config?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}), input.controlled.providerId, input.mcpServers);
    const owner = controlled && input.controlled ? {providerId: input.controlled.providerId, binding: controlled.accountBinding} : undefined;
    if (input.nativeThreadId) {
      const retained = z.object({id: z.string(), directory: z.string(), permission: z.array(z.object({permission: z.string(), pattern: z.string(), action: z.enum(["allow", "ask", "deny"])}))}).parse(await fetchJson(
        new URL(`/session/${encodeURIComponent(input.nativeThreadId)}?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}));
      if (retained.id !== input.nativeThreadId || await realpath(retained.directory) !== await realpath(input.cwd))
        throw new HarnessAdapterError("native_continuation_binding", "OpenCode retained history belongs to another directory or conversation.");
      if (!input.approvalPolicy || JSON.stringify(retained.permission) !== JSON.stringify(permissionRules(input.approvalPolicy)))
        throw new HarnessAdapterError("native_policy_mismatch", "OpenCode retained permissions differ from the runner-authorized policy.");
      return new HttpOpenCodeRuntime(processHandle, baseUrl, input.cwd, retained.id, input.approvalPolicy, owner, controlled?.cleanup, input.interactive);
    }
    const session: z.infer<typeof sessionSchema> = sessionSchema.parse(
      await fetchJson(new URL(`/session?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "HCP session", permission: permissionRules(input.approvalPolicy ?? "ask") }),
      }),
    );
    return new HttpOpenCodeRuntime(processHandle, baseUrl, input.cwd, session.id, input.approvalPolicy ?? "ask", owner, controlled?.cleanup, input.interactive);
  } catch (error: unknown) {
    await processHandle.stop();
    await controlled?.cleanup();
    throw error;
  }
}

function permissionRules(policy: "ask" | "auto_edits" | "full_access") {
  return [
    {permission: "*", pattern: "*", action: policy === "full_access" ? "allow" : "ask"},
    ...(policy === "auto_edits" ? [{permission: "edit", pattern: "*", action: "allow"}] : []),
    {permission: "question", pattern: "*", action: policy === "full_access" ? "deny" : "allow"},
    {permission: "task", pattern: "*", action: "deny"},
  ];
}

class HttpOpenCodeRuntime implements OpenCodeRuntime {
  readonly sessionPermissions?: true;
  readonly #process: NativeProcess;
  readonly #baseUrl: string;
  readonly #cwd: string;
  readonly #approvalPolicy: "ask" | "auto_edits" | "full_access";
  readonly sessionId: string;
  readonly ownedAccount?: {providerId: string; binding: string};
  readonly #cleanup: (() => Promise<void>) | undefined;
  #closed = false;
  #activeRequest: AbortController | undefined;

  constructor(
    processHandle: NativeProcess,
    baseUrl: string,
    cwd: string,
    sessionId: string,
    approvalPolicy: "ask" | "auto_edits" | "full_access",
    owner?: {providerId: string; binding: string},
    cleanup?: () => Promise<void>,
    interactive?: true,
  ) {
    this.#process = processHandle;
    this.#baseUrl = baseUrl;
    this.#cwd = cwd;
    this.sessionId = sessionId;
    this.#approvalPolicy = approvalPolicy;
    if (owner) this.ownedAccount = owner;
    if (interactive) this.sessionPermissions = true;
    this.#cleanup = cleanup;
    void processHandle.closed.then(() => {this.#closed = true; this.#activeRequest?.abort();});
  }

  async sendTurn(input: OpenCodeRuntimeTurnInput): Promise<string> {
    if (this.#closed) throw new HarnessAdapterError("native_session_unavailable", "This native owner closed; unload it before resuming the retained conversation.");
    if (this.#activeRequest) {
      throw new Error(`OpenCode session '${this.sessionId}' already has an active HTTP request.`);
    }
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    input.signal?.addEventListener("abort", abort, {once: true});
    if (input.signal?.aborted) abort();
    this.#activeRequest = abortController;
    const messageId = openCodeMessageId();
    const usage = new OpenCodeUsage(this.sessionId, messageId);
    const streamReady = createEventStream(
      new URL(`/event?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
      this.sessionId,
      input,
      abortController.signal,
      this.#baseUrl,
      this.#cwd,
      usage,
    );
    try {
      await streamReady.ready;
      const model = parseModel(input.model);
      if (input.action === "compact") {
        if (!model) throw new HarnessAdapterError("unsupported_model", "Compaction requires a provider/model identifier.");
        const outcome = await fetchJson(new URL(`/session/${encodeURIComponent(this.sessionId)}/summarize?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {
          method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({...model, auto: false}), signal: abortController.signal});
        if (outcome !== true) throw new HarnessAdapterError("native_compaction_unknown", "OpenCode did not confirm compaction completion.");
        return "";
      }
      const response: z.infer<typeof promptResponseSchema> = promptResponseSchema.parse(
        await Promise.race([fetchJson(
          new URL(`/session/${encodeURIComponent(this.sessionId)}/message?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messageID: messageId,
              ...(input.systemInstructions ? {system: input.systemInstructions} : {}),
              parts: [{ type: "text", text: input.input }, ...(input.images ?? []).map(image => ({type: "file", mime: image.mime_type,
                url: `data:${image.mime_type};base64,${image.data_base64}`}))],
              agent: input.mode === "plan" ? "plan" : "build",
              ...(input.variant ? {variant: input.variant} : {}),
              ...(model ? { model } : {}),
            }),
            signal: abortController.signal,
          },
        ), streamReady.settled.then(() => new Promise<never>(() => {}))]),
      );
      await waitWithTimeout(streamReady.settled, DEFAULT_EVENT_SETTLE_TIMEOUT_MS, "OpenCode did not emit session.idle.");
      if (input.systemInstructions) {
        const user = z.object({info: z.object({id: z.string(), sessionID: z.string(), role: z.literal("user"), system: z.string()})}).parse(await fetchJson(
          new URL(`/session/${encodeURIComponent(this.sessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
          {method: "GET", signal: abortController.signal}));
        if (user.info.id !== messageId || user.info.sessionID !== this.sessionId || user.info.system !== input.systemInstructions)
          throw new HarnessAdapterError("native_instruction_mismatch", "OpenCode did not confirm the admitted system instructions on this prompt.");
      }
      usage.message(response.info);
      for (const part of response.parts) usage.part(part);
      const measured = usage.snapshot();
      if (measured) input.onUsage?.(measured);
      let capacities: Map<string, number> | undefined;
      try {
        capacities = projectOpenCodeCatalog(await fetchJson(new URL(`/provider?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
          {method: "GET", signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(5_000)])})).capacities;
      } catch { /* A catalog failure cannot turn measured request counters into guessed capacity. */ }
      input.onContext?.(openCodeContext(response.info, this.sessionId, messageId,
        input.modelSelection ?? {model: input.model, ...(input.variant ? {options: [{id: "variant", value: input.variant}]} : {})}, capacities));
      return response.parts
        .filter((part): boolean => part.type === "text" && part.text !== undefined)
        .map((part): string => part.text ?? "")
        .join("");
    } catch (failure) {
      // An unconfirmed reply may already have installed a volatile native grant.
      // Close its owner so later turns cannot inherit uncertain authority.
      if (failure instanceof HarnessAdapterError && ["native_reply_unknown","native_request_origin_unconfirmed"].includes(failure.code)) await this.close();
      throw failure;
    } finally {
      abortController.abort();
      input.signal?.removeEventListener("abort", abort);
      await streamReady.completed;
      this.#activeRequest = undefined;
    }
  }

  async readHistory(sessionId: string): Promise<unknown> {
    const scope = z.object({id: z.string(), directory: z.string(), permission: z.array(z.json())}).passthrough().parse(await fetchJson(
      new URL(`/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {method: "GET"}));
    if (scope.id !== sessionId || await realpath(scope.directory) !== await realpath(this.#cwd))
      throw new HarnessAdapterError("native_history_binding", "OpenCode history has another directory or conversation.");
    this.#verifyPermissions(scope.permission);
    return await fetchJson(new URL(`/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {method: "GET"});
  }

  async forkHistory(beforeMessageId?: string): Promise<string> {
    const source = z.object({permission: z.array(z.record(z.string(), z.json()))}).parse(await fetchJson(
      new URL(`/session/${encodeURIComponent(this.sessionId)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {method: "GET"}));
    this.#verifyPermissions(source.permission);
    const target = sessionSchema.parse(await fetchJson(new URL(`/session/${encodeURIComponent(this.sessionId)}/fork?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(beforeMessageId ? {messageID: beforeMessageId} : {})}));
    if (target.id === this.sessionId) throw new HarnessAdapterError("native_fork_unknown", "OpenCode returned the source instead of an independent fork.");
    const configured = z.object({id: z.string(), permission: z.array(z.record(z.string(), z.json()))}).parse(await fetchJson(
      new URL(`/session/${encodeURIComponent(target.id)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {
        method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({permission: source.permission})}));
    if (configured.id !== target.id || JSON.stringify(configured.permission) !== JSON.stringify(source.permission))
      throw new HarnessAdapterError("native_fork_unknown", "OpenCode did not confirm the original permission rules on its fork.");
    return target.id;
  }

  async cancelTurn(): Promise<void> {
    this.#activeRequest?.abort();
    const outcome = await fetchJson(new URL(`/session/${encodeURIComponent(this.sessionId)}/abort?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {
      method: "POST",
    });
    if (outcome !== true) throw new HarnessAdapterError("native_cancel_unknown", "OpenCode did not acknowledge session cancellation.");
  }

  #verifyPermissions(actual: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(permissionRules(this.#approvalPolicy)))
      throw new HarnessAdapterError("native_policy_mismatch", "OpenCode retained permissions differ from the runner-authorized policy.");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#activeRequest?.abort();
    await this.#process.stop();
    await this.#cleanup?.();
  }
}

type OpenCodeEventStream = { ready: Promise<void>; settled: Promise<void>; completed: Promise<void> };

function createEventStream(
  url: URL,
  sessionId: string,
  input: OpenCodeRuntimeTurnInput,
  signal: AbortSignal,
  baseUrl: string,
  cwd: string,
  usage: OpenCodeUsage,
): OpenCodeEventStream {
  let markReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  let markSettled: () => void = () => {};
  let rejectSettled: (error: Error) => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    markSettled = resolve;
    rejectSettled = reject;
  });
  void settled.catch(() => {});
  const requests = new Set<string>();
  const responses: Promise<void>[] = [];
  const text = new OpenCodeText(sessionId, usage.promptId, input.turnId, input.emitEvent);
  const items = new OpenCodeItems(sessionId, input.turnId, id => text.ownsMessage(id), input.emitEvent, input.publishContent);
  const completed: Promise<void> = (async (): Promise<void> => {
    try {
      const response: Response = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream failed with HTTP ${response.status}.`);
      }
      markReady();
      await consumeSse(response.body, (value: unknown): void => {
        const event = eventSchema.parse(value);
        usage.observe(event);
        text.observe(event);
        items.observe(event);
        if ((event.type === "permission.asked" || event.type === "question.asked") && event.properties.sessionID === sessionId) {
          const id = z.string().min(1).parse(event.properties.id);
          if (requests.has(id)) return;
          if (requests.size >= 128) throw new HarnessAdapterError("native_request_limit", "OpenCode exceeded its native interaction limit.");
          requests.add(id);
          const owner = input.interactions;
          if (!owner) throw new HarnessAdapterError("native_request_unavailable", "A native request requires its HCP owner.");
          const binding = {threadId: sessionId, turnId: input.turnId, itemId: id};
          const respond = async () => {
            await verifyOpenCodeRequestOrigin(event.properties, sessionId, usage.promptId, messageId => fetchJson(
              new URL(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(cwd)}`,baseUrl),
              {method:"GET",signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])}));
            let path: string, body: unknown;
            if (event.type === "permission.asked") {
              const permission = z.string().parse(event.properties.permission);
              const type = permission === "bash" ? "command" : permission === "read" ? "file_read" : permission === "edit" ? "file_change" : "other";
              const remembered = input.allowSessionPermissions && z.array(z.string().min(1).max(4096)).min(1).max(128).safeParse(event.properties.always).success;
              const result = await owner.approval({...event.properties, ...binding,
                availableDecisions: ["accept", ...(remembered ? ["accept_for_session"] : []), "decline"]}, type, signal);
              path = `/permission/${encodeURIComponent(id)}/reply`; body = {reply: result.decision === "accept_for_session" ? "always" : result.decision === "accept" ? "once" : "reject"};
            } else {
              const questions = z.array(z.object({question: z.string(), header: z.string(), options: z.array(z.object({label: z.string(), description: z.string()})),
                multiple: z.boolean().optional(), custom: z.boolean().optional()})).parse(event.properties.questions);
              const result = z.object({answers: z.record(z.string(), z.object({answers: z.array(z.string())}))}).parse(await owner.questions({...binding,
                questions: questions.map((question, index) => ({...question, id: `question-${index}`, isOther: question.custom !== false, multiSelect: question.multiple ?? false}))}, signal));
              const cancelled = !Object.keys(result.answers).length;
              path = `/question/${encodeURIComponent(id)}/${cancelled ? "reject" : "reply"}`;
              body = cancelled ? {} : {answers: questions.map((_question, index) => result.answers[`question-${index}`]!.answers)};
            }
            try {
              const outcome = await fetchJson(new URL(`${path}?directory=${encodeURIComponent(cwd)}`, baseUrl), {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal});
              if (outcome !== true) throw new Error("Unconfirmed native reply");
            } catch {throw new HarnessAdapterError("native_reply_unknown", "OpenCode did not acknowledge the native interaction reply; its execution outcome is unknown.");}
          };
          const response = respond(); responses.push(response);
          void response.catch(error => rejectSettled(error instanceof Error ? error : new Error("Native response failed.")));
          return;
        }
        const outcome: OpenCodeEventOutcome = emitOpenCodeEvent(value, sessionId, input);
        if (outcome === "settled") void Promise.all(responses).then(markSettled, rejectSettled);
        if (outcome instanceof Error) rejectSettled(outcome);
      });
    } catch (error: unknown) {
      if (!signal.aborted) {
        const normalized: Error = error instanceof Error ? error : new Error("OpenCode event stream failed.");
        rejectReady(normalized);
        rejectSettled(normalized);
        throw normalized;
      }
      markReady();
    }
  })();
  return { ready, settled, completed };
}

async function consumeSse(stream: ReadableStream<Uint8Array>, onData: (value: unknown) => void): Promise<void> {
  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (result.done) break;
    buffered += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    if (Buffer.byteLength(buffered) > 8 * 1024 * 1024) throw new HarnessAdapterError("opencode_protocol_error", "OpenCode emitted an oversized SSE frame.");
    let boundary: number;
    while ((boundary = buffered.indexOf("\n\n")) >= 0) {
      const block: string = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data: string = block
        .split("\n")
        .filter((line): boolean => line.startsWith("data:"))
        .map((line): string => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) onData(JSON.parse(data) as unknown);
    }
  }
}

type OpenCodeEventOutcome = "continue" | "settled" | Error;

function emitOpenCodeEvent(value: unknown, sessionId: string, input: OpenCodeRuntimeTurnInput): OpenCodeEventOutcome {
  const event: z.infer<typeof eventSchema> = eventSchema.parse(value);
  if (event.type === "session.idle") {
    return event.properties.sessionID === sessionId ? "settled" : "continue";
  }
  if (event.type === "session.error" && (event.properties.sessionID === undefined || event.properties.sessionID === sessionId)) {
    return new Error("OpenCode reported a session error.");
  }
  if (event.type === "todo.updated" && event.properties.sessionID === sessionId) {
    input.emitEvent({event_type: "turn.plan.updated", turn_id: input.turnId, data: {plan: retainedContent(event.properties.todos, input.publishContent)}});
    return "continue";
  }
  return "continue";
}

async function fetchJson(url: URL, init: RequestInit): Promise<unknown> {
  const response: Response = await fetchNativeResponse(url, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new HarnessAdapterError("native_http_error", `OpenCode request failed with HTTP ${response.status}.`);
  }
  if (!response.body) throw new HarnessAdapterError("native_http_invalid", "OpenCode returned no JSON body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8 * 1024 * 1024) throw new HarnessAdapterError("native_http_limit", "OpenCode response exceeds the bounded 8 MiB limit.");
      chunks.push(chunk.value);
    }
    try {return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
    catch {throw new HarnessAdapterError("native_http_invalid", "OpenCode returned invalid JSON.");}
  } finally {await reader.cancel(); reader.releaseLock();}
}

function waitForServerUrl(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout: ReturnType<typeof setTimeout> = setTimeout((): void => {
      settleError(new Error(`Timed out waiting ${timeoutMs}ms for OpenCode server startup.`));
    }, timeoutMs);
    const settleError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminateProcess(child);
      reject(error);
    };
    const inspect = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString("utf8");
      const match: RegExpMatchArray | null = output.match(/opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/i);
      if (!match?.[1]) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", settleError);
    child.once("exit", (code: number | null): void => {
      settleError(new Error(`OpenCode server exited before startup with code ${code ?? "unknown"}.`));
    });
  });
}

function terminateProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
    }
  }
  child.kill("SIGTERM");
}

function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const separator: number = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function providerEnvironment(provider: Pick<ProviderInstanceConfig, "env" | "home">): Record<string, string> {
  return { ...(provider.home ? { HOME: provider.home } : {}), ...provider.env };
}

async function waitWithTimeout(completion: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((_resolve, reject) => {
    timeout = setTimeout((): void => reject(new Error(message)), timeoutMs);
  });
  try {
    await Promise.race([completion, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
