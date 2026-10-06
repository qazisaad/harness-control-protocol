import type { McpToolDescriptor, McpToolCallArguments, McpToolCallResult, McpReviewGrant } from "../../mcp/McpAttachmentClient.js";
import type { McpInputReply } from "../../mcp/input-required.js";
import type { HcpEventType, HcpSessionStartPayload, HcpTurnSendPayload, HcpApprovalResponsePayload, HcpInputResponsePayload } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../../config/index.js";
import type { ProviderDriverStatus } from "../../host/provider-registry.js";
import type { NativeConversation } from "../../state/index.js";
import type { HcpConversationRequestPayload, HcpConversationResultPayload } from "@harness-control/protocol";
import type {HarnessContentReference} from "@harness-control/protocol";

export type HarnessConversationOperation = Exclude<HcpConversationRequestPayload["operation"]["kind"], "retire" | "steer" | "content" | "work">;

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
};

export type HarnessAdapterSession = {
  adapter_session_id: string;
  native_thread_id?: string;
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
};

export type HarnessMcpToolset = {
  name: string;
  tools: readonly McpToolDescriptor[];
  callTool(name: string, arguments_: McpToolCallArguments, grant?: McpReviewGrant, continuation?: McpInputReply): Promise<McpToolCallResult>;
};

export type HarnessMcpReviewRequest = {
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
  /** Start establishes a confirmed native conversation before any model turn. */
  readonly emptyConversation?: true;
  readonly executionProfiles?: readonly import("@harness-control/protocol").HarnessExecutionProfileCapabilities[];
  readonly portableHistory?: true;
  /** Read-only, revision-checked native history can coexist with this adapter's live session owner. */
  readonly liveHistoryRead?: true;
  readonly nativeWork?: true;
  cancelNativeWork?(input: {commandId: string; sessionId: string; work: import("@harness-control/protocol").HarnessNativeWorkRecord;
    provider: ProviderInstanceConfig; startPayload: HcpSessionStartPayload; signal: AbortSignal}): Promise<void>;
  readonly sessionEvents?: true;
  readonly instructionRoles?: readonly ("system" | "developer")[];
  readonly configurationInheritance?: import("@harness-control/protocol").HarnessConfigurationInheritance;
  readonly configurationInheritanceOptions?: readonly import("@harness-control/protocol").HarnessConfigurationInheritance[];
  readonly driverKind: string;
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
