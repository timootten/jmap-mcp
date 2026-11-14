import {
  type Address,
  type Allowlist,
  enforceAllowlist,
  normalizeEmail,
  type Recipients,
} from "./address.ts";
import { JmapError, PolicyError } from "./errors.ts";
import { CAP_CORE, CAP_MAIL, CAP_SUBMISSION, JmapClient, type Reply } from "./jmap.ts";
import type { Logger } from "./log.ts";
import {
  type Identity,
  listIdentities,
  listMailboxes,
  type Mailbox,
  mailboxByRole,
} from "./mail.ts";
import type { RateLimiter } from "./ratelimit.ts";
import { headerSafe } from "./sanitize.ts";

export interface Outgoing {
  from?: string | undefined;
  recipients: Recipients;
  subject: string;
  body: string;
  inReplyTo?: string[];
  references?: string[];
}

export interface SendDeps {
  client: JmapClient;
  allowlist: Allowlist | undefined;
  limiter: RateLimiter;
  log: Logger;
}

function localDomainMatch(pattern: string, email: string): boolean {
  if (!pattern.startsWith("*@")) return false;
  return email.endsWith(pattern.slice(1));
}

/** The sender must be one of the account's own JMAP identities. There is no free choice. */
export function resolveSender(
  identities: Identity[],
  requested: string | undefined,
): {
  identity: Identity;
  address: Address;
} {
  if (identities.length === 0)
    throw new PolicyError("The account has no identities, so it cannot send.");
  if (requested === undefined) {
    const first = identities.find((i) => !i.email.includes("*")) ?? identities[0];
    if (!first || first.email.includes("*")) {
      throw new PolicyError("Specify `from`: the only identity is a wildcard.");
    }
    return {
      identity: first,
      address: { email: normalizeEmail(first.email), name: first.name ?? undefined },
    };
  }
  const want = normalizeEmail(requested);
  for (const i of identities) {
    const have = i.email.toLowerCase();
    if (have === want || localDomainMatch(have, want)) {
      return { identity: i, address: { email: want, name: i.name ?? undefined } };
    }
  }
  throw new PolicyError(`"from" is not one of this account's identities: ${want}.`);
}

function jmapAddr(a: Address): { name?: string; email: string } {
  return a.name ? { name: a.name, email: a.email } : { email: a.email };
}

export function safeSubject(raw: string): string {
  return headerSafe(raw).slice(0, 500);
}

export async function requireSubmission(c: JmapClient): Promise<void> {
  const s = await c.session();
  if (!s.capabilities[CAP_SUBMISSION]) {
    throw new PolicyError(
      "This server does not offer urn:ietf:params:jmap:submission. Sending is not possible.",
    );
  }
}

function emailObject(o: Outgoing, from: Address, drafts: Mailbox): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    mailboxIds: { [drafts.id]: true },
    keywords: { $draft: true, $seen: true },
    from: [jmapAddr(from)],
    to: o.recipients.to.map(jmapAddr),
    subject: safeSubject(o.subject),
    bodyStructure: { partId: "body", type: "text/plain" },
    bodyValues: { body: { value: o.body } },
  };
  if (o.recipients.cc.length) obj.cc = o.recipients.cc.map(jmapAddr);
  if (o.recipients.bcc.length) obj.bcc = o.recipients.bcc.map(jmapAddr);
  if (o.inReplyTo?.length) obj.inReplyTo = o.inReplyTo;
  if (o.references?.length) obj.references = o.references;
  return obj;
}

async function prepare(c: JmapClient, requestedFrom: string | undefined) {
  const [identities, boxes] = await Promise.all([
    listIdentities(c, CAP_SUBMISSION),
    listMailboxes(c),
  ]);
  const drafts = mailboxByRole(boxes, "drafts");
  if (!drafts) throw new PolicyError("The account has no Drafts mailbox.");
  return {
    ...resolveSender(identities, requestedFrom),
    drafts,
    sent: mailboxByRole(boxes, "sent"),
  };
}

function submissionCall(
  accountId: string,
  identityId: string,
  emailRef: string,
  from: string,
  rcpt: string[],
  drafts: Mailbox,
  sent: Mailbox | undefined,
): Record<string, unknown> {
  const update: Record<string, unknown> = { "keywords/$draft": null };
  if (sent) {
    update[`mailboxIds/${drafts.id}`] = null;
    update[`mailboxIds/${sent.id}`] = true;
  }
  return {
    accountId,
    create: {
      sub: {
        identityId,
        emailId: emailRef,
        // The envelope is set explicitly so that the checked list is exactly what is delivered.
        envelope: { mailFrom: { email: from }, rcptTo: rcpt.map((email) => ({ email })) },
      },
    },
    onSuccessUpdateEmail: { "#sub": update },
  };
}

