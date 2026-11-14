import { z } from "zod";
import type { Config } from "./config.ts";
import { JmapError, PolicyError } from "./errors.ts";

export const CAP_CORE = "urn:ietf:params:jmap:core";
export const CAP_MAIL = "urn:ietf:params:jmap:mail";
export const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";

const MAX_SESSION_BYTES = 256 * 1024;
const MAX_API_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const sessionSchema = z.object({
  capabilities: z.record(z.string(), z.unknown()),
  primaryAccounts: z.record(z.string(), z.string()),
  apiUrl: z.string(),
  downloadUrl: z.string(),
  uploadUrl: z.string().optional(),
  eventSourceUrl: z.string().optional(),
  state: z.string().optional(),
});

export interface Session {
  capabilities: Record<string, unknown>;
  accountId: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl?: string | undefined;
  eventSourceUrl?: string | undefined;
  state?: string | undefined;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxSizeRequest: number;
}

export type Call = [method: string, args: Record<string, unknown>, id: string];
export type Reply = [method: string, args: Record<string, unknown>, id: string];

/**
 * Replaces the origin of a session URL. Works on the string because URL templates such as
 * `{accountId}` would be percent-encoded by the URL parser.
 */
export function rewriteOrigin(url: string, origin: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/is.exec(url);
  if (!m) throw new JmapError("Session contains a URL that is not absolute.");
  return `${origin}${m[1]}`;
}

function originOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url);
  if (!m) throw new JmapError("Session contains a URL that is not absolute.");
  return new URL(m[1] as string).origin;
}

class Semaphore {
  #size: number;
  #active = 0;
  #waiters: (() => void)[] = [];
  constructor(size: number) {
    this.#size = size;
  }
  resize(size: number): void {
    this.#size = size;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.#active >= this.#size) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiters.shift()?.();
    }
  }
}

