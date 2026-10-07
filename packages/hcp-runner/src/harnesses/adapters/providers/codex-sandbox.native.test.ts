import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, realpath, readFile, access} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir, homedir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {ProviderInstanceConfigSchema} from "../../../config/index.js";
import {CodexHarnessAdapter} from "./codex.js";
import {CodexRpc} from "./codex-rpc.js";
import {initializeCodexConversation} from "./codex-runtime.js";

// Native command component evidence; these standalone commands do not become HCP root/child phases.
test("installed Codex enforces an accepted workspace sandbox's write roots and network flag", {
  skip: process.env.HCP_NATIVE_SANDBOX_CONTROL !== "1", timeout: 60_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-sandbox-command-"))), cwd = join(root, "current"), extra = join(root, "extra"), outside = join(root, "unregistered");
  await mkdir(cwd);await mkdir(extra);await mkdir(outside);
  let calls = 0;
  const http = createServer((_request, response) => {calls++;response.end("HCP_SANDBOX_TOY");});
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();assert.ok(address && typeof address !== "string");
  const provider = ProviderInstanceConfigSchema.parse({id: "codex", driver_kind: "codex", executable_path: process.env.HCP_LIVE_CODEX_EXECUTABLE ?? join(homedir(), ".local/bin/codex")});
  const adapter = new CodexHarnessAdapter();
  try {
    const status = await adapter.probe(provider);assert.equal(status.available, true);assert.match(status.version ?? "", /^codex-cli 0\.160\.[01]$/);
    const model = process.env.HCP_LIVE_CODEX_MODEL ?? status.models.find(model => model.is_default)?.id;assert.ok(model);
    for (const network_access of [false, true]) {
      const rpc = new CodexRpc(provider.executable_path!, cwd, process.env), turns: string[] = [];
      rpc.observeNotifications(message => {if (message.method?.startsWith("turn/")) turns.push(message.method);});
      try {
        const selection = {model};
        const {started} = await initializeCodexConversation({provider, session: {adapter_session_id: `sandbox-${network_access}`}, mcpServers: [],
          startPayload: {session_id: `sandbox-${network_access}`, workspace_id: "current", cwd, provider_instance_id: "codex", driver_kind: "codex",
            execution_profile: "interactive", sandbox_mode: "workspace_write", approval_policy: "full_access", continue_session: false, model_selection: selection,
            mcp_servers: [], sandbox_options: {network_access, writable_roots: [{workspace_id: "extra", path: extra}]}}}, selection, rpc);
        assert.equal(started.sandbox.networkAccess, network_access);
        const execute = async (command: string[]) => z.object({exitCode: z.number().int(), stdout: z.string().max(1024), stderr: z.string().max(1024)}).parse(
          await rpc.request("command/exec", {command, cwd, sandboxPolicy: started.sandbox, processId: randomUUID(), timeoutMs: 3000, outputBytesCap: 256}, {signal: AbortSignal.timeout(10_000)}));
        const allowed = join(extra, `allowed-${network_access}.txt`), denied = join(outside, `denied-${network_access}.txt`);
        const write = ["/bin/sh", "-c", 'printf AUTHORIZED > "$1"', "sh"];
        assert.equal((await execute([...write, allowed])).exitCode, 0);assert.equal(await readFile(allowed, "utf8"), "AUTHORIZED");
        assert.notEqual((await execute([...write, denied])).exitCode, 0);await assert.rejects(access(denied));
        const before = calls, network = await execute(["/usr/bin/curl", "--max-time", "2", "--silent", "--show-error", `http://127.0.0.1:${address.port}/toy`]);
        assert.equal(calls - before, network_access ? 1 : 0);
        if (network_access) {assert.equal(network.exitCode, 0);assert.equal(network.stdout, "HCP_SANDBOX_TOY");}
        else assert.notEqual(network.exitCode, 0);
        assert.deepEqual(turns, []);
      } finally {await rpc.process.stop();}
    }
  } finally {await adapter.close();await new Promise<void>(resolve => http.close(() => resolve()));}
});
