import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RunnerConfigSchema} from "../../../config/index.js";
import {readRetainedCodexHistory, reconcileRetainedCodexWork} from "./codex-retained-history.js";

for (const mode of ["stable", "foreign-parent", "foreign-root", "changing-history", "changed-ancestry", "running-execution", "newer-execution"] as const)
test(`retained Codex custody verifies native ancestry and stable history without resuming (${mode})`, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-retained-codex-")));
  const executable = join(cwd, "provider.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const mode=process.env.PROBE_MODE;let metadata=0, snapshots=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 const reply=result=>process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
 if(m.method==='initialize')return reply({});
 if(m.method!=='thread/read')return process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'A transcript read must not resume or mutate'}})+'\\n');
 const child=m.params.threadId==='child';
 if(child&&!m.params.includeTurns)metadata++;
 if(child&&m.params.includeTurns)snapshots++;
 const parent=mode==='foreign-parent'||mode==='changed-ancestry'&&metadata>2?'foreign':'root';
 reply({thread:{id:m.params.threadId,cwd:mode==='foreign-root'&&!child?'/':process.cwd(),parentThreadId:child?parent:null,
 source:child?{subAgent:{thread_spawn:{parent_thread_id:parent}}}:'cli',
 turns:child&&m.params.includeTurns?[{id:mode==='newer-execution'?'newer-turn':'native-turn',status:mode==='running-execution'?'inProgress':'completed',items:[{id:'message',type:'agentMessage',text:mode==='changing-history'?String(snapshots):'retained answer'}]}]:[]}});
});
`, {mode: 0o700});
  const provider = RunnerConfigSchema.parse({runner_id: "r", control_plane_url: "ws://localhost:1", provider_instances: [
    {id: "codex", driver_kind: "codex", executable_path: executable, env: {PROBE_MODE: mode}}]}).provider_instances[0]!;
  const work = {work_id: "owned", native_reference: "child", origin_turn_id: "app-turn", kind: "agent" as const,
    background: true, status: "completed" as const, supports_cancel: false, revision: 3};
  const custody = {source: "codex" as const, work_id: work.work_id, native_reference: work.native_reference,
    origin_turn_id: work.origin_turn_id, root_native_reference: "root", parent_native_reference: "root", launch_native_reference: "launch"};
  let published = 0;
  const input = {commandId: "read", sessionId: "session", work, custody, provider,
    scope: {provider_instance_id: "codex", provider_binding_hash: "a".repeat(64), workspace_id: "workspace", cwd,
      execution_binding_hash: "b".repeat(64), execution_profile: "interactive"}, page: {},
    publishContent: () => {published++; throw new Error("No large content in this fixture");}, signal: AbortSignal.timeout(5000)};
  try {
    if (["stable", "running-execution", "newer-execution"].includes(mode)) {
      const history = await readRetainedCodexHistory(input);
      assert.equal(history.turn_count, 1);
      assert.equal(history.turns[0]!.items[0]!.text, "retained answer");
    } else await assert.rejects(readRetainedCodexHistory(input), mode === "changing-history" ? /changed during/ : /ancestry|binding/);
    await assert.rejects(reconcileRetainedCodexWork(input), /durably admitted/);
    const reconcile = () => reconcileRetainedCodexWork({...input, custody: {...custody, native_execution_reference: "native-turn"}});
    if (mode === "stable") assert.deepEqual(await reconcile(), {status: "completed"});
    else await assert.rejects(reconcile(), /ancestry|binding|changed during|terminal status|admitted child/);
    assert.equal(published, 0);
    await assert.rejects(readRetainedCodexHistory({...input, signal: AbortSignal.abort(new Error("abandoned"))}), /abandoned/);
  } finally {await rm(cwd, {recursive: true, force: true});}
});
