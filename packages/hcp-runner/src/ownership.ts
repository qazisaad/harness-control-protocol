import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { tryLock } from "fs-native-extensions";
import { z } from "zod";
import { normalizeControlPlaneUrl } from "./pairing/index.js";

const ownerSchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), token: z.string().uuid() }).strict();

export const ALREADY_RUNNING = "HCP is already running for this server. Keep its original terminal open and check the connection status in your app. To restart, press Ctrl+C in that terminal, then run this command again.";

export function connectionDirectory(controlPlaneUrl: string, home: string = homedir()): string {
  const key = createHash("sha256").update(normalizeControlPlaneUrl(controlPlaneUrl)).digest("hex").slice(0, 16);
  return join(home, ".hcp-runner", "connections", key);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function readMarker(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; return undefined; }
}

function takeLock(path: string): number | undefined {
  // This inode must remain in place: unlinking it would let two owners lock different files.
  const fd = openSync(path, "a+", 0o600);
  try { if (tryLock(fd)) return fd; }
  catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  return undefined;
}

function checkLegacyOwner(marker: string, path: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(marker); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`HCP cannot identify the older runner lock at ${path}. No files were removed. Stop any older HCP runner and contact support with this path.`);
  }
  // New owners are proved absent by the OS lock, even if their PID has been reused.
  if (ownerSchema.safeParse(parsed).success) return;
  if (!Number.isSafeInteger(parsed) || typeof parsed !== "number" || parsed <= 0) {
    throw new Error(`HCP cannot identify the older runner lock at ${path}. No files were removed. Stop any older HCP runner and contact support with this path.`);
  }
  try { process.kill(parsed, 0); }
  catch (error) {
    if (errorCode(error) === "ESRCH") return;
    throw new Error(`HCP cannot verify whether process ${parsed} still owns this connection. No files were removed. Check that process before restarting.`, { cause: error });
  }
  throw new Error(`An older HCP runner may still be running (process ${parsed}). Press Ctrl+C in its terminal, then run this command again. No files were removed.`);
}

export class ConnectionOwnership {
  readonly #fd: number;
  readonly #markerPath: string;
  readonly #marker: string;
  #released = false;

  private constructor(fd: number, markerPath: string, marker: string) {
    this.#fd = fd;
    this.#markerPath = markerPath;
    this.#marker = marker;
    process.once("exit", this.release);
  }

  static acquire(directory: string): ConnectionOwnership | "already_running" {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = takeLock(join(directory, "runner.owner"));
    if (fd === undefined) return "already_running";
    const markerPath = join(directory, "runner.json.lock");
    const marker = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() });
    const temporary = `${markerPath}.${randomUUID()}.tmp`;
    try {
      const prior = readMarker(markerPath);
      if (prior !== undefined) checkLegacyOwner(prior, markerPath);
      writeFileSync(temporary, marker, { flag: "wx", mode: 0o600 });
      if (prior === undefined) {
        // An older CLI does not take the OS lock, so publication must also be exclusive.
        try { linkSync(temporary, markerPath); }
        catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          throw new Error("Another HCP command started setup. Let it finish, then run this command again.");
        }
      } else {
        renameSync(temporary, markerPath);
        console.log("Recovered the previous HCP connection. Reusing saved setup.");
      }
      return new ConnectionOwnership(fd, markerPath, marker);
    } catch (error) {
      closeSync(fd);
      throw error;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  release = (): void => {
    if (this.#released) return;
    this.#released = true;
    process.removeListener("exit", this.release);
    try {
      if (readMarker(this.#markerPath) === this.#marker) unlinkSync(this.#markerPath);
    } finally { closeSync(this.#fd); }
  };
}

export type StateOwnership = { path: string; release: () => void };

export function acquireStateOwnership(path: string): StateOwnership {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const canonical = existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
  const fd = takeLock(`${canonical}.owner`);
  if (fd === undefined) throw new Error("This runner's saved state is already in use by another HCP process. Stop that runner before starting another connection.");
  let released = false;
  return { path: canonical, release: () => { if (!released) { released = true; closeSync(fd); } } };
}
