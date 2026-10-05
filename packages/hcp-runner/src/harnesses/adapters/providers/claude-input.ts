import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessAdapterError } from "../types.js";

/** A bounded input channel to the owned native query; application queues live outside HCP. */
export class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  readonly #messages: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #closed = false;
  offer(message: SDKUserMessage): void {
    if (this.#closed) throw new HarnessAdapterError("active_turn_unavailable", "The native input channel is closed.");
    if (this.#messages.length >= 16) throw new HarnessAdapterError("native_input_busy", "The native input channel is busy.");
    this.#messages.push(message);
    this.#wake?.(); this.#wake = undefined;
  }
  close(): void {this.#closed = true; this.#messages.length = 0; this.#wake?.(); this.#wake = undefined;}
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.#closed) {
      const message = this.#messages.shift();
      if (message) yield message;
      else await new Promise<void>(resolve => {this.#wake = resolve;});
    }
  }
}
