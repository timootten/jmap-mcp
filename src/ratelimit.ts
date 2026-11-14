import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PolicyError } from "./errors.ts";

const WINDOW_MS = 60 * 60 * 1000;

function stateFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const hash = new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 8);
  return `${safe}-${hash}.json`;
}

/**
 * Sliding one-hour window. Kept in memory and mirrored to a small file so a restart does
 * not reset it. Fails closed: if the file cannot be read or written, nothing is sent.
 * A send attempt counts even when it later fails.
 */
export class RateLimiter {
  readonly file: string;
  #sends: number[] = [];

  constructor(
    readonly limit: number,
    stateDir: string,
    accountName: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(stateDir, stateFileName(accountName));
  }

  #load(): number[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw new PolicyError(
        `Rate-limit state file is not readable (${this.file}). Nothing was sent.`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const sends = (parsed as { sends?: unknown }).sends;
      if (!Array.isArray(sends) || !sends.every((s) => Number.isFinite(s))) throw new Error();
      return sends as number[];
    } catch {
      throw new PolicyError(
        `Rate-limit state file is corrupt (${this.file}). Delete it to continue. Nothing was sent.`,
      );
    }
  }

  #recent(): number[] {
    const cutoff = this.now() - WINDOW_MS;
    const fromFile = this.#load().filter((t) => t > cutoff);
    const fromMemory = this.#sends.filter((t) => t > cutoff);
    return fromFile.length >= fromMemory.length ? fromFile : fromMemory;
  }

  used(): number {
    if (this.limit === Number.POSITIVE_INFINITY) return 0;
    try {
      return this.#recent().length;
    } catch {
      return this.#sends.filter((t) => t > this.now() - WINDOW_MS).length;
    }
  }

  reserve(): void {
    if (this.limit === Number.POSITIVE_INFINITY) return;
    const recent = this.#recent();
    if (recent.length >= this.limit) {
      const oldest = Math.min(...recent);
      const minutes = Math.max(1, Math.ceil((oldest + WINDOW_MS - this.now()) / 60_000));
      throw new PolicyError(
        `Send limit reached (${this.limit} per hour, JMAP_SEND_LIMIT_PER_HOUR). Try again in about ${minutes} minutes.`,
      );
    }
    recent.push(this.now());
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, sends: recent }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {
      throw new PolicyError(`Rate-limit state cannot be written (${this.file}). Nothing was sent.`);
    }
    this.#sends = recent;
  }
}
