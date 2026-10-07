import type { McpToolDescriptor, McpToolCallArguments, McpToolCallResult, McpReviewGrant } from "../../mcp/McpAttachmentClient.js";
import type { McpInputReply } from "../../mcp/input-required.js";
import type { HcpEventType, HcpSessionStartPayload, HcpTurnSendPayload, HcpApprovalResponsePayload, HcpInputResponsePayload } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../../config/index.js";
import type { ProviderDriverStatus } from "../../host/provider-registry.js";
import type { NativeConversation } from "../../state/index.js";
import type { HcpConversationRequestPayload, HcpConversationResultPayload } from "@harness-control/protocol";
import type {HarnessContentReference} from "@harness-control/protocol";

export type HarnessConversationOperation = Exclude<HcpConversationRequestPayload["operation"]["kind"], "retire" | "steer" | "content" | "work" | "input_file" | "feedback" | "goal" | "policy">;

/** A live control belongs to exactly one running HCP turn, and expires with its runtime. */
export type HarnessActiveTurnControls = {
  steer(input: string): Promise<void>;
};

/** The manager authorizes the retained binding; the adapter owns native history mechanics. */
export type HarnessAdapterConversationInput = {
  commandId: string;
  request: HcpConversationRequestPayload;
  conversation: NativeConversation;
  provider: ProviderInstanceConfig;
  /** Persist the runner's mutation fence immediately before dispatching a native fork or context injection. */
  beginMutation?: () => void;
  publishContent?: (value: unknown) => HarnessContentReference;
  save: (conversation: NativeConversation) => void;
};

export type HarnessAdapterEvent = {
  event_type: HcpEventType;
  turn_id?: string;
  data: Record<string, unknown>;
  /** Runner-private, immutable child admission; persisted atomically with its first work observation. */
  nativeWorkCustody?: import("../../state/index.js").NativeWorkCustody;
};

export type HarnessAdapterSession = {
  /** Exact connected attachment names from native registry readback; never requested-only evidence. */
  native_mcp_catalog_readback?: import("@harness-control/protocol").HarnessNativeMcpCatalogReadback;
  native_policy_readback?: import("@harness-control/protocol").HarnessNativePolicyReadback;
  adapter_session_id: string;
  native_thread_id?: string;
  /** Physical native ID when the public continuation reference is an opaque account binding. */
  native_work_root_reference?: string;
  native_fresh?: true;
};

export type HarnessNativeInteractions = {
  owns(requestId: string): boolean;
  respondApproval(response: HcpApprovalResponsePayload): void;
  respondInput(response: HcpInputResponsePayload): void;
};

export type HarnessAdapterMcpServer = {
  name: string;
  transport: "streamable_http";
  url: string;
  headers: Record<string, string>;
  allowed_tools?: string[];
  denied_tools?: string[];
};

export type HarnessAdapterStartInput = {
  /** A persistent owner may retain interactions beyond root completion; clearing it fences all such replies. */
  registerSessionInteractions?: (owner: HarnessNativeInteractions | undefined) => void;
  /** Session-owned observations may continue between turns. Native-work adapters report owner death with native.work.owner_lost; it permanently fences this owner's controls. */
  emitSessionEvent?: (event: HarnessAdapterEvent) => void;
  publishContent?: (value: unknown) => HarnessContentReference;
  payload: HcpSessionStartPayload;
  provider: ProviderInstanceConfig;
  nativeConversation?: NativeConversation;
  mcpServers?: HarnessAdapterMcpServer[];
  /** Authorized catalogs for adapters that establish conversations during startup. */
  mcpToolsets?: readonly HarnessMcpToolset[];
};

export type HarnessMcpToolset = {
  name: string;
  tools: readonly McpToolDescriptor[];
  callTool(name: string, arguments_: McpToolCallArguments, grant?: McpReviewGrant, continuation?: McpInputReply): Promise<McpToolCallResult>;
};

export type HarnessMcpReviewRequest = {
  /** Present only after the adapter proves the physical native invocation; never an HCP reply token. */
  native_request?: import("@harness-control/protocol").HarnessNativeRequestIdentity;
  attachment_name: string;
  tool_name: string;
  arguments: McpToolCallArguments;
  native_thread_id: string;
  native_turn_id: string;
  native_call_id: string;
};

