import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (args) => execFileSync("npm", args, { cwd: root, stdio: "inherit" });
run(["whoami", "--registry=https://registry.npmjs.org"]);
run(["run", "release:check"]);
const manifest = JSON.parse(readFileSync(new URL("../dist/release/manifest.json", import.meta.url), "utf8"));
for (const pkg of manifest.packages) {
  const artifact = fileURLToPath(new URL(`../dist/release/${pkg.filename}`, import.meta.url));
  const hash = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (hash !== pkg.sha256) throw new Error(`Release artifact changed: ${pkg.name}`);
  run(["publish", artifact, "--access", "public", "--registry=https://registry.npmjs.org"]);
}
