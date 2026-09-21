import type { McpToolDescriptor, McpToolCallArguments, McpToolCallResult, McpReviewGrant } from "../../mcp/McpAttachmentClient.js";
import type { McpInputReply } from "../../mcp/input-required.js";
import type { HcpEventType, HcpSessionStartPayload, HcpTurnSendPayload } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../../config/index.js";
import type { ProviderDriverStatus } from "../../host/provider-registry.js";

export type HarnessAdapterEvent = {
  event_type: HcpEventType;
  turn_id?: string;
  data: Record<string, unknown>;
};

export type HarnessAdapterSession = {
  adapter_session_id: string;
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
  payload: HcpSessionStartPayload;
  provider: ProviderInstanceConfig;
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
  mcpContinuation?: HarnessMcpContinuation;
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
  readonly driverKind: string;
  readonly durableMcpContinuation?: true;
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
