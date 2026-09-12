import { z } from "zod";
import { spendLimitActionSchema, spendLimitStateSchema, type SpendLimitAction, type SpendLimitAdmin, type SpendLimitState } from "./actions.js";

const amount = z.string().regex(/^(0|[1-9][0-9]*)$/).max(18);
const userId = z.string().regex(/^user_[A-Za-z0-9]+$/);
const limitId = z.string().regex(/^spl_[A-Za-z0-9]+$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const effectiveSchema = z.object({
  scope: z.object({ type: z.literal("user"), user_id: userId }),
  amount: amount.nullable(), currency, period: z.literal("monthly"),
  source: z.object({ type: z.enum(["user", "seat_tier", "rbac_group", "organization"]) }),
  spend_limit_id: limitId.nullable(),
  period_to_date_spend: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
});
export type ClaudeMemberSpend = z.infer<typeof effectiveSchema>;
const pageSchema = z.object({ data: z.array(effectiveSchema), next_page: z.string().nullable() });
const limitSchema = z.object({
  type: z.literal("spend_limit"), id: limitId,
  scope: z.object({ type: z.literal("user"), user_id: userId }),
  amount: amount.nullable(), currency, period: z.literal("monthly"),
});

/** Enterprise usage credits only. The host must bind this organization to the key in its secret manager. */
export class ClaudeEnterpriseAdmin implements SpendLimitAdmin {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #allowWrites: boolean;

  constructor(readonly organizationId: string, options: { apiKey: string; allowWrites?: boolean; fetch?: typeof fetch }) {
    if (!organizationId.trim() || !options.apiKey.trim()) throw new Error("Claude administration requires a configured organization and admin key.");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#allowWrites = options.allowWrites ?? false;
  }

  async readSpend(memberId: string): Promise<ClaudeMemberSpend> {
    const parsedId: string = userId.parse(memberId);
    const query = new URLSearchParams({ "user_ids[]": parsedId, limit: "1" });
    const page = pageSchema.parse(await this.#request(`/spend_limits/effective?${query}`, "GET"));
    const row = page.data[0];
    if (page.next_page !== null || page.data.length !== 1 || row?.scope.user_id !== parsedId) throw new Error("Claude did not return exactly the requested organization member.");
    return row;
  }

  async read(memberId: string): Promise<SpendLimitState> {
    const row: ClaudeMemberSpend = await this.readSpend(memberId);
    return spendLimitStateSchema.parse({ amount_minor: row.amount, currency: row.currency,
      source: row.source.type === "user" ? "user" : "inherited",
      override_id: row.source.type === "user" ? row.spend_limit_id : null,
    });
  }

  async apply(input: SpendLimitAction): Promise<void> {
    const action: SpendLimitAction = spendLimitActionSchema.parse(input);
    if (!this.#allowWrites) throw new Error("Claude administrative writes are disabled.");
    if (action.organization_id !== this.organizationId || Date.parse(action.expires_at) <= Date.now()) throw new Error("Invalid organization or expired action.");
    if (action.desired.kind === "set") {
      const written = limitSchema.parse(await this.#request("/spend_limits", "POST", {
        scope: { type: "user", user_id: action.user_id }, amount: action.desired.amount_minor, period: "monthly",
      }));
      if (written.scope.user_id !== action.user_id || written.amount !== action.desired.amount_minor || written.currency !== action.expected.currency) {
        throw new Error("Claude write response did not match the requested limit.");
      }
    } else {
      if (action.expected.source !== "user" || !action.expected.override_id) throw new Error("Only a known per-user override can be removed.");
      const id: string = limitId.parse(action.expected.override_id);
      const deleted = z.object({ type: z.literal("spend_limit_deleted"), id: limitId }).parse(await this.#request(`/spend_limits/${id}`, "DELETE"));
      if (deleted.id !== id) throw new Error("Claude deleted-limit response identity mismatch.");
    }
  }

  async #request(path: string, method: "GET" | "POST" | "DELETE", body?: object): Promise<unknown> {
    const response: Response = await this.#fetch(`https://api.anthropic.com/v1/organizations${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "x-api-key": this.#apiKey, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Claude administration returned HTTP ${response.status}.`);
    const text: string = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Claude administration response exceeded its size limit.");
    return JSON.parse(text);
  }
}
