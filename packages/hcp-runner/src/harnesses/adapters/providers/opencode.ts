import {HARNESS_CONTENT_MAX_BYTES, HARNESS_OWNED_IMAGE_MAX_BYTES, HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES, HARNESS_OWNED_IMAGE_MAX_COUNT, HARNESS_OWNED_IMAGE_MIME_TYPES} from "@harness-control/protocol";
import {nativeTurnImages, validateNativeImageValues} from "./native-images.js";
import {nativePlanObservation} from "./native-plan.js";
import {openCodeOwnedPolicyServer} from "./opencode-owned-policy-server.js";
import {openCodeOwnedPolicyPlugin, openCodeInstalledChildRules, type OpenCodePolicyPrompt} from "./opencode-child-policy.js";
import {openCodeRootTerminal} from "./opencode-root-terminal.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {isDeepStrictEqual} from "node:util";
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
import {openCodeEffectiveOptions, assertOpenCodeModelOptions, assertAnonymousOpenCodeModel} from "./opencode-options.js";
import {prepareControlledOpenCode, controlledOpenCodeInheritance, controlledOpenCodeReference, readControlledOpenCodeReference, assertControlledOpenCodeInventory, openCodeAgentPermission, assertOpenCodeAgentPermission} from "./opencode-controlled.js";
import {respondOpenCodeInteraction} from "./opencode-interactions.js";
import {consumeNativeSse} from "./native-sse.js";
import {NativeEventOwner} from "./native-event-owner.js";
import {OpenCodeOwnedWork} from "./opencode-work.js";
import {openCodeChildHistoryView} from "./opencode-child-history.js";
import {OpenCodeWorkCallbacks} from "./opencode-work-callbacks.js";
import {OpenCodeOwnedMcp, openCodeOwnedMcpDefinitions} from "./opencode-owned-mcp.js";
import {openCodeOwnedToolPlugin} from "./opencode-owned-tools.js";
import {openCodeOwnedToolServer} from "./opencode-owned-tool-server.js";
import {readOpenCodeOwnedHistory} from "./opencode-conversation.js";
import {permissionRules, assertOpenCodeSessionPolicy, type OpenCodePolicy, openCodePermissionNames, openCodeOrderedRules} from "./opencode-policy.js";
import {unavailableContext} from "./native-context.js";
import {retainedContent, retainedFinalText, type ContentPublisher} from "./content-projection.js";

import { z } from "zod";
import type { HarnessExecutionCapabilities, HarnessModelSelection, HarnessUsageSnapshot } from "@harness-control/protocol";
import { hcpImageInputSchema, type HarnessApprovalOptions, type HarnessPermissionRules } from "@harness-control/protocol";

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

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_SERVER_START_TIMEOUT_MS = 30_000;
const DEFAULT_EVENT_SETTLE_TIMEOUT_MS = 5_000;
const executionProfiles = [
  {id: "isolated", runtime_lifetime: "session", native_work: false, session_events: false},
  {id: "interactive", runtime_lifetime: "session", native_work: false, session_events: false, mcp_attachments: true, native_owner_closure: "owned_session" as const, root_interrupt_effect: "owned_work",
    native_plan_observations: ["snapshot"] as Array<"snapshot">, empty_conversation: true, idle_configuration_transition: true, idle_mcp_catalog_transition: true, root_settings_readback: true,
    native_permission_rules: {scope: "root", matching: "ordered_glob", permissions: Array.from(openCodePermissionNames)}},
  {id: "background", runtime_lifetime: "session", native_work: true, session_events: true, root_interrupt_effect: "owned_work",
    required_configuration_inheritance: controlledOpenCodeInheritance, mcp_attachments: true, native_owner_closure: "owned_session" as const, native_work_history: "live_owner",
    native_plan_observations: ["snapshot"] as Array<"snapshot">, retained_native_work_history: true, native_work_fork: true, root_settings_readback: true,
    native_permission_rules: {scope: "root_and_children", matching: "ordered_glob", permissions: Array.from(openCodePermissionNames)}},
] as const;

const executionCapabilities: HarnessExecutionCapabilities = {
  instruction_roles: ["system"],
  configuration_inheritance: {user_settings: true, project_settings: true, hooks: true, mcp_servers: true, plugins: true},
  file_inputs: {delivery: ["file_context"], max_bytes: 50 * 1024 * 1024, max_files: 100},
    owned_image_inputs: {max_bytes: HARNESS_OWNED_IMAGE_MAX_BYTES, max_images: HARNESS_OWNED_IMAGE_MAX_COUNT,
      max_total_bytes: HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES, mime_types: [...HARNESS_OWNED_IMAGE_MIME_TYPES]},
    prompt_context: true,
  streaming: true, multi_turn: true, session_continuation: true, plan_mode: true, manual_compaction: true, content_retrieval: true, context_usage: true,
  native_history: true, empty_conversation: true, portable_history: true, history_pagination: true, conversation_fork: true, conversation_rollback: true,
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
    account_binding: runtime.ownedAccount.binding, ...(runtime.backgroundPermissions ? {native_work: true} : {})}) : runtime.sessionId;
}

function openCodeModels(provider: ProviderInstanceConfig) {
  return normalizeProviderModels(provider.models).map(model => ({...model,
    capabilities: {option_descriptors: model.capabilities.option_descriptors.filter(option => option.id === "variant"), image_input: true}}));
}

function validateTurnOptions(input: {action?: "prompt" | "compact"; mode?: "execute" | "plan"; images?: unknown[]; model_selection?: HarnessModelSelection}): void {
  const options = input.model_selection?.options ?? [];
  if (input.images) validateNativeImageValues(input.images);
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
  policyTransition?: {sourcePolicy: OpenCodePolicy};
  interactive?: true;
  workOwner?: HarnessAdapterStartInput;
  backgroundPermissions?: true;
  controlled?: {providerId: string; expectedAccountBinding?: string; ownershipRoot?: string};
  executable: string;
  launchArgs: string[];
  cwd: string;
  env: Record<string, string>;
  mcpServers: Record<string, { type: "remote"; url: string; enabled: true }>;
  nativeThreadId?: string;
  approvalPolicy?: "ask" | "auto_edits" | "full_access";
  approvalOptions?: HarnessApprovalOptions;
};

export type OpenCodeRuntimeTurnInput = {
  ownedMcpTurn?: HarnessAdapterTurnInput;
  beginNativeExecution?: (nativeReference: string) => string;
  confirmNativeExecution?: (admission: string, execution: string) => void;
  completeNativeExecution?: (admission: string, status: "completed" | "interrupted" | "failed") => void;
  observeNativeAdmission?: (execution: string) => void;
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
  confirmEffectiveOptions?: true;
  onEffectiveOptions?: (selection: HarnessModelSelection) => void;
};

export type OpenCodeRuntime = {
  readMcpInventory?(): Promise<{source: "native"; attachments: string[]}>;
  readonly confirmedApprovalPolicy?: OpenCodePolicy;
  readonly confirmedApprovalOptions?: HarnessApprovalOptions;
  readonly backgroundPermissions?: true;
  readonly work?: OpenCodeOwnedWork;
  stopNativeWork?(): Promise<void>;
  cancelOwnedWork?(work: import("@harness-control/protocol").HarnessNativeWorkRecord, signal: AbortSignal): Promise<void>;
  readOwnedWorkHistory?(input: Parameters<NonNullable<HarnessAdapter["readNativeWorkHistory"]>>[0]): Promise<import("@harness-control/protocol").NativeConversationHistory>;
  readonly sessionPermissions?: true;
  readonly ownedAccount?: {providerId: string; binding: string; anonymous?: true};
  readonly sessionId: string;
  sendTurn(input: OpenCodeRuntimeTurnInput): Promise<string>;
  cancelTurn(): Promise<void>;
  close(): Promise<void>;
  readHistory?(sessionId: string): Promise<unknown>;
  forkHistory?(beforeMessageId?: string): Promise<string>;
  childHistoryView?(custody: import("../../../state/index.js").NativeWorkCustody, signal: AbortSignal): Promise<{
    readHistory(sessionId: string): Promise<unknown>; forkHistory(beforeMessageId?: string): Promise<string>; verify(): Promise<void>}>;
};

