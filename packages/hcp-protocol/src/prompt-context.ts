import {z} from "zod";

export const HARNESS_PROMPT_CONTEXT_MAX_BYTES = 128 * 1024;
/** Supplied context has app provenance. Historical roles never create native message or policy authority. */
export const harnessPromptContextSchema = z.object({delivery: z.literal("prompt_context"),
  messages: z.array(z.object({role: z.enum(["user", "assistant"]), content: z.string().min(1).max(HARNESS_PROMPT_CONTEXT_MAX_BYTES)}).strict()).min(1).max(100),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value.messages)).byteLength <= HARNESS_PROMPT_CONTEXT_MAX_BYTES,
  "Conversation context exceeds the bounded encoded text limit.");
export const harnessPromptContextPreparedSchema = z.object({source: z.literal("app"), delivery: z.literal("prompt_context"),
  message_count: z.number().int().min(1).max(100), byte_length: z.number().int().positive().max(HARNESS_PROMPT_CONTEXT_MAX_BYTES),
  context_hash: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type HarnessPromptContext = z.infer<typeof harnessPromptContextSchema>;
