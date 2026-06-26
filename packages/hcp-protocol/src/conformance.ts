import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { ZodError } from "zod";

import { parseHcpMessage } from "./index.js";

export type ConformanceExpectation = "valid" | "invalid";

export type ConformanceTarget = {
  path: string;
  expectation?: ConformanceExpectation;
};

export type ConformanceRunOptions = {
  targets: ConformanceTarget[];
  cwd?: string;
};

export type ConformanceCase = {
  filePath: string;
  expectation: ConformanceExpectation;
};

export type ConformanceCaseResult = ConformanceCase & {
  ok: boolean;
  message: string;
};

export type ConformanceRunResult = {
  ok: boolean;
  caseCount: number;
  validCount: number;
  invalidCount: number;
  results: ConformanceCaseResult[];
  failures: ConformanceCaseResult[];
};

export type ConformanceCliParseResult =
  | {
      kind: "run";
      targets: ConformanceTarget[];
    }
  | {
      kind: "help";
    };

export type ConformanceCliResult = {
  exitCode: number;
  output: string;
  errorOutput: string;
};

const jsonExtension = ".json";

function isConformanceExpectation(value: string): value is ConformanceExpectation {
  return value === "valid" || value === "invalid";
}

function expectationForDirectoryName(path: string): ConformanceExpectation | undefined {
  const directoryName: string = basename(path);
  return isConformanceExpectation(directoryName) ? directoryName : undefined;
}

function toResolvedPath(path: string, cwd: string): string {
  return resolve(cwd, path);
}

async function collectJsonFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const nestedFiles: string[][] = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const entryPath: string = resolve(directoryPath, entry.name);
      if (entry.isDirectory()) {
        return collectJsonFiles(entryPath);
      }
      if (entry.isFile() && extname(entry.name) === jsonExtension) {
        return [entryPath];
      }
      return [];
    }),
  );
  return nestedFiles.flat().sort((left: string, right: string): number => left.localeCompare(right));
}

async function targetDirectoryContainsExpectationDirs(directoryPath: string): Promise<boolean> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  return entries.some(
    (entry): boolean => entry.isDirectory() && (entry.name === "valid" || entry.name === "invalid"),
  );
}

async function collectCasesForExpectationDirectory(
  directoryPath: string,
  expectation: ConformanceExpectation,
): Promise<ConformanceCase[]> {
  const files: string[] = await collectJsonFiles(directoryPath);
  return files.map(
    (filePath: string): ConformanceCase => ({
      filePath,
      expectation,
    }),
  );
}

async function collectCasesForTarget(target: ConformanceTarget, cwd: string): Promise<ConformanceCase[]> {
  const targetPath: string = toResolvedPath(target.path, cwd);
  const targetStat = await stat(targetPath);

  if (targetStat.isFile()) {
    if (extname(targetPath) !== jsonExtension) {
      throw new TypeError(`Conformance file must be a JSON file: ${targetPath}`);
    }
    return [
      {
        filePath: targetPath,
        expectation: target.expectation ?? "valid",
      },
    ];
  }

  if (!targetStat.isDirectory()) {
    throw new TypeError(`Conformance target must be a file or directory: ${targetPath}`);
  }

  if (target.expectation !== undefined) {
    return collectCasesForExpectationDirectory(targetPath, target.expectation);
  }

  const directoryExpectation: ConformanceExpectation | undefined = expectationForDirectoryName(targetPath);
  if (directoryExpectation !== undefined) {
    return collectCasesForExpectationDirectory(targetPath, directoryExpectation);
  }

  if (await targetDirectoryContainsExpectationDirs(targetPath)) {
    const validCases: ConformanceCase[] = await collectCasesForExpectationDirectory(resolve(targetPath, "valid"), "valid");
    const invalidCases: ConformanceCase[] = await collectCasesForExpectationDirectory(
      resolve(targetPath, "invalid"),
      "invalid",
    );
    return [...validCases, ...invalidCases].sort((left: ConformanceCase, right: ConformanceCase): number =>
      left.filePath.localeCompare(right.filePath),
    );
  }

  return collectCasesForExpectationDirectory(targetPath, "valid");
}

function validateConformanceCaseContents(content: string, expectation: ConformanceExpectation): ConformanceCaseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return {
        filePath: "",
        expectation,
        ok: false,
        message: `Invalid JSON: ${error.message}`,
      };
    }
    throw error;
  }

  try {
    parseHcpMessage(parsed);
    return {
      filePath: "",
      expectation,
      ok: expectation === "valid",
      message: expectation === "valid" ? "accepted" : "accepted but expected rejection",
    };
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return {
        filePath: "",
        expectation,
        ok: expectation === "invalid",
        message: expectation === "invalid" ? "rejected" : error.issues[0]?.message ?? "rejected",
      };
    }
    throw error;
  }
}

