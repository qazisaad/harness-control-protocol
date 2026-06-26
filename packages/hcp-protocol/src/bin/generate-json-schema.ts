#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHcpMessageJsonSchema } from "../json-schema.js";

const defaultOutputPath = fileURLToPath(new URL("../../schemas/hcp-message.schema.json", import.meta.url));
const outputPath: string = process.argv[2] === undefined ? defaultOutputPath : resolve(process.argv[2]);
const schemaJson: string = `${JSON.stringify(createHcpMessageJsonSchema(), null, 2)}\n`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, schemaJson, "utf8");

process.stdout.write(`${outputPath}\n`);
