import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });
const output = resolve(root, "dist/release");
mkdirSync(output, { recursive: true });
run("npm", ["run", "build"]);
run("npm", ["test"]);
const manifests = [];
for (const directory of ["hcp-protocol", "hcp-sdk", "hcp-runner"]) {
  const cwd = join(root, "packages", directory);
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", output], { cwd, encoding: "utf8" }));
  assert.ok(packed.files.some(file => file.path === "LICENSE"));
  assert.ok(packed.files.some(file => file.path === "README.md"));
  assert.ok(!packed.files.some(file => /\.test\.|^src\//.test(file.path)));
  manifests.push({ name: packed.name, version: packed.version, filename: packed.filename,
    sha256: createHash("sha256").update(readFileSync(join(output, packed.filename))).digest("hex") });
}
assert.equal(new Set(manifests.map(pkg => pkg.version)).size, 1);
const consumer = mkdtempSync(join(tmpdir(), "hcp-package-consumer-"));
try {
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...manifests.map(pkg => join(output, pkg.filename)), "ws@^8.21.0"], consumer);
  run(join(consumer, "node_modules/.bin/hcp-runner"), ["version"], consumer);
  run(process.execPath, ["--input-type=module", "-e", "await import('@harness-control/runner/accounts'); await import('@harness-control/runner'); await import('@harness-control/runner/pairing'); await import('@harness-control/protocol/json-schema'); await import('@harness-control/protocol/conformance'); console.log('Public exports imported without CLI side effects')"], consumer);
  copyFileSync(join(root, "examples/public-sdk.mjs"), join(consumer, "example.mjs"));
  run(process.execPath, ["example.mjs"], consumer);
  writeFileSync(join(output, "manifest.json"), JSON.stringify({ packages: manifests }, null, 2) + "\n");
  console.log(`Validated release artifacts: ${output}`);
} finally { rmSync(consumer, { recursive: true, force: true }); }