export type OpenCodeRuntimeFactory = (input: OpenCodeRuntimeStartInput) => Promise<OpenCodeRuntime>;

export type OpenCodeHarnessAdapterOptions = {
  controlledStorageRoot?: string;
  runtimeFactory?: OpenCodeRuntimeFactory;
  probeTimeoutMs?: number;
  modelCatalog?: (provider: ProviderInstanceConfig) => Promise<ReturnType<typeof projectOpenCodeCatalog>>;
};

export class OpenCodeHarnessAdapter implements HarnessAdapter {
  publicNativeReference(retainedReference: string): string {
    return readControlledOpenCodeReference(retainedReference)?.session_id ?? retainedReference;
  }
  #closed = false;
  async close(): Promise<void> {
    this.#closed = true;
    await this.#turns.close();
    await Promise.all([...this.#runtimes.keys()].map(sessionId => this.stopSession({sessionId})));
  }
  readonly fileContextInputs = true;
  readonly ownedImageInputs = true;
  readonly promptContextInputs = true;
  readonly emptyConversation = true;
  readonly nativeWork = true;
  readonly durableMcpContinuation = true;
  readonly sessionEvents = true;
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
    if (input.payload.approval_reviewer === "native_auto")
      throw new HarnessAdapterError("native_approval_review_unsupported", "OpenCode does not declare native automatic approval review.");
    if (this.#closed) throw new HarnessAdapterError("runner_closed", "OpenCode runtime owner is closed.");
    validateConfigurationInheritance(input.payload, this.configurationInheritance, this.configurationInheritanceOptions);
    validateInstructionRoles(input.payload, this.instructionRoles);
    if (input.payload.conversation_transition && (input.payload.execution_profile !== "interactive"
      || Object.entries(controlledOpenCodeInheritance).some(([key, value]) => input.payload.configuration_inheritance?.[key as keyof typeof controlledOpenCodeInheritance] !== value)))
      throw new HarnessAdapterError("native_configuration_transition_unsupported", "Idle policy replacement requires the explicitly controlled interactive configuration owner.");
    if (input.payload.execution_profile === "background") {
      if (Object.entries(controlledOpenCodeInheritance).some(([key,value]) => input.payload.configuration_inheritance?.[key as keyof typeof controlledOpenCodeInheritance] !== value))
        throw new HarnessAdapterError("execution_profile_configuration_required", "Background work requires the explicitly controlled configuration owner.");
    }
    if (input.payload.approval_options) {
      if (!["interactive", "background"].includes(input.payload.execution_profile ?? "") || (input.payload.approval_reviewer ?? "user") !== "user"
        || Object.entries(controlledOpenCodeInheritance).some(([key,value]) => input.payload.configuration_inheritance?.[key as keyof typeof controlledOpenCodeInheritance] !== value))
        throw new HarnessAdapterError("approval_options_unsupported", "Ordered rules require the explicitly controlled interactive root owner without automatic review.");
      openCodeOrderedRules(input.payload.approval_policy, input.payload.execution_profile === "background", input.payload.approval_options);
    }
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
    const live = this.#runtimes.get(input.request.session_id);
    if (live && input.request.operation.kind === "read") {
      if (nativeReference(live) !== input.conversation.native_thread_id)
        throw new HarnessAdapterError("native_history_binding", "The live OpenCode owner belongs to another retained conversation.");
      if (controlled) {
        const {controlledOpenCodeConversation} = await import("./opencode-controlled-conversation.js");
        return controlledOpenCodeConversation(input, live);
      }
      const {openCodeConversation} = await import("./opencode-conversation.js");
      return openCodeConversation(input, live);
    }
    const runtime = await this.#runtimeFactory({executable: input.provider.executable_path ?? "opencode",
      launchArgs: input.provider.launch_args, cwd: input.conversation.cwd, env: providerEnvironment(input.provider),
      mcpServers: {}, nativeThreadId: controlled?.session_id ?? input.conversation.native_thread_id, approvalPolicy: input.conversation.approval_policy,
      ...(input.conversation.approval_options ? {approvalOptions: input.conversation.approval_options} : {}),
      ...(controlled?.native_work ? {backgroundPermissions: true} : {}),
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
    if (input.payload.execution_profile === "background") {
      const selected = adapterMcpServers(input.mcpServers, input.payload).map(server => server.name).sort();
      const catalogs = (input.mcpToolsets ?? []).map(set => set.name).sort();
      if (new Set(catalogs).size !== catalogs.length || !isDeepStrictEqual(selected, catalogs))
        throw new HarnessAdapterError("native_tool_catalog_unconfirmed", "Background attachments require their exact authorized tool catalogs.");
    }
    if (this.#closed) throw new HarnessAdapterError("runner_closed", "OpenCode runtime owner closed during startup.");
    if (input.payload.execution_profile === "background" && (!input.emitSessionEvent || !input.registerSessionInteractions))
      throw new HarnessAdapterError("native_session_owner_required", "Background work requires registered native observation and interaction owners.");
    if (input.payload.continue_session && !input.nativeConversation)
      throw new HarnessAdapterError("native_continuation_binding", "OpenCode resume requires the runner-authorized retained binding.");
    if (this.#runtimes.has(input.payload.session_id)) {
      throw new HarnessAdapterError("opencode_session_exists", `OpenCode session '${input.payload.session_id}' already exists.`);
    }
    const mcpServers: Record<string, { type: "remote"; url: string; enabled: true }> = {};
    const inheritance = validateConfigurationInheritance(input.payload, this.configurationInheritance, this.configurationInheritanceOptions);
    const controlled = inheritance?.user_settings === false;
    const retained = input.nativeConversation ? readControlledOpenCodeReference(input.nativeConversation.native_thread_id) : undefined;
    if (input.payload.conversation_transition && (!input.nativeConversation?.approval_policy
      || !!retained?.native_work !== (input.payload.execution_profile === "background")))
      throw new HarnessAdapterError("native_configuration_transition_unsupported", "An idle transition must retain the native child execution contract and its verified source policy.");
    const model = parseModel(input.payload.model_selection.model)!;
    if (retained && (!controlled || retained.provider_id !== model.providerID) || controlled && input.nativeConversation && !retained)
      throw new HarnessAdapterError("native_continuation_binding", "Resume must preserve the controlled native provider and configuration owner.");
    for (const attachment of adapterMcpServers(input.mcpServers, input.payload)) {
      assertCliMcpAttachmentProxied(attachment, "OpenCode", "opencode");
      const name: string = cliMcpServerConfigName(attachment.name, "opencode");
      if (input.payload.execution_profile !== "background") mcpServers[name] = { type: "remote", url: attachment.url, enabled: true };
    }
    const runtime: OpenCodeRuntime = await this.#runtimeFactory({
      executable: input.provider.executable_path ?? "opencode",
      launchArgs: input.provider.launch_args,
      cwd: input.payload.cwd,
      env: providerEnvironment(input.provider),
      mcpServers,
      ...(["interactive", "background"].includes(input.payload.execution_profile ?? "") ? {interactive: true} : {}),
      ...(input.payload.execution_profile === "background" ? {workOwner: input, backgroundPermissions: true} : {}),
      ...(input.nativeConversation ? {nativeThreadId: retained?.session_id ?? input.nativeConversation.native_thread_id} : {}),
      ...(controlled ? {controlled: {providerId: model.providerID, ...(retained ? {expectedAccountBinding: retained.account_binding} : {}),
        ...(this.#controlledStorageRoot ? {ownershipRoot: this.#controlledStorageRoot} : {})}} : {}),
      approvalPolicy: input.payload.approval_policy,
      ...(input.payload.approval_options ? {approvalOptions: input.payload.approval_options} : {}),
      ...(input.payload.conversation_transition ? {policyTransition: {sourcePolicy: input.nativeConversation!.approval_policy!}} : {}),
    });
    if (this.#closed) {await runtime.close(); throw new HarnessAdapterError("runner_closed", "OpenCode runtime owner closed during startup.");}
    if (controlled && (!runtime.ownedAccount || runtime.ownedAccount.providerId !== model.providerID)) {
      await runtime.close(); throw new HarnessAdapterError("native_configuration_mismatch", "The runtime did not establish the requested controlled owner.");
    }
    if (["interactive", "background"].includes(input.payload.execution_profile ?? "") && !runtime.sessionPermissions) {
      await runtime.close(); throw new HarnessAdapterError("native_profile_mismatch", "The native runtime did not confirm interactive permission ownership.");
    }
    if (input.payload.execution_profile === "background" && (!runtime.work || !runtime.backgroundPermissions)) {
      await runtime.close(); throw new HarnessAdapterError("native_profile_mismatch", "The native runtime did not establish background ownership.");
    }
    let native_mcp_catalog_readback: {source: "native"; attachments: string[]} | undefined;
    if (input.payload.conversation_transition?.change === "mcp_catalog") {
      try {
        if (!controlled || !runtime.readMcpInventory)
          throw new HarnessAdapterError("native_mcp_catalog_unconfirmed", "Catalog replacement requires a controlled native MCP registry.");
        native_mcp_catalog_readback = await runtime.readMcpInventory();
      } catch (failure) {await runtime.close(); throw failure;}
    }
    this.#runtimes.set(input.payload.session_id, runtime);
    return { adapter_session_id: runtime.sessionId, native_thread_id: nativeReference(runtime), native_work_root_reference: runtime.sessionId,
      ...(native_mcp_catalog_readback ? {native_mcp_catalog_readback} : {}),
      ...(runtime.confirmedApprovalPolicy ? {native_policy_readback: {source: "native" as const,
        approval_policy: runtime.confirmedApprovalPolicy, ...(runtime.confirmedApprovalOptions ? {approval_options: structuredClone(runtime.confirmedApprovalOptions)} : {}), sandbox_mode: "danger_full_access" as const,
        execution_profile: input.payload.execution_profile ?? "isolated"}} : {}) };
  }

  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    validateTurnOptions(input.payload);
    const runtime: OpenCodeRuntime = this.#requireRuntime(input.payload.session_id);
    if (input.session.native_thread_id !== nativeReference(runtime))
      throw new HarnessAdapterError("native_continuation_binding", "The OpenCode runtime does not own this conversation.");
    if (runtime.ownedAccount && parseModel((input.payload.model_selection ?? input.startPayload.model_selection).model)?.providerID !== runtime.ownedAccount.providerId)
      throw new HarnessAdapterError("native_account_selection_unsupported", "A controlled conversation cannot switch to another native provider account.");
    input.persistNativeThread?.(nativeReference(runtime));
    if (input.persistNativeThread) input.emitEvent?.({event_type: "session.configured", data: {native_conversation_ready: true, native_reference: runtime.sessionId}});
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
      const requiresOptions = ["interactive", "background"].includes(input.startPayload.execution_profile ?? "") && input.payload.action !== "compact";
      let optionsConfirmed = false;
      const images = nativeTurnImages(input);
      const finalText = await runtime.sendTurn({
        ...(runtime.work ? {ownedMcpTurn: input} : {}),
        ...(requiresOptions ? {
          confirmEffectiveOptions: true as const,
          onEffectiveOptions: (model_selection: HarnessModelSelection) => {
            optionsConfirmed = true;
            emit({event_type: "settings.options.effective", turn_id: input.payload.turn_id,
              data: {scope: "root", source: "native", model_selection}});
          },
        } : {}),
        ...(input.beginNativeExecution ? {beginNativeExecution: input.beginNativeExecution} : {}),
        ...(input.confirmNativeExecution ? {confirmNativeExecution: input.confirmNativeExecution} : {}),
        ...(input.completeNativeExecution ? {completeNativeExecution: input.completeNativeExecution} : {}),
        turnId: input.payload.turn_id,
        ...(runtime.sessionPermissions && !runtime.confirmedApprovalOptions ? {allowSessionPermissions: true} : {}),
        input: input.payload.input,
        model: input.payload.model_selection?.model ?? input.startPayload.model_selection.model,
        ...(typeof input.startPayload.instructions !== "string" && input.startPayload.instructions?.system ? {systemInstructions: input.startPayload.instructions.system} : {}),
        emitEvent: emit, signal, interactions,
        onUsage: value => {usage = value; emit({event_type: "usage.updated", turn_id: input.payload.turn_id, data: {...value}});},
        modelSelection: selection,
        onContext: value => {context = value; emit({event_type: "context.updated", turn_id: input.payload.turn_id, data: value});},
        ...(input.publishContent ? {publishContent: input.publishContent} : {}),
        ...(input.payload.mode ? {mode: input.payload.mode} : {}),
        ...(input.payload.action ? {action: input.payload.action} : {}),
        ...(images.length ? {images} : {}),
        ...((input.payload.model_selection ?? input.startPayload.model_selection).options?.[0] ?
          {variant: String((input.payload.model_selection ?? input.startPayload.model_selection).options![0]!.value)} : {}),
      });
      if (requiresOptions && !optionsConfirmed) throw new HarnessAdapterError("native_settings_unconfirmed", "The native runtime did not report its confirmed root model/options.");
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
    if (runtime.work) {
      if (!runtime.stopNativeWork) throw new HarnessAdapterError("native_work_closure_unknown", "The runtime has no native shutdown control.");
      await runtime.stopNativeWork();
    }
    await runtime.close();
    this.#runtimes.delete(input.sessionId);
    return [];
  }

  #requireRuntime(sessionId: string): OpenCodeRuntime {
    const runtime: OpenCodeRuntime | undefined = this.#runtimes.get(sessionId);
    if (!runtime) {
      throw new HarnessAdapterError("opencode_session_not_found", `OpenCode session '${sessionId}' is not active.`);
    }
    return runtime;
  }
  async cancelNativeWork(input: Parameters<NonNullable<HarnessAdapter["cancelNativeWork"]>>[0]): Promise<void> {
    const runtime = this.#requireRuntime(input.sessionId);
    if (!runtime.work) throw new HarnessAdapterError("native_work_unsupported", "The selected runtime has no background work owner.");
    if (!runtime.cancelOwnedWork) throw new HarnessAdapterError("native_work_owner_unavailable", "The runtime has no native callback cancellation owner.");
    await runtime.cancelOwnedWork(input.work, input.signal);
  }
  async readNativeWorkHistory(input: Parameters<NonNullable<HarnessAdapter["readNativeWorkHistory"]>>[0]) {
    const runtime = this.#requireRuntime(input.sessionId);
    if (!runtime.readOwnedWorkHistory) throw new HarnessAdapterError("native_work_history_unavailable", "The native child history owner is unavailable.");
    return runtime.readOwnedWorkHistory(input);
  }
  async #retainedChild<T>(input: {provider: ProviderInstanceConfig; signal: AbortSignal;
    custody: import("../../../state/index.js").NativeWorkCustody; work: import("@harness-control/protocol").HarnessNativeWorkRecord;
    conversation?: import("../../../state/index.js").NativeConversation},
    operation: (view: Awaited<ReturnType<NonNullable<OpenCodeRuntime["childHistoryView"]>>>, root: NonNullable<ReturnType<typeof readControlledOpenCodeReference>>) => Promise<T>): Promise<T> {
    const root = input.conversation && readControlledOpenCodeReference(input.conversation.native_thread_id);
    if (!root?.native_work || !input.conversation?.approval_policy || root.session_id !== input.custody.root_native_reference
      || input.custody.source !== "opencode" || input.work.kind !== "agent" || input.work.native_reference !== input.custody.native_reference)
      throw new HarnessAdapterError("native_work_history_binding", "Retained OpenCode child access requires its original controlled account/root binding.");
    input.signal.throwIfAborted();
    const runtime = await this.#runtimeFactory({executable: input.provider.executable_path ?? "opencode", launchArgs: input.provider.launch_args,
      cwd: input.conversation.cwd, env: providerEnvironment(input.provider), mcpServers: {}, nativeThreadId: root.session_id,
      approvalPolicy: input.conversation.approval_policy, backgroundPermissions: true,
      ...(input.conversation.approval_options ? {approvalOptions: input.conversation.approval_options} : {}),
      controlled: {providerId: root.provider_id, expectedAccountBinding: root.account_binding,
        ...(this.#controlledStorageRoot ? {ownershipRoot: this.#controlledStorageRoot} : {})}});
    const stop = () => {void runtime.close();};
    input.signal.addEventListener("abort", stop, {once: true});
    try {
      input.signal.throwIfAborted();
      if (!runtime.childHistoryView || runtime.ownedAccount?.providerId !== root.provider_id || runtime.ownedAccount.binding !== root.account_binding)
        throw new HarnessAdapterError("native_work_history_binding", "The inspection transport did not confirm the original native account.");
      const view = await runtime.childHistoryView(input.custody, input.signal);
      const result = await operation(view, root);
      await view.verify();
      return result;
    } finally {input.signal.removeEventListener("abort", stop); await runtime.close();}
  }
  readRetainedNativeWorkHistory(input: Parameters<NonNullable<HarnessAdapter["readRetainedNativeWorkHistory"]>>[0]) {
    return this.#retainedChild(input, view => readOpenCodeOwnedHistory(() => view.readHistory(input.work.native_reference),
      input.work.native_reference, input.signal, input.page, input.publishContent));
  }
  forkNativeWork(input: Parameters<NonNullable<HarnessAdapter["forkNativeWork"]>>[0]) {
    return this.#retainedChild(input, async (view, root) => {
      const {openCodeConversation} = await import("./opencode-conversation.js");
      const operation = input.operation;
      const result = await openCodeConversation({commandId: input.commandId, provider: input.provider,
        conversation: {...input.conversation, native_thread_id: input.work.native_reference},
        request: {session_id: input.sessionId, operation: {kind: "fork", expected_history_hash: operation.expected_history_hash,
          target_session_id: operation.target_session_id, continuation_group_key: operation.continuation_group_key,
          ...(operation.last_turn_id ? {last_turn_id: operation.last_turn_id} : {})}}, beginMutation: input.beginMutation,
        save: () => {throw new HarnessAdapterError("native_fork_unknown", "Child fork state belongs to its runner fence.");}}, view);
      if (!result.fork) throw new HarnessAdapterError("native_fork_unknown", "The native child fork did not confirm its destination.");
      return {native_reference: controlledOpenCodeReference({...root, session_id: result.fork.native_reference})};
    });
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
  if (input.approvalOptions) {
    if (!input.controlled || input.policyTransition)
      throw new HarnessAdapterError("approval_options_unsupported", "Ordered native permission rules require an unchanged controlled root owner.");
    openCodeOrderedRules(input.approvalPolicy ?? "ask", input.backgroundPermissions === true, input.approvalOptions);
  }
  if (input.workOwner && (!input.controlled || !input.interactive || !input.backgroundPermissions))
    throw new HarnessAdapterError("native_profile_unsupported", "Background ownership requires its controlled persistent runtime.");
  // Check at launch too: a cached capability snapshot cannot authorize another runtime version.
  const probe = await runProbe(input.executable, [...input.launchArgs, "--version"],
    {env: input.env}, DEFAULT_PROBE_TIMEOUT_MS);
  if (probe.timedOut || probe.error || probe.exitCode !== 0 || !supportedVersion(firstLine(probe.stdout)))
    throw new HarnessAdapterError("provider_version_unsupported", "A readable OpenCode 1.3.15+ runtime within major version 1 is required before launch.");
  if ((input.controlled || input.interactive) && !controlledVersion(firstLine(probe.stdout)))
    throw new HarnessAdapterError("configuration_isolation_unsupported", "Controlled configuration and interactive permissions require the verified OpenCode 1.18.34 runtime.");
  const ownedTools = input.workOwner?.mcpToolsets?.some(set => set.tools.length) ? await openCodeOwnedToolServer() : undefined;
  let ownedPolicy: Awaited<ReturnType<typeof openCodeOwnedPolicyServer>> | undefined;
  try {if (input.workOwner && input.approvalOptions) ownedPolicy = await openCodeOwnedPolicyServer();}
  catch (error) {await ownedTools?.close();throw error;}
  const controlled = await (async () => {try {return input.controlled ? await prepareControlledOpenCode({env: {...process.env, ...input.env}, cwd: input.cwd,
    providerId: input.controlled.providerId,
    ...(input.controlled.expectedAccountBinding ? {expectedAccountBinding: input.controlled.expectedAccountBinding} : {}),
    ...(input.controlled.ownershipRoot ? {ownershipRoot: input.controlled.ownershipRoot} : {}), mcpServers: input.mcpServers,
    ...(input.backgroundPermissions ? {backgroundPolicy: input.approvalPolicy ?? "ask"} : {}),
    ...(ownedTools ? {ownedToolPlugin: openCodeOwnedToolPlugin({...ownedTools, tools: openCodeOwnedMcpDefinitions(input.workOwner!.mcpToolsets!)})} : {}),
    ...(ownedPolicy ? {ownedPolicyPlugin: openCodeOwnedPolicyPlugin(ownedPolicy)} : {})}) : undefined;
    } catch (failure) {await ownedTools?.close();await ownedPolicy?.close();throw failure;}})();
  const config: Record<string, unknown> = Object.keys(input.mcpServers).length > 0 ? { mcp: input.mcpServers } : {};
  let processHandle: NativeProcess;
  try {await controlled?.ownedPlugin?.verify();await controlled?.ownedPolicyPlugin?.verify();processHandle = new NativeProcess(
    input.executable,
    [...input.launchArgs, "serve", "--hostname=127.0.0.1", "--port=0"],
    input.cwd,
    input.workOwner ? {...controlled!.env, OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true"}
      : controlled?.env ?? { ...process.env, ...input.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  );} catch (failure) {await ownedTools?.close();await ownedPolicy?.close();await controlled?.cleanup(); throw failure;}
  const child = processHandle.child;
  try {
    child.stdin.end();
    const baseUrl: string = await waitForServerUrl(child, DEFAULT_SERVER_START_TIMEOUT_MS);
    if (input.workOwner && z.object({backgroundSubagents: z.literal(true)}).safeParse(await fetchJson(
      new URL(`/experimental/capabilities?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"})).success !== true)
      throw new HarnessAdapterError("native_profile_unsupported", "OpenCode did not confirm native background task support.");
    if (input.controlled) assertControlledOpenCodeInventory(await fetchJson(
      new URL(`/config?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}), input.controlled.providerId, input.mcpServers, controlled?.ownedPlugin?.url, controlled?.ownedPolicyPlugin?.url);
    await controlled?.ownedPlugin?.verify();await controlled?.ownedPolicyPlugin?.verify();
    if (ownedTools) {
      const model = parseModel(input.workOwner!.payload.model_selection.model)!;
      await assertOwnedToolCatalog(baseUrl, input.cwd, model, openCodeOwnedMcpDefinitions(input.workOwner!.mcpToolsets!));
    }
    if (input.backgroundPermissions) {
      const policy = input.approvalPolicy ?? "ask";
      const configReadback = z.object({permission: z.unknown(), subagent_depth: z.literal(1)}).parse(await fetchJson(
        new URL(`/config?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}));
      const expectedPolicy = openCodeAgentPermission(policy);
      const actualPolicy = z.record(z.string(), z.enum(["allow", "ask", "deny"])).parse(configReadback.permission);
      if (Object.keys(actualPolicy).length !== Object.keys(expectedPolicy).length ||
          Object.entries(expectedPolicy).some(([key, action]) => actualPolicy[key] !== action))
        throw new HarnessAdapterError("native_policy_mismatch", "OpenCode did not confirm the configured background policy.");
      assertOpenCodeAgentPermission(await fetchJson(new URL(`/agent?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}), policy);
    }
    const owner = controlled && input.controlled ? {providerId: input.controlled.providerId, binding: controlled.accountBinding, ...(controlled.anonymous ? {anonymous: true as const} : {})} : undefined;
    if (input.nativeThreadId) {
      const retained = z.object({id: z.string(), directory: z.string(), permission: z.array(z.object({permission: z.string(), pattern: z.string(), action: z.enum(["allow", "ask", "deny"])}))}).parse(await fetchJson(
        new URL(`/session/${encodeURIComponent(input.nativeThreadId)}?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}));
      if (retained.id !== input.nativeThreadId || await realpath(retained.directory) !== await realpath(input.cwd))
        throw new HarnessAdapterError("native_continuation_binding", "OpenCode retained history belongs to another directory or conversation.");
      if (!input.approvalPolicy) throw new HarnessAdapterError("native_policy_unknown", "A retained conversation requires its authorized policy.");
      assertOpenCodeSessionPolicy(retained.permission, input.policyTransition?.sourcePolicy ?? input.approvalPolicy, input.backgroundPermissions, input.approvalOptions);
      if (input.policyTransition) {
        if (!input.controlled || !input.interactive || input.backgroundPermissions)
          throw new HarnessAdapterError("native_configuration_transition_unsupported", "Policy replacement requires a controlled interactive owner without native child work.");
        const updated = z.object({id: z.string(), directory: z.string(), permission: z.unknown()}).parse(await fetchJson(
          new URL(`/session/${encodeURIComponent(retained.id)}?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {
            method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({permission: permissionRules(input.approvalPolicy)})}));
        if (updated.id !== retained.id || await realpath(updated.directory) !== await realpath(input.cwd))
          throw new HarnessAdapterError("native_continuation_binding", "OpenCode changed its conversation ownership during policy replacement.");
        assertOpenCodeSessionPolicy(updated.permission, input.approvalPolicy);
        const confirmed = z.object({id: z.string(), directory: z.string(), permission: z.unknown()}).parse(await fetchJson(
          new URL(`/session/${encodeURIComponent(retained.id)}?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}));
        if (confirmed.id !== retained.id || await realpath(confirmed.directory) !== await realpath(input.cwd))
          throw new HarnessAdapterError("native_continuation_binding", "OpenCode did not preserve its conversation after policy replacement.");
        assertOpenCodeSessionPolicy(confirmed.permission, input.approvalPolicy);
      }
      return new HttpOpenCodeRuntime(processHandle, baseUrl, input.cwd, retained.id, input.approvalPolicy, owner, controlled?.cleanup, input.interactive, input.backgroundPermissions, input.workOwner, ownedTools, input.approvalOptions, ownedPolicy);
    }
    const session: z.infer<typeof sessionSchema> = sessionSchema.parse(
      await fetchJson(new URL(`/session?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "HCP session", permission: permissionRules(input.approvalPolicy ?? "ask", input.backgroundPermissions, input.approvalOptions) }),
      }),
    );
    const created = z.object({id: z.string(), directory: z.string(), permission: z.array(z.object({permission: z.string(), pattern: z.string(), action: z.enum(["allow", "ask", "deny"])}))}).parse(await fetchJson(
      new URL(`/session/${encodeURIComponent(session.id)}?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {method: "GET"}));
    if (created.id !== session.id || await realpath(created.directory) !== await realpath(input.cwd) ||
        JSON.stringify(created.permission) !== JSON.stringify(permissionRules(input.approvalPolicy ?? "ask", input.backgroundPermissions, input.approvalOptions)))
      throw new HarnessAdapterError("native_policy_mismatch", "OpenCode did not confirm its new native conversation, workspace and permissions.");
    return new HttpOpenCodeRuntime(processHandle, baseUrl, input.cwd, session.id, input.approvalPolicy ?? "ask", owner, controlled?.cleanup, input.interactive, input.backgroundPermissions, input.workOwner, ownedTools, input.approvalOptions, ownedPolicy);
  } catch (error: unknown) {
    await processHandle.stop();
    await ownedTools?.close();await ownedPolicy?.close();
    await controlled?.cleanup();
    throw error;
  }
}

class HttpOpenCodeRuntime implements OpenCodeRuntime {
  async readMcpInventory(): Promise<{source: "native"; attachments: string[]}> {
    if (this.#closed || this.#shutdownRequested || !this.ownedAccount)
      throw new HarnessAdapterError("native_mcp_catalog_unconfirmed", "The controlled native registry owner is unavailable.");
    const inventory = z.record(z.string(), z.object({status: z.literal("connected")})).refine(value => Object.keys(value).length <= 128)
      .parse(await fetchJson(new URL(`/mcp?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {method: "GET"}));
    if (this.#closed || this.#shutdownRequested)
      throw new HarnessAdapterError("native_mcp_catalog_unconfirmed", "Native catalog ownership changed during readback.");
    return {source: "native", attachments: Object.keys(inventory).sort()};
  }
  readonly confirmedApprovalPolicy: OpenCodePolicy;
  readonly confirmedApprovalOptions?: HarnessApprovalOptions;
  readonly backgroundPermissions?: true;
  readonly work?: OpenCodeOwnedWork;
  readonly sessionPermissions?: true;
  readonly #process: NativeProcess;
  readonly #baseUrl: string;
  readonly #cwd: string;
  readonly #approvalPolicy: "ask" | "auto_edits" | "full_access";
  readonly sessionId: string;
  readonly ownedAccount?: {providerId: string; binding: string; anonymous?: true};
  readonly #cleanup: (() => Promise<void>) | undefined;
  #closed = false;
  #activeRequest: AbortController | undefined;
  readonly #events: NativeEventOwner | undefined;
  #closing: Promise<void> | undefined;
  #shutdownRequested = false;
  readonly #callbacks: OpenCodeWorkCallbacks | undefined;
  readonly #mcp: OpenCodeOwnedMcp | undefined;
  readonly #ownedTools: Awaited<ReturnType<typeof openCodeOwnedToolServer>> | undefined;
  readonly #ownedPolicy: Awaited<ReturnType<typeof openCodeOwnedPolicyServer>> | undefined;
  readonly #policyPromptReceipts = new Map<string, {message: string; phase: "pending" | "completed"; rules?: HarnessPermissionRules}>();
  readonly #backgroundAbort = new AbortController();
  readonly #backgroundObservation: Promise<void> | undefined;

  constructor(
    processHandle: NativeProcess,
    baseUrl: string,
    cwd: string,
    sessionId: string,
    approvalPolicy: "ask" | "auto_edits" | "full_access",
    owner?: {providerId: string; binding: string; anonymous?: true},
    cleanup?: () => Promise<void>,
    interactive?: true,
    backgroundPermissions?: true,
    workOwner?: HarnessAdapterStartInput,
    ownedTools?: Awaited<ReturnType<typeof openCodeOwnedToolServer>>,
    approvalOptions?: HarnessApprovalOptions,
    ownedPolicy?: Awaited<ReturnType<typeof openCodeOwnedPolicyServer>>,
  ) {
    this.#process = processHandle;
    this.#baseUrl = baseUrl;
    this.#cwd = cwd;
    this.sessionId = sessionId;
    this.#approvalPolicy = approvalPolicy;
    this.confirmedApprovalPolicy = approvalPolicy;
    if (approvalOptions) this.confirmedApprovalOptions = structuredClone(approvalOptions);
    if (owner) this.ownedAccount = owner;
    if (interactive) this.sessionPermissions = true;
    this.#cleanup = cleanup;
    this.#ownedTools = ownedTools;this.#ownedPolicy = ownedPolicy;
    if (backgroundPermissions) this.backgroundPermissions = true;
    if (workOwner) {
      const read = (path: string) => fetchJson(new URL(`${path}?directory=${encodeURIComponent(cwd)}`, baseUrl), {method: "GET"});
      this.work = new OpenCodeOwnedWork(sessionId, {...workOwner, emitSessionEvent: event => {
        workOwner.emitSessionEvent!(event);if (event.event_type === "native.work.updated") {this.#callbacks?.synchronize();this.#mcp?.synchronize();}
      }}, {session: (id, signal) => fetchJson(new URL(`/session/${encodeURIComponent(id)}?directory=${encodeURIComponent(cwd)}`, baseUrl),
        {method: "GET", ...(signal ? {signal} : {})}),
        message: (session, id) => read(`/session/${encodeURIComponent(session)}/message/${encodeURIComponent(id)}`),
        cancel: (session, signal) => fetchJson(new URL(`/session/${encodeURIComponent(session)}/abort?directory=${encodeURIComponent(cwd)}`, baseUrl), {method: "POST", signal})});
      this.#callbacks = new OpenCodeWorkCallbacks(this.work, workOwner, (path, body, signal) => fetchJson(
        new URL(`${path}?directory=${encodeURIComponent(cwd)}`, baseUrl), {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal}),
        () => {this.work!.lose();this.#callbacks?.close();void this.close().catch(() => {});});
      if (ownedTools) {
        this.#mcp = new OpenCodeOwnedMcp(this.work, workOwner.mcpToolsets ?? []);
        ownedTools.bind((invocation, signal) => this.#mcp!.invoke(invocation, signal));
      }
    }
    if (ownedPolicy) {
      if (!this.work || !this.confirmedApprovalOptions || !("permission_rules" in this.confirmedApprovalOptions))
        throw new HarnessAdapterError("native_policy_owner_unavailable", "Ordered child policy requires its live native work owner.");
      ownedPolicy.bind(async (prompt, signal) => {
        try {return await this.#confirmPolicyPrompt(prompt, signal);}
        catch (error) {
          try {workOwner?.emitSessionEvent?.({event_type: "runtime.warning", data: {
            code: error instanceof HarnessAdapterError ? error.code : "native_child_policy_confirmation_failed",
            message: "Native prompt policy confirmation failed; execution ownership requires reconciliation.",
          }});} catch { /* A closed observer cannot authorize the native prompt. */ }
          this.work!.lose(true);void this.close().catch(() => {});throw error;
        }
      });
    }
    if (interactive) this.#events = new NativeEventOwner(async signal => {
      const response = await fetch(new URL(`/event?directory=${encodeURIComponent(cwd)}`, baseUrl),
        {headers: {accept: "text/event-stream"}, signal});
      if (!response.ok || !response.body) throw new HarnessAdapterError("native_event_stream_closed", "OpenCode could not establish its observation owner.");
      return response.body;
    }, () => {this.work?.lose();this.#callbacks?.close();void this.close().catch(() => {});});
    if (this.work && this.#events) {
      this.#backgroundObservation = this.#events.consume(value => {this.work!.observe(value);this.#callbacks!.observe(value);}, this.#backgroundAbort.signal, () => {});
      void this.#backgroundObservation.catch(() => {if (!this.#closing) {this.work?.lose();this.#callbacks?.close();void this.close().catch(() => {});}});
    }
    void processHandle.closed.then(() => {if (!this.#closing) this.work?.lose();this.#callbacks?.close();this.#mcp?.close();void this.#ownedPolicy?.close().catch(() => {});void this.#ownedTools?.close().catch(() => {});this.#closed = true; this.#activeRequest?.abort();void this.#events?.close().catch(() => {});});
  }

  async sendTurn(input: OpenCodeRuntimeTurnInput): Promise<string> {
    if (this.#closed || this.#shutdownRequested) throw new HarnessAdapterError("native_session_unavailable", "This native owner closed or is shutting down; unload it before resuming the retained conversation.");
    if (this.#activeRequest) {
      throw new Error(`OpenCode session '${this.sessionId}' already has an active HTTP request.`);
    }
    if (this.backgroundPermissions && this.confirmedApprovalOptions && !this.#ownedPolicy)
      throw new HarnessAdapterError("native_policy_owner_unavailable", "Retained policy inspection does not restore the child prompt owner.");
    if (this.#mcp) {
      const model = parseModel(input.model);
      if (!model) throw new HarnessAdapterError("native_tool_catalog_unconfirmed", "Selected tools require an exact native model.");
      await assertOwnedToolCatalog(this.#baseUrl, this.#cwd, model, this.#mcp.definitions);
    }
    let optionsCatalog: unknown;
    if (this.ownedAccount?.anonymous || input.confirmEffectiveOptions && input.action !== "compact") {
      optionsCatalog = await fetchJson(new URL(`/provider?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
        {method: "GET", signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000)});
      if (this.ownedAccount?.anonymous) assertAnonymousOpenCodeModel(optionsCatalog, input.modelSelection ?? {model: input.model});
      assertOpenCodeModelOptions(optionsCatalog, input.modelSelection ?? {model: input.model,
        ...(input.variant ? {options: [{id: "variant", value: input.variant}]} : {})}, !!input.images?.length);
    }
    await this.work?.settled();
    if (this.work?.rootBusy) throw new HarnessAdapterError("native_root_busy", "A native parent continuation is still running.");
    if (input.action === "compact" && this.work?.busy) throw new HarnessAdapterError("native_work_active", "Compaction requires resolved background work.");
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    input.signal?.addEventListener("abort", abort, {once: true});
    if (input.signal?.aborted) abort();
    this.#activeRequest = abortController;
    const messageId = openCodeMessageId();
    const usage = new OpenCodeUsage(this.sessionId, messageId);
    let admission: string | undefined;
    const confirm = (execution: string) => {
      if (admission) input.confirmNativeExecution?.(admission, execution);
    };
    const streamReady = createEventStream(
      new URL(`/event?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
      this.sessionId,
      {...input, observeNativeAdmission: confirm},
      abortController.signal,
      this.#baseUrl,
      this.#cwd,
      usage,
      this.#events,
    );
    try {
      await streamReady.ready;
      await this.#confirmOrderedPolicy(abortController.signal);
      if (input.action !== "compact") admission = input.beginNativeExecution?.(this.sessionId);
      if (this.work && input.action !== "compact") {
        this.work.admitRoot(messageId, input.turnId);
        if (this.#mcp) {
          if (!input.ownedMcpTurn) throw new HarnessAdapterError("native_tool_origin_unconfirmed", "Selected native tools require the original HCP turn owner.");
          this.#mcp.admitRoot(messageId, input.ownedMcpTurn, abortController.signal);
        }
        this.#callbacks!.admitRoot({session_id: this.work.start.payload.session_id, turn_id: input.turnId, input: input.input});
      }
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
      if (this.work) {
        const native = z.object({sessionID: z.string(), role: z.literal("assistant"), parentID: z.string()}).safeParse(response.info);
        if (!native.success || native.data.sessionID !== this.sessionId || native.data.parentID !== messageId)
          throw new HarnessAdapterError("native_root_response_unconfirmed", "The native response does not belong to the admitted root prompt.");
        await this.work.settled();
        this.work.closeRoot(messageId);
        this.#mcp?.synchronize();
      }
      if (input.systemInstructions || input.confirmEffectiveOptions) {
        const admitted = await fetchJson(
          new URL(`/session/${encodeURIComponent(this.sessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
          {method: "GET", signal: abortController.signal});
        const user = z.object({info: z.object({id: z.string(), sessionID: z.string(), role: z.literal("user"), system: z.string().optional()})}).parse(admitted);
        if (user.info.id !== messageId || user.info.sessionID !== this.sessionId || input.systemInstructions && user.info.system !== input.systemInstructions)
          throw new HarnessAdapterError("native_instruction_mismatch", "OpenCode did not confirm the admitted system instructions on this prompt.");
        if (input.confirmEffectiveOptions) {
          if (!model) throw new HarnessAdapterError("native_settings_mismatch", "Root options require a bound provider/model selection.");
          const effective = openCodeEffectiveOptions(admitted, response.info, {sessionId: this.sessionId, messageId, model,
            ...(input.variant ? {variant: input.variant} : {})});
          assertOpenCodeModelOptions(optionsCatalog, effective);
          input.onEffectiveOptions?.(effective);
        }
      }
      await this.#confirmOrderedPolicy(abortController.signal);
      usage.message(response.info);
      const acknowledged = z.object({sessionID: z.string(), parentID: z.string()}).safeParse(response.info);
      if (acknowledged.success && acknowledged.data.sessionID === this.sessionId && acknowledged.data.parentID === messageId)
        confirm(messageId);
      const terminal = openCodeRootTerminal(response.info, this.sessionId, messageId);
      if (admission && terminal) input.completeNativeExecution?.(admission, terminal);
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
      if (failure instanceof HarnessAdapterError && (["native_reply_unknown","native_request_origin_unconfirmed","native_event_stream_closed","native_root_response_unconfirmed"].includes(failure.code)
        || failure.code.startsWith("native_sse_"))) await this.close();
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
  async childHistoryView(custody: import("../../../state/index.js").NativeWorkCustody, signal: AbortSignal) {
    if (custody.source !== "opencode" || this.sessionId !== custody.root_native_reference || !this.ownedAccount)
      throw new HarnessAdapterError("native_work_history_binding", "Child inspection requires its original controlled account and root.");
    const url = (id: string, suffix = "") => new URL(`/session/${encodeURIComponent(id)}${suffix}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl);
    return openCodeChildHistoryView(custody, this.#cwd, signal, {
      isClosed: () => this.#closed || this.#shutdownRequested,
      metadata: id => fetchJson(url(id), {method: "GET", signal}),
      messages: id => fetchJson(url(id, "/message"), {method: "GET", signal}),
      fork: async (id, beforeMessageId) => sessionSchema.parse(await fetchJson(url(id, "/fork"), {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify(beforeMessageId ? {messageID: beforeMessageId} : {}), signal})).id,
      configureFork: async id => {
        const configured = z.object({id: z.string(), permission: z.unknown()}).parse(await fetchJson(url(id), {
          method: "PATCH", headers: {"content-type": "application/json"},
          body: JSON.stringify({permission: permissionRules(this.#approvalPolicy, this.backgroundPermissions, this.confirmedApprovalOptions)}), signal}));
        if (configured.id !== id) throw new HarnessAdapterError("native_fork_unknown", "Native permission readback returned another child fork.");
        this.#verifyPermissions(configured.permission);
      },
      verifyPermissions: permission => this.#verifyPermissions(permission),
    });
  }

  async readOwnedWorkHistory(input: Parameters<NonNullable<HarnessAdapter["readNativeWorkHistory"]>>[0]) {
    if (this.#closed || this.#shutdownRequested || !this.work || !this.ownedAccount || !this.backgroundPermissions)
      throw new HarnessAdapterError("native_work_history_unavailable", "The controlled native child history owner is unavailable.");
    const nativeReference = await this.work.verifyHistoryOwner(input.work, input.signal);
    const history = await readOpenCodeOwnedHistory(() => fetchJson(
      new URL(`/session/${encodeURIComponent(nativeReference)}/message?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
      {method: "GET", signal: input.signal}), nativeReference, input.signal, input.page, input.publishContent);
    await this.work.verifyHistoryOwner(input.work, input.signal);
    if (this.#closed || this.#shutdownRequested) throw new HarnessAdapterError("native_work_history_unavailable", "The native child history owner closed during its read.");
    return history;
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
    if (this.work) {await this.work.cancelFamily(AbortSignal.timeout(10000));return;}
    const outcome = await fetchJson(new URL(`/session/${encodeURIComponent(this.sessionId)}/abort?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {
      method: "POST",
    });
    if (outcome !== true) throw new HarnessAdapterError("native_cancel_unknown", "OpenCode did not acknowledge session cancellation.");
  }
  async stopNativeWork(): Promise<void> {
    this.#shutdownRequested = true;
    this.#callbacks?.close();
    this.#mcp?.close();
    await this.work?.stop();
  }
  async cancelOwnedWork(work: import("@harness-control/protocol").HarnessNativeWorkRecord, signal: AbortSignal): Promise<void> {
    if (!this.work) throw new HarnessAdapterError("native_work_unsupported", "This runtime has no native work owner.");
    signal.throwIfAborted();
    await this.work.cancel(work, signal, () => {this.#callbacks!.closeWork(work.work_id);this.#mcp?.closeWork(work.work_id);});
  }

  async #confirmPolicyPrompt(prompt: OpenCodePolicyPrompt, signal: AbortSignal) {
    if (this.#closed || this.#shutdownRequested || !this.work || !this.confirmedApprovalOptions || !("permission_rules" in this.confirmedApprovalOptions)
      || await realpath(prompt.directory) !== await realpath(this.#cwd))
      throw new HarnessAdapterError("native_policy_owner_unavailable", "The native prompt does not have its original policy owner.");
    signal.throwIfAborted();
    const read = async () => z.object({id: z.string(), parentID: z.string().optional(), directory: z.string(), permission: z.unknown()}).parse(await fetchJson(
      new URL(`/session/${encodeURIComponent(prompt.session_id)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {method: "GET", signal}));
    let native = await read();
    if (native.id !== prompt.session_id || await realpath(native.directory) !== await realpath(this.#cwd))
      throw new HarnessAdapterError("native_policy_mismatch", "Native prompt policy readback belongs to another conversation or workspace.");
    if (prompt.session_id === this.sessionId) this.#verifyPermissions(native.permission);
    else {
      const owner = await this.work.awaitChildPolicyOwner(prompt.session_id, signal);
      if (native.parentID !== owner.parent_native_reference || owner.prompt_id && owner.prompt_id !== prompt.message_id)
        throw new HarnessAdapterError("native_work_policy_binding", "The native child prompt changed its launch or execution binding.");
      const prior = this.#policyPromptReceipts.get(prompt.session_id);
      if (prior) {
        if (prior.phase !== "completed" || prior.message !== prompt.message_id || !prior.rules || !isDeepStrictEqual(native.permission, prior.rules))
          throw new HarnessAdapterError("native_work_policy_unknown", "The native child policy mutation or prompt identity is unknown and cannot be replayed.");
      } else {
        if (this.#policyPromptReceipts.size >= 128) throw new HarnessAdapterError("native_work_limit", "Native child policy receipts exceed their bounded registry.");
        const installed = openCodeInstalledChildRules(native.permission, this.confirmedApprovalOptions.permission_rules);
        const expected = installed.slice((native.permission as unknown[]).length);
        signal.throwIfAborted();
        this.#policyPromptReceipts.set(prompt.session_id, {message: prompt.message_id, phase: "pending"});
        const changed = z.object({id: z.string(), permission: z.unknown()}).parse(await fetchJson(
          new URL(`/session/${encodeURIComponent(prompt.session_id)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
          {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({permission: expected}), signal}));
        native = await read();
        const current = this.work.childOrigin(prompt.session_id);
        if (changed.id !== prompt.session_id || native.id !== prompt.session_id || native.parentID !== owner.parent_native_reference
          || await realpath(native.directory) !== await realpath(this.#cwd) || !isDeepStrictEqual(changed.permission, installed) || !isDeepStrictEqual(native.permission, installed)
          || current?.work_id !== owner.work_id || current.origin_turn_id !== owner.origin_turn_id || current.prompt_id && current.prompt_id !== prompt.message_id)
          throw new HarnessAdapterError("native_work_policy_unknown", "The complete native child policy mutation was not confirmed on its original launch owner.");
        this.#policyPromptReceipts.set(prompt.session_id, {message: prompt.message_id, phase: "completed", rules: structuredClone(installed)});
      }
    }
    signal.throwIfAborted();
    if (this.#closed || this.#shutdownRequested) throw new HarnessAdapterError("native_policy_owner_unavailable", "The native prompt policy owner closed during confirmation.");
    return {confirmed: true as const, native_reference: prompt.session_id, native_execution_reference: prompt.message_id};
  }

  async #confirmOrderedPolicy(signal: AbortSignal): Promise<void> {
    if (!this.confirmedApprovalOptions) return;
    try {
      const actual = z.object({id: z.string(), directory: z.string(), permission: z.unknown()}).parse(await fetchJson(
        new URL(`/session/${encodeURIComponent(this.sessionId)}?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
        {method: "GET", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])}));
      if (actual.id !== this.sessionId || await realpath(actual.directory) !== await realpath(this.#cwd))
        throw new HarnessAdapterError("native_policy_mismatch", "Ordered policy readback belongs to another native conversation or workspace.");
      this.#verifyPermissions(actual.permission);
    } catch (error) {await this.close();throw error;}
  }

  #verifyPermissions(actual: unknown) {
    assertOpenCodeSessionPolicy(actual, this.#approvalPolicy, this.backgroundPermissions, this.confirmedApprovalOptions);
  }

  async close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#activeRequest?.abort();
      this.#closing = (async () => {
        this.#backgroundAbort.abort();
        this.#callbacks?.close();
        this.#mcp?.close();
        await this.#ownedTools?.close();await this.#ownedPolicy?.close();
        await this.#backgroundObservation?.catch(() => {});
        await this.#events?.close();
        await this.#process.stop();
        await this.#cleanup?.();
      })();
    }
    await this.#closing;
  }
}

async function assertOwnedToolCatalog(baseUrl: string, cwd: string, model: {providerID: string; modelID: string},
  definitions: readonly import("./opencode-owned-tools.js").OpenCodeOwnedToolDefinition[]): Promise<void> {
  const query = new URLSearchParams({directory: cwd, provider: model.providerID, model: model.modelID});
  const tools = z.array(z.object({id: z.string(), description: z.string(), parameters: z.record(z.string(), z.json())})).max(4096)
    .parse(await fetchJson(new URL(`/experimental/tool?${query}`, baseUrl), {method: "GET"}));
  const owned = tools.filter(tool => tool.id.startsWith("hcp_"));
  if (owned.length !== definitions.length || definitions.some(def => {
    const actual = owned.filter(tool => tool.id === def.alias);
    return actual.length !== 1 || actual[0]!.description !== def.description || !isDeepStrictEqual(actual[0]!.parameters, def.schema);
  })) throw new HarnessAdapterError("native_tool_catalog_unconfirmed", "OpenCode did not confirm the exact owned tool catalog and schemas.");
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
  owner?: NativeEventOwner,
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
  const text = new OpenCodeText(sessionId, usage.promptId, input.turnId, input.emitEvent, input.publishContent);
  const items = new OpenCodeItems(sessionId, input.turnId, id => text.ownsMessage(id), input.emitEvent, input.publishContent);
  const completed: Promise<void> = (async (): Promise<void> => {
    try {
      const observe = (value: unknown): void => {
        const event = eventSchema.parse(value);
        if (event.type === "message.updated") {
          const user = z.object({info: z.object({id: z.string(), sessionID: z.string(), role: z.literal("user")})}).safeParse(event.properties);
          if (user.success && user.data.info.sessionID === sessionId && user.data.info.id === usage.promptId)
            input.observeNativeAdmission?.(user.data.info.id);
        }
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
          const respond = () => respondOpenCodeInteraction(event, {sessionId, promptId: usage.promptId, turnId: input.turnId,
            owner, signal, sessionPermissions: input.allowSessionPermissions === true,
            readMessage: messageId => fetchJson(new URL(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(cwd)}`, baseUrl),
              {method: "GET", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])}),
            reply: (path, body, requestSignal) => fetchJson(new URL(`${path}?directory=${encodeURIComponent(cwd)}`, baseUrl),
              {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal: requestSignal})});
          const response = respond(); responses.push(response);
          void response.catch(error => rejectSettled(error instanceof Error ? error : new Error("Native response failed.")));
          return;
        }
        const outcome: OpenCodeEventOutcome = emitOpenCodeEvent(value, sessionId, input);
        if (outcome === "settled") void Promise.all(responses).then(markSettled, rejectSettled);
        if (outcome instanceof Error) rejectSettled(outcome);
      };
      if (owner) await owner.consume(observe, signal, markReady);
      else {
        const response: Response = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
        if (!response.ok || !response.body) throw new HarnessAdapterError("native_event_stream_closed", "OpenCode could not establish its observation stream.");
        markReady();
        await consumeNativeSse(response.body, observe, signal);
      }
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
    const native_plan = nativePlanObservation("todo_list", event.properties.todos, {observation: "snapshot", native_reference: sessionId}, input.publishContent);
    input.emitEvent({event_type: "turn.plan.updated", turn_id: input.turnId, data: {plan: retainedContent(event.properties.todos, input.publishContent), ...(native_plan ? {native_plan} : {})}});
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
      if (size > HARNESS_CONTENT_MAX_BYTES) throw new HarnessAdapterError("native_http_limit", "OpenCode response exceeds the bounded 128 MiB limit.");
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
