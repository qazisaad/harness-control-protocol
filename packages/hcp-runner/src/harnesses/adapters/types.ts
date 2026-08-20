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

export type HarnessAdapterTurnInput = {
  payload: HcpTurnSendPayload;
  session: HarnessAdapterSession;
  startPayload: HcpSessionStartPayload;
  provider: ProviderInstanceConfig;
  mcpServers?: HarnessAdapterMcpServer[];
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
