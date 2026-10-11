import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectWorkspaceGit, withWorkspaceGit } from "./git.js";

test("git detection reports credential-free identity and worktree state, and omits non-repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcp-git-"));
  const plain = await mkdtemp(join(tmpdir(), "hcp-plain-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root }).toString().trim();
  try {
    git("init", "-q", "-b", "trunk");
    assert.deepEqual(await detectWorkspaceGit(root), { branch: "trunk", dirty: false });
    git("remote", "add", "origin", "https://user:token@example.com/acme/repo.git?x=1");
    git("commit", "-q", "--allow-empty", "-m", "root");
    const head = git("rev-parse", "HEAD");
    await writeFile(join(root, "change.txt"), "x");
    assert.deepEqual(await detectWorkspaceGit(root), { remote: "https://example.com/acme/repo.git", root_commit: head, branch: "trunk", head_commit: head, dirty: true });
    assert.equal(await detectWorkspaceGit(plain), undefined);
    const [observed, unobserved] = await withWorkspaceGit([{ id: "a", path: root }, { id: "b", path: plain }]);
    assert.equal(observed?.git?.root_commit, head);
    assert.deepEqual(unobserved, { id: "b", path: plain });
  } finally { await rm(root, { recursive: true, force: true }); await rm(plain, { recursive: true, force: true }); }
});
