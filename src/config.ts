import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { type Allowlist, parseAllowlist } from "./address.ts";
import { checkAttachmentDir } from "./attachments.ts";
import { ConfigError, Secret } from "./errors.ts";

const KNOWN = new Set([
  "JMAP_SESSION_URL",
  "JMAP_API_ORIGIN",
  "JMAP_USERNAME",
  "JMAP_PASSWORD",
  "JMAP_TOKEN",
  "JMAP_NAME",
  "JMAP_READ",
  "JMAP_SEND",
  "JMAP_ALLOWED_RECIPIENTS",
  "JMAP_SEND_LIMIT_PER_HOUR",
  "JMAP_DRAFTS",
  "JMAP_ORGANIZE",
  "JMAP_ATTACHMENTS",
  "JMAP_ATTACHMENT_DIR",
  "JMAP_ATTACHMENT_MAX_MB",
  "JMAP_STATE_DIR",
  "JMAP_ALLOW_INSECURE_LOCALHOST",
]);

export type Auth =
  | { kind: "basic"; username: string; password: Secret }
  | { kind: "bearer"; token: Secret };

export interface Config {
  name: string;
  sessionUrl: string;
  sessionOrigin: string;
  apiOrigin: string | undefined;
  auth: Auth;
  read: boolean;
  send: boolean;
  drafts: boolean;
  organize: boolean;
  attachments: boolean;
  /** Folder that outgoing attachments may come from. Sending files is off without it. */
  attachmentDir: string | undefined;
  attachmentMaxBytes: number;
  allowlist: Allowlist | undefined;
  /** `Infinity` when set to "unlimited". */
  sendLimitPerHour: number;
  stateDir: string;
  secrets: Secret[];
}

const text = (max: number) =>
  z
    .string({ error: (i) => (i.input === undefined ? "is required" : "must be a string") })
    .min(1, "must not be empty")
    .max(max, "is too long");

const bool = z.enum(["true", "false"], { error: 'must be exactly "true" or "false"' });

const schema = z.object({
  JMAP_SESSION_URL: text(2048),
  JMAP_API_ORIGIN: text(2048).optional(),
  JMAP_USERNAME: text(320)
    .refine((v) => !v.includes(":"), "must not contain a colon")
    // oxlint-disable-next-line no-control-regex -- rejects control characters on purpose
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "must not contain control characters")
    .optional(),
  JMAP_PASSWORD: text(1024).optional(),
  JMAP_TOKEN: text(4096)
    .refine((v) => /^[\x21-\x7e]+$/.test(v), "must be printable ASCII without spaces")
    .optional(),
  JMAP_NAME: z
    .string()
    .regex(/^[A-Za-z0-9._@+-]{1,64}$/, "must match [A-Za-z0-9._@+-], 1 to 64 characters")
    .optional(),
  JMAP_READ: bool.optional(),
  JMAP_SEND: bool.optional(),
  JMAP_ALLOWED_RECIPIENTS: text(8192).optional(),
  JMAP_SEND_LIMIT_PER_HOUR: z
    .string()
    .regex(/^(?:[0-9]{1,6}|unlimited)$/, 'must be a whole number from 1 to 100000, or "unlimited"')
    .transform((v) => (v === "unlimited" ? Number.POSITIVE_INFINITY : Number(v)))
    .refine((n) => n >= 1 && (n <= 100_000 || n === Number.POSITIVE_INFINITY), {
      message: 'must be a whole number from 1 to 100000, or "unlimited"',
    })
    .optional(),
  JMAP_DRAFTS: bool.optional(),
  JMAP_ORGANIZE: bool.optional(),
  JMAP_ATTACHMENTS: bool.optional(),
  JMAP_ATTACHMENT_DIR: text(1024)
    .refine((v) => isAbsolute(v), "must be an absolute path")
    .optional(),
  JMAP_ATTACHMENT_MAX_MB: z
    .string()
    .regex(/^[0-9]{1,3}$/, "must be a whole number from 1 to 100")
    .transform(Number)
    .refine((n) => n >= 1 && n <= 100, "must be a whole number from 1 to 100")
    .optional(),
  JMAP_STATE_DIR: text(1024)
    .refine((v) => isAbsolute(v), "must be an absolute path")
    .optional(),
  JMAP_ALLOW_INSECURE_LOCALHOST: bool.optional(),
});

