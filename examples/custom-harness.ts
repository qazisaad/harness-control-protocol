import {
  HarnessAdapterError,
  type HarnessAdapter,
  type HarnessAdapterCancelInput,
  type HarnessAdapterEvent,
  type HarnessAdapterSession,
  type HarnessAdapterStartInput,
  type HarnessAdapterTurnInput,
  type ProviderDriverStatus,
} from "@harness-control/runner/harnesses";
import type { ProviderInstanceConfig } from "@harness-control/runner/config";

// Replace the turn body with your harness. HCP owns transport and event sequencing.
export class EchoHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "example.echo";

  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    return {
      provider_instance_id: provider.id,
      driver_kind: this.driverKind,
      installed: true,
      available: true,
      status: "ready",
      models: [{ id: "echo", label: "Echo", capabilities: { option_descriptors: [] } }],
      execution_capabilities: {
        streaming: false,
        multi_turn: true,
        session_continuation: false,
        sandbox_modes: ["read_only", "workspace_write"],
        approval_policies: ["full_access"],
      },
    };
  }

  async validateStart({ payload }: HarnessAdapterStartInput): Promise<void> {
    if (payload.continue_session || payload.approval_policy !== "full_access"
      || !["read_only", "workspace_write"].includes(payload.sandbox_mode)
      || payload.model_selection?.model !== "echo"
      || (payload.model_selection.options?.length ?? 0) > 0) {
      throw new HarnessAdapterError("unsupported_configuration", "Use the advertised Echo configuration.");
    }
  }

  async startSession({ payload }: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
    return { adapter_session_id: payload.session_id };
  }

  async sendTurn({ payload }: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    return [{ event_type: "turn.completed", turn_id: payload.turn_id,
      data: { final_output: { final_text: payload.input } } }];
  }

  async cancelTurn({ turnId }: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]> {
    return [{ event_type: "turn.cancelled", turn_id: turnId,
      data: { final_output: { exit_reason: "cancel_requested" } } }];
  }

  async stopSession(): Promise<HarnessAdapterEvent[]> {
    return [];
  }
}
