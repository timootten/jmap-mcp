import { ConfigError, PolicyError } from "./errors.ts";

export interface Address {
  email: string;
  name?: string | undefined;
}

export interface Recipients {
  to: Address[];
  cc: Address[];
  bcc: Address[];
}

export const MAX_RECIPIENTS = 20;

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Strict addr-spec check: ASCII only, exactly one "@", no display name, no comments,
 * no lists. Returns the lowercase form, which is also the form that gets sent.
 */
export function normalizeEmail(raw: string): string {
  const invalid = () => new PolicyError("Invalid email address: must be a single plain addr-spec.");
  if (raw.length > 254 || !PRINTABLE_ASCII.test(raw)) throw invalid();
  const at = raw.indexOf("@");
  if (at < 1 || raw.indexOf("@", at + 1) !== -1) throw invalid();
  const local = raw.slice(0, at).toLowerCase();
  const domain = raw.slice(at + 1).toLowerCase();
  if (local.length > 64 || !LOCAL_PART.test(local)) throw invalid();
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) throw invalid();
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253 || !labels.every((l) => LABEL.test(l)))
    throw invalid();
  return `${local}@${domain}`;
}

/** Display names are cosmetic. Strip everything that could imitate an address or header. */
export function cleanName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters on purpose
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff<>"@]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned === "" ? undefined : cleaned;
}

export type AddressInput =
  | string
  | { email?: string | null | undefined; name?: string | null | undefined };

export function toAddress(input: AddressInput): Address {
  if (typeof input === "string") return { email: normalizeEmail(input) };
  if (!input.email)
    throw new PolicyError("Address without an email (group syntax is not supported).");
  return { email: normalizeEmail(input.email), name: cleanName(input.name) };
}

export class Allowlist {
  readonly patterns: readonly string[];
  readonly #exact = new Set<string>();
  readonly #domains = new Set<string>();

  constructor(patterns: string[]) {
    const seen: string[] = [];
    for (const raw of patterns) {
      try {
        if (raw.startsWith("@")) {
          const domain = raw.slice(1).toLowerCase();
          const labels = domain.split(".");
          if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw new Error();
          this.#domains.add(domain);
          seen.push(`@${domain}`);
        } else {
          if (raw.includes("*")) throw new Error();
          const email = normalizeEmail(raw);
          this.#exact.add(email);
          seen.push(email);
        }
      } catch {
        throw new ConfigError(
          "JMAP_ALLOWED_RECIPIENTS: each entry must be an exact address or an @domain pattern (no wildcards)",
        );
      }
    }
    this.patterns = seen;
  }

  matches(email: string): boolean {
    const at = email.lastIndexOf("@");
    return this.#exact.has(email) || this.#domains.has(email.slice(at + 1));
  }
}

/** Comma-separated list from the environment. Empty entries are an error, not ignored. */
export function parseAllowlist(raw: string): Allowlist {
  return new Allowlist(raw.split(",").map((p) => p.trim()));
}

/** Checks To, Cc and Bcc together. Returns the deduplicated envelope recipients. */
export function enforceAllowlist(recipients: Recipients, allow: Allowlist): string[] {
  const entries = [
    ...recipients.to.map((a) => ({ a, field: "to" })),
    ...recipients.cc.map((a) => ({ a, field: "cc" })),
    ...recipients.bcc.map((a) => ({ a, field: "bcc" })),
  ];
  if (recipients.to.length === 0) throw new PolicyError("At least one To recipient is required.");
  if (entries.length > MAX_RECIPIENTS) {
    throw new PolicyError(`Too many recipients (limit ${MAX_RECIPIENTS}).`);
  }
  const denied = entries.filter((e) => !allow.matches(e.a.email));
  if (denied.length > 0) {
    const list = denied.map((e) => `${e.a.email} (${e.field})`).join(", ");
    throw new PolicyError(
      `Recipient not allowed by JMAP_ALLOWED_RECIPIENTS: ${list}. Nothing was sent.`,
    );
  }
  return [...new Set(entries.map((e) => e.a.email))];
}