async function validateConformanceCase(testCase: ConformanceCase): Promise<ConformanceCaseResult> {
  const content: string = await readFile(testCase.filePath, "utf8");
  const result: ConformanceCaseResult = validateConformanceCaseContents(content, testCase.expectation);
  return {
    ...result,
    filePath: testCase.filePath,
  };
}

export async function collectConformanceCases(options: ConformanceRunOptions): Promise<ConformanceCase[]> {
  const cwd: string = options.cwd ?? process.cwd();
  const casesByTarget: ConformanceCase[][] = await Promise.all(
    options.targets.map((target: ConformanceTarget): Promise<ConformanceCase[]> => collectCasesForTarget(target, cwd)),
  );
  return casesByTarget.flat().sort((left: ConformanceCase, right: ConformanceCase): number =>
    left.filePath.localeCompare(right.filePath),
  );
}

export async function validateConformanceTargets(options: ConformanceRunOptions): Promise<ConformanceRunResult> {
  const testCases: ConformanceCase[] = await collectConformanceCases(options);
  const results: ConformanceCaseResult[] = await Promise.all(
    testCases.map((testCase: ConformanceCase): Promise<ConformanceCaseResult> => validateConformanceCase(testCase)),
  );
  const failures: ConformanceCaseResult[] = results.filter((result: ConformanceCaseResult): boolean => !result.ok);
  const validCount: number = results.filter(
    (result: ConformanceCaseResult): boolean => result.expectation === "valid",
  ).length;
  const invalidCount: number = results.length - validCount;

  return {
    ok: failures.length === 0,
    caseCount: results.length,
    validCount,
    invalidCount,
    results,
    failures,
  };
}

export function parseConformanceCliArgs(args: readonly string[]): ConformanceCliParseResult {
  const targets: ConformanceTarget[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg: string | undefined = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--fixtures") {
      const path: string | undefined = args[index + 1];
      if (path === undefined) {
        throw new TypeError("--fixtures requires a path.");
      }
      targets.push({ path });
      index += 1;
      continue;
    }
    if (arg === "--valid-dir" || arg === "--invalid-dir") {
      const path: string | undefined = args[index + 1];
      if (path === undefined) {
        throw new TypeError(`${arg} requires a path.`);
      }
      targets.push({
        path,
        expectation: arg === "--valid-dir" ? "valid" : "invalid",
      });
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new TypeError(`Unknown option: ${arg}`);
    }
    targets.push({ path: arg });
  }

  if (targets.length === 0) {
    return { kind: "help" };
  }

  return {
    kind: "run",
    targets,
  };
}

export function conformanceUsage(): string {
  return [
    "Usage: hcp-protocol-conformance [--fixtures <dir>] [--valid-dir <dir>] [--invalid-dir <dir>] [file-or-dir ...]",
    "",
    "Directories named valid are expected to parse successfully.",
    "Directories named invalid are expected to be rejected by the protocol parser.",
    "Standalone JSON files are expected to parse successfully.",
  ].join("\n");
}

function formatConformanceResult(result: ConformanceRunResult): string {
  const summary: string = `${result.caseCount} cases checked (${result.validCount} valid, ${result.invalidCount} invalid)`;
  if (result.ok) {
    return `ok - ${summary}`;
  }
  const failureLines: string[] = result.failures.map(
    (failure: ConformanceCaseResult): string =>
      `not ok - ${failure.filePath} (${failure.expectation}): ${failure.message}`,
  );
  return [`failed - ${summary}`, ...failureLines].join("\n");
}

export async function runConformanceCli(args: readonly string[], cwd = process.cwd()): Promise<ConformanceCliResult> {
  const parsed: ConformanceCliParseResult = parseConformanceCliArgs(args);
  if (parsed.kind === "help") {
    return {
      exitCode: 0,
      output: `${conformanceUsage()}\n`,
      errorOutput: "",
    };
  }

  const result: ConformanceRunResult = await validateConformanceTargets({
    targets: parsed.targets,
    cwd,
  });
  return {
    exitCode: result.ok ? 0 : 1,
    output: `${formatConformanceResult(result)}\n`,
    errorOutput: "",
  };
}