export type HarnessMcpReviewer = {
  request(request: HarnessMcpReviewRequest, signal: AbortSignal): Promise<McpReviewGrant | null>;
  complete(grant: McpReviewGrant, result: McpToolCallResult): Promise<void>;
  invoke?(request: HarnessMcpReviewRequest, callTool: HarnessMcpToolset["callTool"], signal: AbortSignal,
    grant?: McpReviewGrant, continuation?: McpInputReply): Promise<McpToolCallResult>;
};

/** Holds the session dispatch slot through the complete approval/invocation/input lifecycle. */
export type HarnessMcpDispatch = <T>(operation: () => Promise<T>, signal: AbortSignal) => Promise<T>;

export type HarnessMcpContinuation = {
  native_thread_id: string;
  request_id: string;
  attachment_name: string;
  tool_name: string;
  arguments: McpToolCallArguments;
  outcome: {kind: "declined"} | {kind: "completed"; result: McpToolCallResult};
};

export type HarnessAdapterTurnInput = {
  /** Exact owned-image bytes resolved by the manager after scope, metadata and integrity checks. */
  inputFileImages?: {reference: import("@harness-control/protocol").HarnessImageFileReference; data_base64: string}[];
  /** Persist before native dispatch; confirmation requires the corresponding native acknowledgement. */
  beginNativeExecution?: (nativeReference: string, goalAdmissionId?: string, observedGoalPhase?: true) => string;
  confirmNativeExecution?: (admissionId: string, nativeExecutionReference: string) => void;
  completeNativeExecution?: (admissionId: string, status: "completed" | "interrupted" | "failed", output?: import("@harness-control/protocol").HarnessTurnFinalOutput) => void;
  beginNativeGoal?: (nativeReference: string, goal: import("@harness-control/protocol").HarnessNativeGoalRequest, resume?: import("@harness-control/protocol").HarnessNativeGoalObservation) => string;
  confirmNativeGoal?: (record: import("@harness-control/protocol").HarnessNativeGoalRecord) => void;
  payload: HcpTurnSendPayload;
  session: HarnessAdapterSession;
  startPayload: HcpSessionStartPayload;
  provider: ProviderInstanceConfig;
  mcpServers?: HarnessAdapterMcpServer[];
  mcpToolsets?: readonly HarnessMcpToolset[];
  reviewMcpTool?: HarnessMcpReviewer;
  /** Retained child callbacks must use their confirmed work owner, independently of the current root. */
  reviewNativeWorkMcp?: (workId: string) => HarnessMcpReviewer;
  dispatchMcp?: HarnessMcpDispatch;
  mcpContinuation?: HarnessMcpContinuation;
  registerNativeInteractions?: (owner: HarnessNativeInteractions | undefined) => void;
  registerActiveTurnControls?: (controls: HarnessActiveTurnControls | undefined) => void;
  publishContent?: (value: unknown) => HarnessContentReference;
  persistNativeThread?: (threadId: string) => void;
  emitEvent?: (event: HarnessAdapterEvent) => void;
};

export type HarnessAdapterCancelInput = {
  sessionId: string;
  turnId: string;
};

export type HarnessAdapterStopInput = {
  sessionId: string;
  reason?: string;
};