async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw new JmapError(`Response too large (limit ${max} bytes).`);
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new JmapError(`Response too large (limit ${max} bytes).`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export class JmapClient {
  readonly #config: Config;
  readonly #allowed: Set<string>;
  readonly #authHeader: string;
  readonly #timeoutMs: number;
  readonly #gate = new Semaphore(4);
  #session: Session | undefined;
  #loading: Promise<Session> | undefined;

  constructor(config: Config, opts: { timeoutMs?: number } = {}) {
    this.#config = config;
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#allowed = new Set([config.sessionOrigin]);
    if (config.apiOrigin) this.#allowed.add(config.apiOrigin);
    const a = config.auth;
    this.#authHeader =
      a.kind === "bearer"
        ? `Bearer ${a.token.reveal()}`
        : `Basic ${Buffer.from(`${a.username}:${a.password.reveal()}`, "utf8").toString("base64")}`;
  }

  get cachedSession(): Session | undefined {
    return this.#session;
  }

  /** The only place that talks to the network. */
  async #send(
    url: string,
    init: { method: "GET" | "POST"; body?: string },
    maxBytes: number,
  ): Promise<{ status: number; body: Uint8Array }> {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!this.#allowed.has(current.origin)) {
        throw new PolicyError(
          `Refusing to contact ${current.origin}: only the session origin and JMAP_API_ORIGIN are allowed.`,
        );
      }
      let res: Response;
      try {
        res = await fetch(current, {
          method: init.method,
          body: init.body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.#timeoutMs),
          headers: {
            authorization: this.#authHeader,
            accept: "application/json",
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          },
        });
      } catch (e) {
        const reason =
          e instanceof Error && e.name === "TimeoutError" ? "timed out" : "connection failed";
        throw new JmapError(`Cannot reach ${current.origin}: ${reason}.`);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        const keepsMethod = init.method === "GET" || res.status === 307 || res.status === 308;
        if (!location || !keepsMethod)
          throw new JmapError(`Unexpected redirect (HTTP ${res.status}).`);
        const next = new URL(location, current);
        if (next.origin !== current.origin) {
          throw new PolicyError(
            `Server redirected to ${next.origin}. Redirects to another origin are not followed.`,
          );
        }
        current = next;
        continue;
      }
      let body: Uint8Array;
      try {
        body = await readLimited(res, maxBytes);
      } catch (e) {
        if (e instanceof JmapError) throw e;
        throw new JmapError(`Cannot read response from ${current.origin}.`);
      }
      return { status: res.status, body };
    }
    throw new JmapError("Too many redirects.");
  }

  #httpError(status: number, body: Uint8Array): JmapError {
    if (status === 401 || status === 403) {
      return new JmapError(
        `Authentication or permission failure (HTTP ${status}). Check the credentials and rights of the account.`,
      );
    }
    return new JmapError(
      `The server answered HTTP ${status}.`,
      new TextDecoder().decode(body.slice(0, 600)),
    );
  }

  async session(): Promise<Session> {
    if (this.#session) return this.#session;
    this.#loading ??= this.#loadSession().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #loadSession(): Promise<Session> {
    const { status, body } = await this.#send(
      this.#config.sessionUrl,
      { method: "GET" },
      MAX_SESSION_BYTES,
    );
    if (status !== 200) throw this.#httpError(status, body);
    let raw: z.infer<typeof sessionSchema>;
    try {
      raw = sessionSchema.parse(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      throw new JmapError("The session response is not a valid JMAP session.");
    }
    const accountId = raw.primaryAccounts[CAP_MAIL];
    if (!raw.capabilities[CAP_MAIL] && !accountId) {
      throw new JmapError("This account does not offer urn:ietf:params:jmap:mail.");
    }
    if (!accountId) throw new JmapError("The session has no primary mail account.");

    const fix = (u: string | undefined): string | undefined => {
      if (u === undefined) return undefined;
      if (this.#config.apiOrigin) return rewriteOrigin(u, this.#config.apiOrigin);
      if (originOf(u) !== this.#config.sessionOrigin) {
        throw new PolicyError(
          `The session names the host ${originOf(u)}, which is not allowed. Set JMAP_API_ORIGIN to the origin that should be used.`,
        );
      }
      return u;
    };
    const core = (raw.capabilities[CAP_CORE] ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
    const session: Session = {
      capabilities: raw.capabilities,
      accountId,
      apiUrl: fix(raw.apiUrl) as string,
      downloadUrl: fix(raw.downloadUrl) as string,
      uploadUrl: fix(raw.uploadUrl),
      eventSourceUrl: fix(raw.eventSourceUrl),
      state: raw.state,
      maxConcurrentRequests: num(core.maxConcurrentRequests, 4),
      maxCallsInRequest: num(core.maxCallsInRequest, 16),
      maxSizeRequest: num(core.maxSizeRequest, 1_000_000),
    };
    this.#gate.resize(Math.min(session.maxConcurrentRequests, 8));
    this.#session = session;
    return session;
  }

  async call(calls: Call[], using: string[] = [CAP_CORE, CAP_MAIL]): Promise<Reply[]> {
    const s = await this.session();
    if (calls.length > s.maxCallsInRequest)
      throw new JmapError("Too many method calls for this server.");
    const payload = JSON.stringify({ using, methodCalls: calls });
    if (Buffer.byteLength(payload) > s.maxSizeRequest) {
      throw new PolicyError(
        `Request is larger than the server accepts (${s.maxSizeRequest} bytes).`,
      );
    }
    const { status, body } = await this.#gate.run(() =>
      this.#send(s.apiUrl, { method: "POST", body: payload }, MAX_API_BYTES),
    );
    if (status !== 200) {
      let detail: string | undefined;
      try {
        const p = JSON.parse(new TextDecoder().decode(body)) as { type?: unknown };
        if (typeof p.type === "string") detail = p.type;
      } catch {}
      throw new JmapError(`The API answered HTTP ${status}.`, detail);
    }
    let parsed: { methodResponses?: unknown; sessionState?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new JmapError("The API response is not valid JSON.");
    }
    if (!Array.isArray(parsed.methodResponses))
      throw new JmapError("The API response has no methodResponses.");
    if (typeof parsed.sessionState === "string" && s.state && parsed.sessionState !== s.state) {
      this.#session = undefined;
    }
    return parsed.methodResponses as Reply[];
  }

  /** Returns the arguments of one response and throws if it is a JMAP error. */
  static pick(replies: Reply[], method: string, id: string): Record<string, unknown> {
    const err = replies.find((r) => r[0] === "error" && r[2] === id);
    if (err) {
      const type = typeof err[1].type === "string" ? err[1].type : "unknown";
      throw new JmapError(
        `The server rejected ${method}: ${type}.`,
        String(err[1].description ?? ""),
      );
    }
    const hit = replies.find((r) => r[0] === method && r[2] === id);
    if (!hit) throw new JmapError(`The server sent no ${method} response.`);
    return hit[1];
  }

  async download(
    blobId: string,
    type: string,
    name: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const s = await this.session();
    const url = s.downloadUrl
      .replace("{accountId}", encodeURIComponent(s.accountId))
      .replace("{blobId}", encodeURIComponent(blobId))
      .replace("{type}", encodeURIComponent(type))
      .replace("{name}", encodeURIComponent(name || "attachment"));
    const { status, body } = await this.#gate.run(() =>
      this.#send(url, { method: "GET" }, maxBytes),
    );
    if (status !== 200) throw this.#httpError(status, body);
    return body;
  }
}
