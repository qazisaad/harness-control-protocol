import {NativeProcess} from "./native-process.js";
import {HarnessAdapterError} from "../types.js";
import type {ProviderInstanceConfig} from "../../../config/index.js";

const sdk = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
const script = `
import {getSessionInfo, getSessionMessages, getSubagentMessages, listSubagents, forkSession, importSessionToStore} from ${JSON.stringify(sdk)};
import {createHash} from 'node:crypto';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
async function revision() {
  const hash = createHash('sha256'); let size = 0;
  await importSessionToStore(request.sessionId, {async append(_key, entries) {
    for (const entry of entries) {
      const encoded = JSON.stringify(entry) + '\\n'; size += Buffer.byteLength(encoded);
      if (size > 8 * 1024 * 1024) throw new Error('History limit');
      hash.update(encoded);
    }
  }}, {dir: request.cwd, includeSubagents: false});
  return hash.digest('hex');
}
if (request.kind === 'read') {
  const before = await revision();
  const info = await getSessionInfo(request.sessionId, {dir: request.cwd});
  if (!info) throw new Error('Session unavailable');
  const messages = await getSessionMessages(request.sessionId, {dir: request.cwd, includeSystemMessages: true});
  const after = await revision();
  if (before !== after) throw new Error('History changed during read');
  process.stdout.write(JSON.stringify({info, messages, revision: after}));
} else if (request.kind === 'subagent_read') {
  const info = await getSessionInfo(request.sessionId, {dir: request.cwd});
  if (!info || !(await listSubagents(request.sessionId, {dir: request.cwd})).includes(request.agentId))
    throw new Error('Owned subagent transcript unavailable');
  const messages = await getSubagentMessages(request.sessionId, request.agentId, {dir: request.cwd, limit: 10001});
  const encoded = JSON.stringify(messages);
  if (messages.length > 10000 || Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error('History limit');
  const after = await getSubagentMessages(request.sessionId, request.agentId, {dir: request.cwd, limit: 10001});
  if (encoded !== JSON.stringify(after) || !(await listSubagents(request.sessionId, {dir: request.cwd})).includes(request.agentId))
    throw new Error('Subagent history changed during read');
  process.stdout.write(JSON.stringify({info, agentId: request.agentId, messages,
    revision: createHash('sha256').update(encoded).digest('hex')}));
} else if (request.kind === 'fork') {
  process.stdout.write(JSON.stringify(await forkSession(request.sessionId, {dir: request.cwd,
    ...(request.upToMessageId ? {upToMessageId: request.upToMessageId} : {})})));
} else throw new Error('Unsupported helper operation');
`;

/** Session helpers run in the owning provider's environment; process-global account switching is forbidden. */
export async function claudeSessionHelper(provider: ProviderInstanceConfig, cwd: string,
  request: {kind: "read" | "fork"; sessionId: string; upToMessageId?: string} | {kind: "subagent_read"; sessionId: string; agentId: string}, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const processHandle = new NativeProcess(process.execPath, ["--input-type=module", "-e", script], cwd,
    {...process.env, ...provider.env, ...(provider.home ? {CLAUDE_CONFIG_DIR: provider.home} : {})});
  const chunks: Buffer[] = [];
  let size = 0, exceeded = false;
  processHandle.child.stderr.resume();
  processHandle.child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {exceeded = true; void processHandle.stop();}
    else chunks.push(chunk);
  });
  const timer = setTimeout(() => {void processHandle.stop();}, 15_000);
  const abort = () => {void processHandle.stop();};
  signal?.addEventListener("abort", abort, {once: true});
  try {
    processHandle.child.stdin.end(JSON.stringify({...request, cwd}));
    await processHandle.closed;
    signal?.throwIfAborted();
    if (exceeded) throw new HarnessAdapterError("native_history_limit", "Claude session history exceeds the bounded helper limit.");
    if (processHandle.child.exitCode !== 0) throw new HarnessAdapterError("native_history_unavailable", "Claude native session helper could not complete.");
    try {return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
    catch {throw new HarnessAdapterError("native_history_invalid", "Claude native session helper returned invalid data.");}
  } finally {clearTimeout(timer); signal?.removeEventListener("abort", abort); await processHandle.stop();}
}
