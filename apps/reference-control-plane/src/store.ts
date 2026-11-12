import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Durable control-plane state: pairing requests, machines (credentials) and one-time
 * connection tokens. Every state change that must happen at most once is a single
 * conditional UPDATE, so two concurrent requests can never both win.
 * See docs/control-plane/lifecycle.md for the state machine this implements.
 */

export const PAIRING_TTL_MS = 5 * 60_000;
export const TOKEN_TTL_MS = 60_000;

export type PairingState = "pending" | "approved" | "declined" | "consumed";

export type Pairing = {
  request_id: string;
  runner_id: string;
  host_id: string;
  state: PairingState;
  owner_user_id: string | null;
  expires_at: number;
};

export type Machine = {
  credential_id: string;
  runner_id: string;
  host_id: string;
  owner_user_id: string;
  credential_generation: number;
  revoked_at: number | null;
};

export type IssuedCredential = { machine: Machine; credentialSecret: string; proofSecret: string };

/** A consumed token is bound to the credential generation it was minted for. */
export type TokenGrant = { machine: Machine; generation: number };

export class StoreRefusal extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410, message: string) {
    super(message);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

export class ControlPlaneStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pairings (
        request_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        runner_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        exchange_secret_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'declined', 'consumed')),
        owner_user_id TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS machines (
        credential_id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL,
        proof_secret TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        credential_generation INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_tokens (
        token_hash TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES machines(credential_id),
        credential_generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  createPairing(input: { runner_id: string; host_id: string; exchange_secret_hash: string }): { requestId: string; pairingCode: string; expiresAt: number } {
    const requestId = secret();
    // Short enough to type, long enough that guessing one live code is impractical.
    const pairingCode = randomBytes(6).toString("hex").toUpperCase();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.#db.prepare(`INSERT INTO pairings (request_id, code_hash, runner_id, host_id, exchange_secret_hash, state, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(requestId, sha256(pairingCode), input.runner_id, input.host_id, input.exchange_secret_hash, expiresAt);
    return { requestId, pairingCode, expiresAt };
  }

  findPendingByCode(pairingCode: string): Pairing | undefined {
    return this.#db.prepare(`SELECT request_id, runner_id, host_id, state, owner_user_id, expires_at FROM pairings
      WHERE code_hash = ? AND state = 'pending' AND expires_at > ?`).get(sha256(pairingCode), Date.now()) as Pairing | undefined;
  }

  /** Approval records who approved; the machine is bound to that user when the runner exchanges. */
  decide(input: { requestId: string; pairingCode: string; decision: "approved" | "declined"; userId: string }): void {
    const result = this.#db.prepare(`UPDATE pairings SET state = ?, owner_user_id = ?
      WHERE request_id = ? AND code_hash = ? AND state = 'pending' AND expires_at > ?`)
      .run(input.decision, input.userId, input.requestId, sha256(input.pairingCode), Date.now());
    if (result.changes !== 1) throw new StoreRefusal(409, "Pairing is no longer pending.");
  }

  /**
   * The one-time exchange. Pending answers "pending"; approved is consumed by one
   * conditional UPDATE inside the same transaction that creates the machine.
   */
  exchange(input: { request_id: string; runner_id: string; host_id: string; exchange_secret: string }): "pending" | IssuedCredential {
    const pairing = this.#db.prepare(`SELECT request_id, runner_id, host_id, state, owner_user_id, expires_at, exchange_secret_hash
      FROM pairings WHERE request_id = ?`).get(input.request_id) as (Pairing & { exchange_secret_hash: string }) | undefined;
    if (!pairing || pairing.runner_id !== input.runner_id || pairing.host_id !== input.host_id
      || pairing.exchange_secret_hash !== sha256(input.exchange_secret)) throw new StoreRefusal(403, "Invalid pairing exchange.");
    if (pairing.expires_at <= Date.now()) throw new StoreRefusal(410, "Pairing expired. Start a new pairing request.");
    if (pairing.state === "pending") return "pending";
    if (pairing.state !== "approved") throw new StoreRefusal(410, "Pairing was declined or already used. Start a new pairing request.");

    const credentialSecret = secret();
    const proofSecret = secret();
    const machine: Machine = { credential_id: secret(), runner_id: pairing.runner_id, host_id: pairing.host_id,
      owner_user_id: pairing.owner_user_id!, credential_generation: 1, revoked_at: null };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.#db.prepare(`UPDATE pairings SET state = 'consumed' WHERE request_id = ? AND state = 'approved'`).run(input.request_id);
      if (consumed.changes !== 1) throw new StoreRefusal(410, "Pairing was already used. Start a new pairing request.");
      this.#db.prepare(`INSERT INTO machines (credential_id, credential_hash, proof_secret, runner_id, host_id, owner_user_id, credential_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(machine.credential_id, sha256(credentialSecret), proofSecret, machine.runner_id,
        machine.host_id, machine.owner_user_id, Date.now());
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { machine, credentialSecret, proofSecret };
  }

  /** Checks the long-lived credential and mints a short-lived, single-use connection token. */
  mintToken(input: { credential_id: string; credential_secret: string; runner_id: string; host_id: string }): { token: string; expiresAt: number } {
    const machine = this.#machineWithHash(input.credential_id);
    if (!machine || machine.credential_hash !== sha256(input.credential_secret)) throw new StoreRefusal(401, "Runner credential is invalid.");
    if (machine.revoked_at !== null) throw new StoreRefusal(403, "Runner credential has been revoked.");
    if (machine.runner_id !== input.runner_id || machine.host_id !== input.host_id) throw new StoreRefusal(403, "Credential is bound to a different runner or host.");
    const token = secret();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.#db.prepare(`INSERT INTO connection_tokens (token_hash, credential_id, credential_generation, expires_at) VALUES (?, ?, ?, ?)`)
      .run(sha256(token), machine.credential_id, machine.credential_generation, expiresAt);
    return { token, expiresAt };
  }

  /** Spends a token exactly once, and only while its credential generation is still current. */
  consumeToken(token: string): TokenGrant {
    const used = this.#db.prepare(`UPDATE connection_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING credential_id, credential_generation`).get(Date.now(), sha256(token), Date.now()) as
      { credential_id: string; credential_generation: number } | undefined;
    if (!used) throw new StoreRefusal(401, "Connection token is invalid, expired or already used.");
    const machine = this.machine(used.credential_id);
    if (!machine || machine.revoked_at !== null || machine.credential_generation !== used.credential_generation) {
      throw new StoreRefusal(403, "Runner credential was revoked.");
    }
    return { machine, generation: used.credential_generation };
  }

  /** True while the credential generation a socket was admitted with is still current. */
  isCurrent(grant: TokenGrant): boolean {
    const machine = this.machine(grant.machine.credential_id);
    return machine !== undefined && machine.revoked_at === null && machine.credential_generation === grant.generation;
  }

  /** Revocation bumps the generation, so every token and socket admitted before it is fenced. */
  revoke(credentialId: string): Machine {
    const result = this.#db.prepare(`UPDATE machines SET revoked_at = ?, credential_generation = credential_generation + 1
      WHERE credential_id = ? AND revoked_at IS NULL`).run(Date.now(), credentialId);
    if (result.changes !== 1) throw new StoreRefusal(404, "No active machine with that credential.");
    return this.machine(credentialId)!;
  }

  machine(credentialId: string): Machine | undefined {
    const row = this.#machineWithHash(credentialId);
    if (!row) return undefined;
    const { credential_hash: _hash, ...machine } = row;
    return machine;
  }

  machines(ownerUserId: string): Machine[] {
    return this.#db.prepare(`SELECT credential_id, runner_id, host_id, owner_user_id, credential_generation, revoked_at
      FROM machines WHERE owner_user_id = ? ORDER BY created_at`).all(ownerUserId) as Machine[];
  }

  #machineWithHash(credentialId: string): (Machine & { credential_hash: string }) | undefined {
    return this.#db.prepare(`SELECT credential_id, credential_hash, runner_id, host_id, owner_user_id, credential_generation, revoked_at
      FROM machines WHERE credential_id = ?`).get(credentialId) as (Machine & { credential_hash: string }) | undefined;
  }
}
