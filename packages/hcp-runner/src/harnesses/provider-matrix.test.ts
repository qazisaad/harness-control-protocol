import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROVIDER_MATRIX_END, PROVIDER_MATRIX_START, renderProviderMatrix, replaceProviderMatrix } from "./provider-matrix.js";

const documentPath = fileURLToPath(new URL("../../../../docs/native-providers.md", import.meta.url));

test("docs/native-providers.md carries the current generated provider matrix", () => {
  const document = readFileSync(documentPath, "utf8");
  assert.equal(replaceProviderMatrix(document), document,
    "The provider matrix is stale. Run `npm run docs:providers` from the repository root.");
});

test("the provider matrix replaces exactly one marked region", () => {
  const matrix = renderProviderMatrix();
  assert.equal(replaceProviderMatrix(`before\n${PROVIDER_MATRIX_START}\nold\n${PROVIDER_MATRIX_END}\nafter`, matrix),
    `before\n${matrix}\nafter`);
  assert.throws(() => replaceProviderMatrix("no markers", matrix), /Expected exactly one/);
  assert.throws(() => replaceProviderMatrix(`${PROVIDER_MATRIX_START}${PROVIDER_MATRIX_END}${PROVIDER_MATRIX_START}${PROVIDER_MATRIX_END}`, matrix),
    /Expected exactly one/);
});
