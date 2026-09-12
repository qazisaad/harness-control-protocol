import { HCP_VERSION, parseHcpMessage, type HcpMessage, type HcpMetadata } from "@harness-control/protocol";

const commandTypes = [
  "harness.session.start", "harness.session.snapshot.request", "harness.turn.send",
  "harness.turn.cancel", "harness.session.stop", "harness.approval.respond",
  "harness.input.respond", "tool_servers.detach", "local.action.request", "host.workspaces.request", "host.accounts.read",
] as const;
export type HcpCommandType = typeof commandTypes[number];
export type HcpCommand = Extract<HcpMessage, { type: HcpCommandType }>;
export type HcpCommandInput = HcpCommand extends infer C
  ? C extends HcpCommand ? Pick<C, "type" | "payload"> : never : never;
export type CommandOptions = { id?: string; sentAt?: string; metadata?: HcpMetadata };

export function parseCommand(input: unknown): HcpCommand {
  const message = parseHcpMessage(input);
  if (!(commandTypes as readonly string[]).includes(message.type)) {
    throw new Error(`Not an app-to-runner command: ${message.type}`);
  }
  return message as HcpCommand;
}

export function createCommand<C extends HcpCommandInput>(input: C, options: CommandOptions = {}): Extract<HcpCommand, { type: C["type"] }> {
  return parseCommand({
    ...input, id: options.id ?? crypto.randomUUID(), version: HCP_VERSION,
    sent_at: options.sentAt ?? new Date().toISOString(),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  }) as Extract<HcpCommand, { type: C["type"] }>;
}

export type HcpCommandResponse<T extends HcpCommandType> = Extract<HcpMessage, {
  type: T extends "host.accounts.read" ? "host.accounts.snapshot"
    : T extends "host.workspaces.request" ? "host.workspaces.result"
    : T extends "harness.session.snapshot.request" ? "harness.session.snapshot"
    : T extends "local.action.request" ? "local.action.response" | "local.action.error"
    : "hcp.command.ack";
}>;
