import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectMachine, openApprovalBrowser, parseConnectOptions } from "../connect.js";
import { loadRunnerConfig } from "../config/index.js";

test("guided setup exchanges once, saves private config, starts immediately, and reconnects without changing folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hcp-connect-"));
  const priorPath = process.env.PATH;
  let pairingCount = 0;
  let cancelPairing = false;
  let identity: {runner_id: string; host_id: string} = {runner_id:"",host_id:""};
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    res.setHeader("content-type", "application/json");
    if (req.url === "/pairing-codes") {
      const parsed = JSON.parse(body) as typeof identity; identity = {runner_id:parsed.runner_id,host_id:parsed.host_id}; pairingCount++;
      if (cancelPairing) setImmediate(()=>process.emit("SIGINT"));
      res.end(JSON.stringify({request_id:"request",pairing_code:"ABCDEF123456",pairing_url:`${base.replace("ws:","http:")}/approve`,expires_at:new Date(Date.now()+10000).toISOString(),poll_interval_seconds:1}));
    } else res.end(JSON.stringify({status:"approved",control_plane_url:base,credential:{...identity,credential_id:"credential",credential_secret:"secret",mcp_proof_secret:"proof",issued_at:new Date().toISOString(),control_plane_url:base}}));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `ws://127.0.0.1:${address.port}/hcp/runner`;
  try {
    for (const name of ["codex","claude","opencode","open","xdg-open"]) {
      await writeFile(join(dir,name), `#!${process.execPath}\n${name === "codex" ? 'if(process.argv.includes("--version")) console.log("codex-test"); else process.exitCode=1;' : 'process.exitCode=1;'}`, {mode:0o700});
    }
    process.env.PATH = dir;
    assert.equal(await openApprovalBrowser("http://localhost/approve"),false);
    const options = parseConnectOptions([base,"--providers","codex","--no-browser"],dir);
    await connectMachine(options, async path => {
      const config = await loadRunnerConfig(path);
      assert.equal(config.provider_instances[0]?.driver_kind,"codex");
      assert.equal(config.workspaces.length,0);
      assert.equal((await stat(path)).mode & 0o777,0o600);
      assert.equal((await stat(config.credentials_path!)).mode & 0o777,0o600);
      assert.ok(config.workspace_management?.allowed_roots.length);
      await assert.rejects(connectMachine(options,async()=>0),/already in use/);
      await writeFile(path,JSON.stringify({...config,workspaces:[{id:"chosen",path:dir}],workspace_management:{allowed_roots:[dir]}}));
      return 0;
    });
    const before = await readFile(options.configPath,"utf8");
    await connectMachine(options, async path => {
      assert.equal(await readFile(path,"utf8"),before); return 0;
    });
    assert.equal(pairingCount,1);
    await assert.rejects(connectMachine({...parseConnectOptions([base,"--no-browser"],dir),controlPlaneUrl:"wss://other.example/hcp/runner"},async()=>0),/another control plane/);
    cancelPairing = true;
    await assert.rejects(connectMachine({...options,pair:true},async()=>0),/Setup cancelled/);
    assert.equal(await readFile(options.configPath,"utf8"),before);
    await assert.rejects(stat(`${options.configPath}.lock`),{code:"ENOENT"});
  } finally {
    process.env.PATH = priorPath;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});

test("connect validates arguments and approval URLs before doing work", async () => {
  assert.throws(()=>parseConnectOptions([]),/Usage/);
  assert.throws(()=>parseConnectOptions(["ws://remote.example/hcp/runner"]),/HTTPS|WSS|secure|localhost|loopback/i);
  assert.throws(()=>parseConnectOptions(["wss://example.com/hcp/runner","--providers","codex,codex"]),/duplicates/);
  assert.throws(()=>parseConnectOptions(["wss://example.com/hcp/runner","--providers","--pair"]),/requires a value/);
  assert.throws(()=>parseConnectOptions(["wss://example.com/hcp/runner","--bad"]),/Unknown/);
  await assert.rejects(openApprovalBrowser("file:///tmp/approve"),/Invalid/);
});
