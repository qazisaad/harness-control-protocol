import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { redactValue } from "../mcp/redaction.js";

export type AuditLogEvent = {
  event: string;
  session_id?: string;
  turn_id?: string;
  provider_instance_id?: string;
  workspace_id?: string;
  data?: Record<string, unknown>;
};

export type AuditLogger = {
  record(event: AuditLogEvent): Promise<void>;
};

export class JsonlAuditLogger implements AuditLogger {
  constructor(private readonly path: string) {}

  async record(event: AuditLogEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const payload = {
      recorded_at: new Date().toISOString(),
      event: event.event,
      ...(event.session_id ? { session_id: event.session_id } : {}),
      ...(event.turn_id ? { turn_id: event.turn_id } : {}),
      ...(event.provider_instance_id ? { provider_instance_id: event.provider_instance_id } : {}),
      ...(event.workspace_id ? { workspace_id: event.workspace_id } : {}),
      ...(event.data ? { data: redactValue(event.data) } : {}),
    };
    await appendFile(this.path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  }
}

export function defaultAuditLogPath(): string {
  const stamp: string = new Date().toISOString().slice(0, 10);
  return join(homedir(), ".hcp-runner", "logs", `audit-${stamp}.jsonl`);
}
