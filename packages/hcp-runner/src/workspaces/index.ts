import { createHash, randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { HcpWorkspaceManagement, HcpWorkspacesRequestPayload, HcpWorkspacesResultPayload } from "@harness-control/protocol";
import { updateRunnerConfigFile, type RunnerConfig, type RunnerWorkspaceConfig } from "../config/index.js";
import type { HarnessSessionManager } from "../harnesses/index.js";
import { withWorkspaceGit } from "./git.js";

export class WorkspaceManager {
  constructor(
    private readonly config: RunnerConfig,
    private readonly configPath: string | undefined,
    private readonly sessions: Pick<HarnessSessionManager, "updateWorkspaceConfiguration">,
  ) {}

  snapshot(): HcpWorkspaceManagement {
    return {
      revision: this.config.workspace_revision ?? createHash("sha256").update(JSON.stringify(this.config.workspaces)).digest("hex"),
      allowed_roots: this.configPath ? this.config.workspace_management?.allowed_roots ?? [] : [],
      directory_browsing: true,
    };
  }

  async execute(requestId: string, request: HcpWorkspacesRequestPayload): Promise<HcpWorkspacesResultPayload> {
    let outcome: HcpWorkspacesResultPayload["outcome"];
    try {
      if (request.operation.kind === "browse") {
        outcome = await this.browse(request);
      } else {
        if (request.operation.kind === "list") {
          if (Date.parse(request.expires_at) <= Date.now()) throw new Error("Request expired. Refresh workspaces.");
        } else {
          await this.sessions.updateWorkspaceConfiguration(() => this.change(request));
        }
        outcome = { kind: "success" };
      }
    } catch (error: unknown) {
      outcome = { kind: "error", message: error instanceof Error ? error.message.slice(0, 1000) : "Workspace update failed." };
    }
    // Browsing never changes registrations, so it skips git observation.
    const workspaces = this.config.workspaces.map(workspace => ({ ...workspace }));
    return { request_id: requestId, outcome, management: this.snapshot(), workspaces: request.operation.kind === "browse" ? workspaces : await withWorkspaceGit(workspaces) };
  }

  private async canonicalRoots(): Promise<string[]> {
    const roots = this.snapshot().allowed_roots;
    if (roots.length === 0) throw new Error("Folder browsing is disabled. Configure workspace_management.allowed_roots locally, then restart the runner.");
    return Promise.all(roots.map(root => realpath(root)));
  }

  private async allowedDirectory(path: string, roots: string[]): Promise<string> {
    if (!isAbsolute(path)) throw new Error("Use an absolute folder path on this machine.");
    const canonical = await realpath(path);
    if (!roots.some(root => contained(root, canonical))) throw new Error("The folder is outside this machine’s allowed roots.");
    if (!(await stat(canonical)).isDirectory()) throw new Error("Choose an existing folder.");
    return canonical;
  }

  private async browse(request: HcpWorkspacesRequestPayload): Promise<Extract<HcpWorkspacesResultPayload["outcome"], { kind: "directory" }>> {
    if (request.operation.kind !== "browse") throw new Error("Expected a folder browsing request.");
    const operation = request.operation;
    if (Date.parse(request.expires_at) <= Date.now()) throw new Error("Folder request expired. Try again.");
    const roots = await this.canonicalRoots();
    const home = homedir();
    const path = await this.allowedDirectory(operation.path ?? (roots.some(root => contained(root, home)) ? home : roots[0]!), roots);
    const candidates = (await readdir(path, { withFileTypes: true }))
      .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && (!operation.cursor || entry.name > operation.cursor))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const entries: { name: string; path: string }[] = [];
    let pageBytes = 0;
    let hasMore = false;
    for (const entry of candidates) {
      if (Date.parse(request.expires_at) <= Date.now()) throw new Error("Folder request expired. Try again.");
      const candidate = join(path, entry.name);
      try {
        const canonical = await realpath(candidate);
        if (roots.some(root => contained(root, canonical)) && (await stat(canonical)).isDirectory()) {
          const item = { name: entry.name, path: canonical };
          const bytes = Buffer.byteLength(JSON.stringify(item));
          if (entries.length === 200 || pageBytes + bytes > 64 * 1024) { hasMore = true; break; }
          entries.push(item); pageBytes += bytes;
        }
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(String(error.code)))) throw error;
      }
    }
    const parent = dirname(path);
    return { kind: "directory", path, ...(parent !== path && roots.some(root => contained(root, parent)) ? { parent } : {}),
      entries, ...(hasMore ? { next_cursor: entries.at(-1)!.name } : {}) };
  }

  private async change(request: HcpWorkspacesRequestPayload): Promise<void> {
    if (Date.parse(request.expires_at) <= Date.now()) throw new Error("Request expired. Refresh workspaces.");
    const configPath = this.configPath;
    const roots = this.snapshot().allowed_roots;
    if (!configPath || roots.length === 0) throw new Error("Workspace management is disabled. Configure workspace_management.allowed_roots locally, then restart the runner.");
    if (request.expected_revision !== this.snapshot().revision) throw new Error("Workspaces changed. Refresh and try again.");
    const operation = request.operation;
    let workspaces: RunnerWorkspaceConfig[] = this.config.workspaces.map(workspace => ({ ...workspace }));
    if (operation.kind === "add") {
      const path = await this.allowedDirectory(operation.path, await this.canonicalRoots());
      const existingPaths = await Promise.all(workspaces.map(async workspace => {
        try { return await realpath(workspace.path); }
        catch (error: unknown) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return workspace.path;
          throw error;
        }
      }));
      if (existingPaths.includes(path)) throw new Error("This folder is already registered.");
      workspaces.push({ id: randomUUID(), path, display_name: operation.display_name });
    } else if (operation.kind === "rename" || operation.kind === "remove") {
      const workspace = workspaces.find(entry => entry.id === operation.id);
      if (!workspace) throw new Error("Workspace no longer exists. Refresh the list.");
      if (operation.kind === "rename") workspace.display_name = operation.display_name;
      else workspaces = workspaces.filter(entry => entry.id !== operation.id);
    }
    await updateRunnerConfigFile(configPath, this.config, raw => ({ ...raw, workspaces, workspace_revision: randomUUID() }));
  }
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
