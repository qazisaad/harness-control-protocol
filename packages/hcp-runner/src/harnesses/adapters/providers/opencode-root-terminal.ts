import {z} from "zod";
const identity = z.string().min(1).max(512);
const terminal = z.object({id: identity, sessionID: identity, parentID: identity, role: z.literal("assistant"),
  time: z.object({created: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    completed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}),
  finish: z.string().min(1).max(512).optional(), error: z.object({name: z.string().min(1).max(512)}).optional()});

/** Only used after the owned HTTP prompt response and observation settlement, never on session.idle alone. */
export function openCodeRootTerminal(input: unknown, sessionId: string, promptId: string) {
  const value = terminal.safeParse(input);
  if (!value.success || value.data.sessionID !== sessionId || value.data.parentID !== promptId
    || value.data.time.created !== undefined && value.data.time.completed < value.data.time.created) return;
  if (value.data.error?.name === "MessageAbortedError") return "interrupted" as const;
  if (value.data.error) return "failed" as const;
  if (value.data.finish === "error") return "failed" as const;
  if (value.data.finish && ["stop", "length", "content-filter"].includes(value.data.finish)) return "completed" as const;
}
