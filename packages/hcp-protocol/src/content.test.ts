import assert from "node:assert/strict";
import {test} from "node:test";
import {harnessContentChunkSchema} from "./content.js";

const reference = {content_id: "a".repeat(64), sha256: "b".repeat(64), byte_length: 2, format: "text" as const,
  expires_at: "2026-10-06T00:00:00.000Z"};

test("content chunks validate canonical bounded base64 and contiguous byte ranges without Node decoding", () => {
  const first = {reference, offset: 0, data_base64: "eA==", next_offset: 1};
  harnessContentChunkSchema.parse(first);
  harnessContentChunkSchema.parse({reference, offset: 1, data_base64: "eQ=="});
  harnessContentChunkSchema.parse({reference: {...reference, byte_length: 0}, offset: 0, data_base64: ""});
  harnessContentChunkSchema.parse({reference: {...reference, byte_length: 65536}, offset: 0, data_base64: Buffer.alloc(65536).toString("base64")});
  for (const chunk of [{...first, data_base64: "eB=="}, {...first, data_base64: "x"}, {...first, data_base64: "eA==\n"},
    {...first, data_base64: "eA", next_offset: undefined}, {...first, next_offset: 2}, {...first, next_offset: undefined},
    {...first, data_base64: "", next_offset: 0}, {...first, offset: 2}, {...first, data_base64: "eHk=", next_offset: 2},
    {reference: {...reference, byte_length: 65537}, offset: 0, data_base64: Buffer.alloc(65537).toString("base64")}])
    assert.equal(harnessContentChunkSchema.safeParse(chunk).success, false, JSON.stringify(chunk).slice(0, 160));
});
