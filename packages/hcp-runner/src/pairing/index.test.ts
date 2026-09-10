import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pairWithReferenceControlPlane, writeRunnerCredentials, type RunnerCredential } from "./index.js";

test("pairing shows approval instructions before polling and binds exchange to a separate secret", async () => {
  let codeShown = false;
  let polls = 0;
  let secretHash = "";
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, string>;
    requests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/pairing-codes") {
      assert.equal(body.exchange_secret, undefined);
      secretHash = body.exchange_secret_hash!;
      res.end(JSON.stringify({ request_id: "request", pairing_code: "DISPLAY", pairing_url: `${base}/approve`, expires_at: new Date(Date.now() + 5000).toISOString(), poll_interval_seconds: 1 }));
    } else {
      assert.equal(codeShown, true);
      assert.equal(body.pairing_code, undefined);
      assert.equal(body.request_id, "request");
      assert.equal(createHash("sha256").update(body.exchange_secret!).digest("hex"), secretHash);
      polls++;
      res.end(JSON.stringify(polls === 1 ? { status: "pending" } : {
        status: "approved", control_plane_url: base,
        credential: credential(base),
      }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const result = await pairWithReferenceControlPlane({ controlPlaneUrl: base, runnerId: "runner", hostId: "host", onPairingCode: code => { assert.equal(code.pairing_code, "DISPLAY"); codeShown = true; } });
    assert.equal(result.credential.mcp_proof_secret, "separate-proof-secret");
    assert.equal(polls, 2);
    assert.deepEqual(requests, ["/pairing-codes", "/pairing-exchange", "/pairing-exchange"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("credential writes restrict an existing file and never replace the proof key with the login secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hcp-credentials-"));
  const path = join(dir, "credentials.json");
  try {
    await writeFile(path, JSON.stringify({ version: 1, credentials: [] }), { mode: 0o644 });
    await writeRunnerCredentials(path, credential("https://control.example/hcp/runner"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(path, "utf8")) as { credentials: RunnerCredential[] };
    assert.notEqual(stored.credentials[0]!.credential_secret, stored.credentials[0]!.mcp_proof_secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function credential(base: string): RunnerCredential {
  return { credential_id: "credential", credential_secret: "login-secret", runner_id: "runner", host_id: "host", control_plane_url: base, issued_at: new Date().toISOString(), mcp_proof_secret: "separate-proof-secret" };
}