/** Removes at most one trailing line ending. Everything else is kept, including spaces. */
export function stripTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseHttpUrl(raw: string, variable: string, insecureLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${variable}: not a valid URL`);
  }
  const httpsOk = url.protocol === "https:";
  const localhostOk = url.protocol === "http:" && insecureLocalhost && LOOPBACK.has(url.hostname);
  if (!httpsOk && !localhostOk) {
    throw new ConfigError(
      `${variable}: only https is allowed (http works for localhost with JMAP_ALLOW_INSECURE_LOCALHOST=true)`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(`${variable}: must not contain credentials`);
  }
  if (url.hash !== "") throw new ConfigError(`${variable}: must not contain a fragment`);
  return url;
}

/**
 * Reads and validates the configuration. JMAP_PASSWORD and JMAP_TOKEN are removed from
 * `env` right away, so they cannot be read again by anything else in this process.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawPassword = env.JMAP_PASSWORD;
  const rawToken = env.JMAP_TOKEN;
  delete env.JMAP_PASSWORD;
  delete env.JMAP_TOKEN;

  const problems: string[] = [];
  const unknown = Object.keys(env).filter(
    (k) => k.toUpperCase().startsWith("JMAP_") && !KNOWN.has(k),
  );
  if (unknown.length > 0) problems.push(`unknown variable(s): ${unknown.join(", ")}`);

  const input: Record<string, string | undefined> = {};
  for (const key of KNOWN) input[key] = env[key];
  input.JMAP_PASSWORD = rawPassword === undefined ? undefined : stripTrailingNewline(rawPassword);
  input.JMAP_TOKEN = rawToken === undefined ? undefined : stripTrailingNewline(rawToken);

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }
  const c = parsed.success ? parsed.data : undefined;

  if (c) {
    const hasBasic = c.JMAP_USERNAME !== undefined || c.JMAP_PASSWORD !== undefined;
    if (c.JMAP_TOKEN !== undefined && hasBasic) {
      problems.push("use either JMAP_TOKEN or JMAP_USERNAME with JMAP_PASSWORD, not both");
    } else if (c.JMAP_TOKEN === undefined) {
      if (c.JMAP_USERNAME === undefined || c.JMAP_PASSWORD === undefined) {
        problems.push("credentials missing: set JMAP_USERNAME and JMAP_PASSWORD, or JMAP_TOKEN");
      }
    }
    if (c.JMAP_SEND === "true" && c.JMAP_ALLOWED_RECIPIENTS === undefined) {
      problems.push("JMAP_ALLOWED_RECIPIENTS: required when JMAP_SEND=true");
    }
    if (c.JMAP_ATTACHMENT_DIR !== undefined && c.JMAP_SEND !== "true" && c.JMAP_DRAFTS !== "true") {
      problems.push("JMAP_ATTACHMENT_DIR: needs JMAP_SEND=true or JMAP_DRAFTS=true");
    }
    if (c.JMAP_ATTACHMENT_MAX_MB !== undefined && c.JMAP_ATTACHMENT_DIR === undefined) {
      problems.push("JMAP_ATTACHMENT_MAX_MB: has no effect without JMAP_ATTACHMENT_DIR");
    }
  }
  if (problems.length > 0 || !c) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  const insecure = c.JMAP_ALLOW_INSECURE_LOCALHOST === "true";
  const sessionUrl = parseHttpUrl(c.JMAP_SESSION_URL, "JMAP_SESSION_URL", insecure);
  let apiOrigin: string | undefined;
  if (c.JMAP_API_ORIGIN !== undefined) {
    const u = parseHttpUrl(c.JMAP_API_ORIGIN, "JMAP_API_ORIGIN", insecure);
    if (u.pathname !== "/" || u.search !== "") {
      throw new ConfigError(
        "JMAP_API_ORIGIN: must be an origin only (scheme, host, port), no path",
      );
    }
    apiOrigin = u.origin;
  }

  if (c.JMAP_ATTACHMENT_DIR !== undefined) checkAttachmentDir(c.JMAP_ATTACHMENT_DIR);

  let allowlist: Allowlist | undefined;
  if (c.JMAP_ALLOWED_RECIPIENTS !== undefined) {
    allowlist = parseAllowlist(c.JMAP_ALLOWED_RECIPIENTS);
  }

  const auth: Auth =
    c.JMAP_TOKEN !== undefined
      ? { kind: "bearer", token: new Secret(c.JMAP_TOKEN) }
      : {
          kind: "basic",
          username: c.JMAP_USERNAME as string,
          password: new Secret(c.JMAP_PASSWORD as string),
        };
  const secret = auth.kind === "basic" ? auth.password : auth.token;

  const fallbackName =
    auth.kind === "basic" ? auth.username.replace(/[^A-Za-z0-9._@+-]/g, "_").slice(0, 64) : "jmap";
  const stateHome = env.XDG_STATE_HOME;
  const stateBase =
    stateHome !== undefined && isAbsolute(stateHome)
      ? stateHome
      : join(homedir(), ".local", "state");

  return {
    name: c.JMAP_NAME ?? fallbackName,
    sessionUrl: sessionUrl.href,
    sessionOrigin: sessionUrl.origin,
    apiOrigin,
    auth,
    read: c.JMAP_READ !== "false",
    send: c.JMAP_SEND === "true",
    drafts: c.JMAP_DRAFTS === "true",
    organize: c.JMAP_ORGANIZE === "true",
    attachments: c.JMAP_ATTACHMENTS === "true",
    attachmentDir: c.JMAP_ATTACHMENT_DIR,
    attachmentMaxBytes: (c.JMAP_ATTACHMENT_MAX_MB ?? 15) * 1_000_000,
    allowlist,
    sendLimitPerHour: c.JMAP_SEND_LIMIT_PER_HOUR ?? 10,
    stateDir: c.JMAP_STATE_DIR ?? join(stateBase, "jmap-mcp"),
    secrets: [secret],
  };
}
