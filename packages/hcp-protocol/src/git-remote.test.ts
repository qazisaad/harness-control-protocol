import assert from "node:assert/strict";
import {test} from "node:test";
import {hcpWorkspaceGitSchema, normalizeGitRemote, redactGitRemote} from "./git-remote.js";

test("equivalent SSH, scp-like and HTTPS remotes normalize to one repository key", () => {
  const key = "github.com/acme/repo";
  for (const remote of ["git@github.com:Acme/Repo.git", "ssh://git@github.com:22/acme/repo.git", "https://user:token@GitHub.com/acme/repo/",
    "https://github.com/acme/repo.git", "git://github.com/acme/repo"]) assert.equal(normalizeGitRemote(remote), key);
  assert.notEqual(normalizeGitRemote("https://github.com/acme/other.git"), key);
  assert.equal(normalizeGitRemote("file:///srv/git/repo.git"), "/srv/git/repo");
});

test("published remotes never carry credentials", () => {
  assert.equal(redactGitRemote("https://user:token@github.com/acme/repo.git?a=1#x"), "https://github.com/acme/repo.git");
  assert.equal(redactGitRemote("git@github.com:acme/repo.git"), "github.com:acme/repo.git");
  assert.equal(redactGitRemote("/srv/git/repo.git"), "/srv/git/repo.git");
});

test("workspace git state is strict and requires full commit hashes", () => {
  assert.ok(hcpWorkspaceGitSchema.safeParse({branch: "main", dirty: true}).success);
  assert.ok(!hcpWorkspaceGitSchema.safeParse({root_commit: "abc"}).success);
  assert.ok(!hcpWorkspaceGitSchema.safeParse({branch: "main", token: "x"}).success);
});
