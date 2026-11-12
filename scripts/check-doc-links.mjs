#!/usr/bin/env node
// Fails when a Markdown file links to a repository file or heading that does not exist.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skip = new Set(["node_modules", "dist", ".git"]);
function* markdown(directory) {
  for (const name of readdirSync(directory)) {
    if (skip.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* markdown(path);
    else if (name.endsWith(".md") || name === "llms.txt") yield path;
  }
}
const slug = (heading) => heading.trim().toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");
const anchors = (path) => new Set([...readFileSync(path, "utf8").matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1])));
const broken = [];
for (const file of markdown(root)) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target) || target.startsWith("mailto:")) continue;
    const [path, anchor] = target.split("#");
    const resolved = path ? resolve(dirname(file), path) : file;
    if (!existsSync(resolved)) broken.push(`${relative(root, file)}: ${target}`);
    else if (anchor && resolved.endsWith(".md") && !anchors(resolved).has(anchor)) broken.push(`${relative(root, file)}: ${target} (missing heading)`);
  }
}
if (broken.length > 0) {
  console.error(`Broken documentation links:\n${broken.join("\n")}`);
  process.exit(1);
}
console.log("Documentation links resolve.");
