// Regenerates the provider support matrix in docs/native-providers.md from the
// runner's capability declarations. With --check, fails instead of writing when
// the committed document is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replaceProviderMatrix } from "../packages/hcp-runner/src/harnesses/provider-matrix.ts";

const documentPath = fileURLToPath(new URL("../docs/native-providers.md", import.meta.url));
const check = process.argv.includes("--check");
const current = readFileSync(documentPath, "utf8");
const updated = replaceProviderMatrix(current);

if (current === updated) {
  console.log("docs/native-providers.md provider matrix is up to date.");
} else if (check) {
  console.error("docs/native-providers.md provider matrix is stale. Run `npm run docs:providers`.");
  process.exitCode = 1;
} else {
  writeFileSync(documentPath, updated);
  console.log("Updated docs/native-providers.md provider matrix.");
}
