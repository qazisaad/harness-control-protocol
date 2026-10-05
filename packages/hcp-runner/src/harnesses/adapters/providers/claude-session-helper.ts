import {NativeProcess} from "./native-process.js";
import {HarnessAdapterError} from "../types.js";
import type {ProviderInstanceConfig} from "../../../config/index.js";

const sdk = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
const script = `
import {getSessionInfo, getSessionMessages, forkSession} from ${JSON.stringify(sdk)};
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.kind === 'read') {
  const info = await getSessionInfo(request.sessionId, {dir: request.cwd});
  if (!info) throw new Error('Session unavailable');
  const messages = await getSessionMessages(request.sessionId, {dir: request.cwd, includeSystemMessages: true});
  process.stdout.write(JSON.stringify({info, messages}));
} else if (request.kind === 'fork') {
  process.stdout.write(JSON.stringify(await forkSession(request.sessionId, {dir: request.cwd,
    ...(request.upToMessageId ? {upToMessageId: request.upToMessageId} : {})})));
} else throw new Error('Unsupported helper operation');
`;

/** Session helpers run in the owning provider's environment; process-global account switching is forbidden. */
export async function claudeSessionHelper(provider: ProviderInstanceConfig, cwd: string,
  request: {kind: "read" | "fork"; sessionId: string; upToMessageId?: string}): Promise<unknown> {
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
  try {
    processHandle.child.stdin.end(JSON.stringify({...request, cwd}));
    await processHandle.closed;
    if (exceeded) throw new HarnessAdapterError("native_history_limit", "Claude session history exceeds the bounded helper limit.");
    if (processHandle.child.exitCode !== 0) throw new HarnessAdapterError("native_history_unavailable", "Claude native session helper could not complete.");
    try {return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
    catch {throw new HarnessAdapterError("native_history_invalid", "Claude native session helper returned invalid data.");}
  } finally {clearTimeout(timer); await processHandle.stop();}
}
