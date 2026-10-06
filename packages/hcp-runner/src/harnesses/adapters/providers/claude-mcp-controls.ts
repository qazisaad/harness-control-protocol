import {z} from "zod";
import type {Query, McpServerConfig} from "@anthropic-ai/claude-agent-sdk";
import {HarnessAdapterError} from "../types.js";

const inventory = z.array(z.object({name: z.string().min(1).max(512), status: z.literal("connected"),
  config: z.object({type: z.literal("http"), url: z.string()})})).max(128);
const receipt = z.object({added: z.array(z.string()).max(128), removed: z.array(z.string()).max(128), errors: z.record(z.string(), z.string())});
const mismatch = (stage: "inventory_before" | "removal_receipt" | "registration_receipt" | "inventory_after", registration = false) => Object.assign(
  new HarnessAdapterError(registration ? "native_mcp_registration_unknown" : "native_mcp_detach_unknown", "Native MCP control did not confirm the exact owned inventory."), {native_stage: stage});
const equal = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
function ownsInventory(servers: z.infer<typeof inventory>, configurations: Readonly<Record<string, McpServerConfig>>): boolean {
  return equal(servers.map(server => server.name), Object.keys(configurations)) && servers.every(server => {
    const expected = configurations[server.name];
    return expected?.type === "http" && expected.url === server.config.url;
  });
}

/** Startup-owned HTTP servers must enter the dynamic registry to support later removal. */
export async function initializeClaudeMcp(stream: Pick<Query, "mcpServerStatus" | "setMcpServers">,
  configurations: Readonly<Record<string, McpServerConfig>>): Promise<void> {
  const before = inventory.safeParse(await stream.mcpServerStatus());
  if (!before.success || before.data.length) throw mismatch("inventory_before", true);
  const result = receipt.safeParse(await stream.setMcpServers({...configurations}));
  if (!result.success || result.data.removed.length || Object.keys(result.data.errors).length
    || !equal(result.data.added, Object.keys(configurations))) throw mismatch("registration_receipt", true);
  const after = inventory.safeParse(await stream.mcpServerStatus());
  if (!after.success || !ownsInventory(after.data, configurations)) throw mismatch("inventory_after", true);
}

/** Removal only; native inventories and the result must all agree before success. */
export async function detachClaudeMcp(stream: Pick<Query, "mcpServerStatus" | "setMcpServers">,
  configurations: Readonly<Record<string, McpServerConfig>>, names: readonly string[]): Promise<Record<string, McpServerConfig>> {
  if (!names.length || new Set(names).size !== names.length || names.some(name => !Object.hasOwn(configurations, name)))
    throw new HarnessAdapterError("native_mcp_detach_binding", "Only distinct currently owned MCP servers can be removed.");
  const before = inventory.safeParse(await stream.mcpServerStatus());
  if (!before.success || !ownsInventory(before.data, configurations)) throw mismatch("inventory_before");
  const remaining = Object.fromEntries(Object.entries(configurations).filter(([name]) => !names.includes(name)));
  const result = receipt.safeParse(await stream.setMcpServers(remaining));
  if (!result.success || result.data.added.length || Object.keys(result.data.errors).length || !equal(result.data.removed, [...names])) throw mismatch("removal_receipt");
  const after = inventory.safeParse(await stream.mcpServerStatus());
  if (!after.success || !ownsInventory(after.data, remaining)) throw mismatch("inventory_after");
  return remaining;
}
