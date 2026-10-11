import { execFile } from "node:child_process";
import { redactGitRemote, type HcpWorkspaceGit, type HcpWorkspaceSnapshot } from "@harness-control/protocol";

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const CONCURRENCY = 8;
const HASH = /^[0-9a-f]{40,64}$/;

/** Runs one read-only git command; resolves undefined on any failure or timeout. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile("git", ["--no-optional-locks", ...args], {
      cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true,
      // No user hooks, pagers, prompts or credential helpers participate in detection.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/**
 * Observes repository identity and state for one folder. Detection is
 * best-effort: a field is omitted when it is unknown, never guessed.
 */
export async function detectWorkspaceGit(path: string): Promise<HcpWorkspaceGit | undefined> {
  if ((await git(path, ["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return undefined;
  const [remotes, head, branch, roots, status] = await Promise.all([
    git(path, ["remote"]),
    git(path, ["rev-parse", "--verify", "-q", "HEAD"]),
    git(path, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(path, ["rev-list", "--max-parents=0", "HEAD"]),
    git(path, ["status", "--porcelain=v1"]),
  ]);
  const names = remotes?.split("\n").map(name => name.trim()).filter(Boolean) ?? [];
  const remoteName = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined;
  const remote = remoteName ? (await git(path, ["remote", "get-url", remoteName]))?.trim() : undefined;
  const headCommit = head?.trim();
  // A history can have several parentless commits (merged histories); the sorted first is stable.
  const rootCommit = roots?.split("\n").map(line => line.trim()).filter(line => HASH.test(line)).sort()[0];
  const branchName = branch?.trim();
  const result: HcpWorkspaceGit = {
    ...(remote ? { remote: redactGitRemote(remote).slice(0, 2048) } : {}),
    ...(rootCommit ? { root_commit: rootCommit } : {}),
    ...(branchName ? { branch: branchName.slice(0, 512) } : {}),
    ...(headCommit && HASH.test(headCommit) ? { head_commit: headCommit } : {}),
    ...(status === undefined ? {} : { dirty: status.trim().length > 0 }),
  };
  return result;
}

/** Adds observed git state to workspace snapshots with bounded concurrency. */
export async function withWorkspaceGit<T extends Pick<HcpWorkspaceSnapshot, "path">>(workspaces: T[]): Promise<Array<T & { git?: HcpWorkspaceGit }>> {
  const result: Array<T & { git?: HcpWorkspaceGit }> = workspaces.map(workspace => ({ ...workspace }));
  let next = 0;
  const worker = async () => {
    while (next < result.length) {
      const workspace = result[next++]!;
      const observed = await detectWorkspaceGit(workspace.path);
      if (observed && Object.keys(observed).length) workspace.git = observed;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, result.length) }, worker));
  return result;
}