export type HarnessAdapter = {
  /** Pure projection of retained private custody into the identity emitted by native session readiness. */
  publicNativeReference?(retainedReference: string): string;
  /** The manager may project verified owned workspace files into user-level input. */
  readonly fileContextInputs?: true;
  readonly ownedImageInputs?: true;
  /** The manager may project explicitly supplied user/assistant history into user-level prompt context. */
  readonly promptContextInputs?: true;
  /** Start establishes a confirmed native conversation before any model turn. */
  readonly emptyConversation?: true;
  readonly executionProfiles?: readonly import("@harness-control/protocol").HarnessExecutionProfileCapabilities[];
  readonly portableHistory?: true;
  /** Read-only, revision-checked native history can coexist with this adapter's live session owner. */
  readonly liveHistoryRead?: true;
  readonly nativeWork?: true;
  /** Runner-private transaction primitive. Public capability requires manager authorization and durable receipts. */
  updateNativePolicy?(input: {sessionId: string; nextPayload: HcpSessionStartPayload; signal: AbortSignal;
    beginMutation: () => void;
    commit: (readback: import("@harness-control/protocol").HarnessNativePolicyReadback,
      confirmation: {native_source: string; native_permission_mode: string; observed_at: string}) => void}): Promise<import("@harness-control/protocol").HarnessNativePolicyReadback>;
  /** native_mcp_detach_busy is a pre-dispatch refusal; other failures retain unknown outcome. */
  detachNativeMcpServers?(input: {sessionId: string; names: readonly string[]; signal: AbortSignal}): Promise<{
    source: "native"; detached: string[]; remaining: string[]}>;
  submitNativeFeedback?(input: {sessionId: string; nativeThreadId: string; provider: ProviderInstanceConfig;
    startPayload: HcpSessionStartPayload; request: import("@harness-control/protocol").HarnessNativeFeedbackOperation;
    signal: AbortSignal}): Promise<{feedback_id: string}>;
  controlNativeGoal?(input: {sessionId: string; nativeThreadId: string; cwd: string; provider: ProviderInstanceConfig;
    operation: import("@harness-control/protocol").HarnessNativeGoalOperation; signal: AbortSignal;
    inspectionOnly: boolean; beginMutation?: () => void}): Promise<import("@harness-control/protocol").HarnessNativeGoalResult>;
  readNativeWorkHistory?(input: {commandId: string; sessionId: string; work: import("@harness-control/protocol").HarnessNativeWorkRecord;
    provider: ProviderInstanceConfig; startPayload: HcpSessionStartPayload;
    page: {cursor?: string; limit?: number}; publishContent: import("./providers/content-projection.js").ContentPublisher;
    signal: AbortSignal}): Promise<import("@harness-control/protocol").NativeConversationHistory>;
  /** Never resumes an execution or restores callbacks; custody must be reverified against native metadata. */
  readRetainedNativeWorkHistory?(input: {commandId: string; sessionId: string;
    work: import("@harness-control/protocol").HarnessNativeWorkRecord;
    custody: import("../../state/index.js").NativeWorkCustody;
    provider: ProviderInstanceConfig; scope: import("../../state/index.js").NativeWorkState["scope"];
    conversation?: NativeConversation;
    page: {cursor?: string; limit?: number}; publishContent: import("./providers/content-projection.js").ContentPublisher;
    signal: AbortSignal}): Promise<import("@harness-control/protocol").NativeConversationHistory>;
  forkNativeWork?(input: {commandId: string; sessionId: string;
    work: import("@harness-control/protocol").HarnessNativeWorkRecord;
    custody: import("../../state/index.js").NativeWorkCustody;
    conversation: NativeConversation; provider: ProviderInstanceConfig;
    operation: Extract<import("@harness-control/protocol").HcpConversationRequestPayload["operation"], {action: "fork"}>;
    beginMutation: () => void; signal: AbortSignal}): Promise<{native_reference: string}>;
  reconcileNativeWork?(input: {commandId: string; sessionId: string;
    work: import("@harness-control/protocol").HarnessNativeWorkRecord;
    custody: import("../../state/index.js").NativeWorkCustody;
    provider: ProviderInstanceConfig; scope: import("../../state/index.js").NativeWorkState["scope"];
    conversation?: NativeConversation; signal: AbortSignal}): Promise<{status: "completed" | "failed" | "cancelled"}>;
  cancelNativeWork?(input: {commandId: string; sessionId: string; work: import("@harness-control/protocol").HarnessNativeWorkRecord;
    provider: ProviderInstanceConfig; startPayload: HcpSessionStartPayload; signal: AbortSignal}): Promise<void>;
  readonly sessionEvents?: true;
  readonly instructionRoles?: readonly ("system" | "developer")[];
  readonly configurationInheritance?: import("@harness-control/protocol").HarnessConfigurationInheritance;
  readonly configurationInheritanceOptions?: readonly import("@harness-control/protocol").HarnessConfigurationInheritance[];
  readonly driverKind: string;
  close?(): Promise<void>;
  readonly durableMcpContinuation?: true;
  readonly conversationOperations?: readonly HarnessConversationOperation[];
  conversationOperation?(input: HarnessAdapterConversationInput): Promise<HcpConversationResultPayload>;
  probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus>;
  validateStart(input: HarnessAdapterStartInput): Promise<void>;
  startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession>;
  sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]>;
  cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]>;
  stopSession(input: HarnessAdapterStopInput): Promise<HarnessAdapterEvent[]>;
};

export class HarnessAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessAdapterError";
  }
}