function created(
  args: Record<string, unknown>,
  key: string,
  what: string,
): Record<string, unknown> {
  const ok = (args.created ?? {}) as Record<string, Record<string, unknown>>;
  if (ok[key]) return ok[key];
  const bad = (args.notCreated ?? {}) as Record<string, { type?: unknown; description?: unknown }>;
  const e = bad[key];
  const type = typeof e?.type === "string" ? e.type : "unknown";
  throw new JmapError(
    `The server did not create the ${what}: ${type}.`,
    String(e?.description ?? ""),
  );
}

export interface SendOutcome {
  submissionId: string;
  emailId: string;
  status: string;
  recipients: string[];
  warnings: string[];
}

function gatekeep(d: SendDeps, tool: string, rec: Recipients): string[] {
  try {
    return enforceAllowlist(rec, d.allowlist as Allowlist);
  } catch (e) {
    d.log.audit({ tool, result: "denied", reason: "recipient_not_allowed" });
    throw e;
  }
}

async function submit(
  d: SendDeps,
  tool: string,
  rcpt: string[],
  subjectLength: number,
  run: () => Promise<SendOutcome>,
): Promise<SendOutcome> {
  try {
    d.limiter.reserve();
  } catch (e) {
    d.log.audit({ tool, result: "denied", recipients: rcpt, subjectLength, reason: "rate_limit" });
    throw e;
  }
  try {
    const out = await run();
    d.log.audit({ tool, result: "sent", recipients: rcpt, subjectLength });
    return out;
  } catch (e) {
    d.log.audit({ tool, result: "error", recipients: rcpt, subjectLength, reason: "send_failed" });
    throw e;
  }
}

function readOutcome(replies: Reply[], emailId: string, rcpt: string[]): SendOutcome {
  const sub = JmapClient.pick(replies, "EmailSubmission/set", "s");
  const made = created(sub, "sub", "submission");
  const warnings: string[] = [];
  const follow = replies.find((x) => x[0] === "Email/set" && x[2] === "s");
  const failed = (follow?.[1].notUpdated ?? {}) as object;
  if (Object.keys(failed).length > 0) {
    warnings.push(
      "The message was submitted, but the server could not move it to Sent or clear the draft flag.",
    );
  }
  return {
    submissionId: String(made.id ?? ""),
    emailId,
    status: typeof made.undoStatus === "string" ? made.undoStatus : "accepted",
    recipients: rcpt,
    warnings,
  };
}

const USING = [CAP_CORE, CAP_MAIL, CAP_SUBMISSION];

export async function sendNew(d: SendDeps, tool: string, o: Outgoing): Promise<SendOutcome> {
  await requireSubmission(d.client);
  const rcpt = gatekeep(d, tool, o.recipients);
  const subjectLength = safeSubject(o.subject).length;
  const p = await prepare(d.client, o.from);
  const s = await d.client.session();
  return submit(d, tool, rcpt, subjectLength, async () => {
    const replies = await d.client.call(
      [
        [
          "Email/set",
          { accountId: s.accountId, create: { draft: emailObject(o, p.address, p.drafts) } },
          "e",
        ],
        [
          "EmailSubmission/set",
          submissionCall(
            s.accountId,
            p.identity.id,
            "#draft",
            p.address.email,
            rcpt,
            p.drafts,
            p.sent,
          ),
          "s",
        ],
      ],
      USING,
    );
    const made = created(JmapClient.pick(replies, "Email/set", "e"), "draft", "message");
    return readOutcome(replies, String(made.id ?? ""), rcpt);
  });
}

export async function sendExistingDraft(
  d: SendDeps,
  tool: string,
  draft: { id: string; from: Address | undefined; recipients: Recipients; subject: string },
): Promise<SendOutcome> {
  await requireSubmission(d.client);
  const rcpt = gatekeep(d, tool, draft.recipients);
  const subjectLength = safeSubject(draft.subject).length;
  const p = await prepare(d.client, draft.from?.email);
  const s = await d.client.session();
  return submit(d, tool, rcpt, subjectLength, async () => {
    const replies = await d.client.call(
      [
        [
          "EmailSubmission/set",
          submissionCall(
            s.accountId,
            p.identity.id,
            draft.id,
            p.address.email,
            rcpt,
            p.drafts,
            p.sent,
          ),
          "s",
        ],
      ],
      USING,
    );
    return readOutcome(replies, draft.id, rcpt);
  });
}

export async function createDraftOnly(
  client: JmapClient,
  o: Outgoing,
): Promise<{ emailId: string }> {
  const p = await prepare(client, o.from);
  const s = await client.session();
  const replies = await client.call([
    [
      "Email/set",
      { accountId: s.accountId, create: { draft: emailObject(o, p.address, p.drafts) } },
      "e",
    ],
  ]);
  const made = created(JmapClient.pick(replies, "Email/set", "e"), "draft", "draft");
  return { emailId: String(made.id ?? "") };
}
