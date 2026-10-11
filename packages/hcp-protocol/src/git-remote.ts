import {z} from "zod";

/**
 * Git state observed by the runner for a registered workspace. Every field is
 * optional: absence means unknown or not applicable, never "clean" or "none".
 * Remotes never carry credentials; see {@link redactGitRemote}.
 */
export const hcpWorkspaceGitSchema = z.object({
  /** Credential-free URL of the `origin` remote, or the only remote. */
  remote: z.string().min(1).max(2048).optional(),
  /** Oldest parentless commit reachable from HEAD; stable identity across clones. */
  root_commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  branch: z.string().min(1).max(512).optional(),
  head_commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  /** Tracked or untracked changes exist in the worktree. */
  dirty: z.boolean().optional(),
}).strict();
export type HcpWorkspaceGit = z.infer<typeof hcpWorkspaceGitSchema>;

/** Removes user info, query and fragment so a remote can be published or logged. */
export function redactGitRemote(remote: string): string {
  const value = remote.trim();
  const scp = /^([^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(value);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return `${scp[2]}:${scp[3]}`;
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch {return value;}
}

/**
 * Canonical comparison key for a git remote: `host/path` in lower case without
 * scheme, user info, port, `.git` suffix or trailing slashes. SSH, scp-like and
 * HTTPS forms of the same repository compare equal. Local paths are kept as-is.
 */
export function normalizeGitRemote(remote: string): string {
  const value = remote.trim();
  let host: string, path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(value);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {[, host, path] = scp as unknown as [string, string, string];}
  else {
    try {
      const url = new URL(value);
      if (url.protocol === "file:") return url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
      host = url.hostname; path = url.pathname;
    } catch {return value.replace(/\/+$/, "").replace(/\.git$/i, "");}
  }
  return `${host.toLowerCase()}/${path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")}`.toLowerCase();
}
