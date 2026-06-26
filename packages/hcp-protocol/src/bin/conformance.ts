#!/usr/bin/env node
import { runConformanceCli } from "../conformance.js";

const result = await runConformanceCli(process.argv.slice(2));

if (result.output.length > 0) {
  process.stdout.write(result.output);
}
if (result.errorOutput.length > 0) {
  process.stderr.write(result.errorOutput);
}

process.exitCode = result.exitCode;
