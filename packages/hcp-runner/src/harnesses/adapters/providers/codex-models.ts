import { z } from "zod";
import type { HarnessModel } from "@harness-control/protocol";
import type { ProviderInstanceConfig } from "../../../config/index.js";
import { CodexRpc } from "./codex-rpc.js";

const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
      supportedReasoningEfforts: z.array(
        z.object({ reasoningEffort: z.string() }),
      ),
      defaultReasoningEffort: z.string(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

export async function codexModels(
  provider: ProviderInstanceConfig,
  timeoutMs: number,
): Promise<HarnessModel[]> {
  const rpc = new CodexRpc(provider.executable_path ?? "codex", process.cwd(), {
    ...process.env,
    ...provider.env,
    ...(provider.home ? { CODEX_HOME: provider.home } : {}),
  });
  const timer = setTimeout(() => {
    void rpc.process.stop();
  }, timeoutMs);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "hcp-runner", version: "0.0.0" },
      capabilities: {},
    });
    rpc.notify("initialized");
    const models: HarnessModel[] = [];
    let cursor: string | undefined;
    do {
      const page = pageSchema.parse(
        await rpc.request("model/list", { ...(cursor ? { cursor } : {}) }),
      );
      for (const model of page.data)
        models.push({
          id: model.model,
          label: model.displayName,
          is_default: model.isDefault,
          capabilities: {
            option_descriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                default_value: model.defaultReasoningEffort,
                values: model.supportedReasoningEfforts.map(
                  ({ reasoningEffort }) => ({
                    value: reasoningEffort,
                    label: reasoningEffort,
                  }),
                ),
              },
            ],
          },
        });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return models;
  } finally {
    clearTimeout(timer);
    await rpc.process.stop();
  }
}
