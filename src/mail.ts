import { z } from "zod";
import { JmapError, PolicyError } from "./errors.ts";
import { JmapClient, type Reply } from "./jmap.ts";

export const JMAP_ID = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, "not a valid JMAP id");

const addressList = z
  .array(z.object({ name: z.string().nullish(), email: z.string().nullish() }))
  .nullish();

const mailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullish(),
  parentId: z.string().nullish(),
  totalEmails: z.number().optional(),
  unreadEmails: z.number().optional(),
});
export type Mailbox = z.infer<typeof mailboxSchema>;

const partSchema = z.object({
  partId: z.string().nullish(),
  blobId: z.string().nullish(),
  name: z.string().nullish(),
  type: z.string().nullish(),
  size: z.number().optional(),
});

const emailSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
  mailboxIds: z.record(z.string(), z.boolean()).nullish(),
  keywords: z.record(z.string(), z.boolean()).nullish(),
  from: addressList,
  to: addressList,
  cc: addressList,
  bcc: addressList,
  replyTo: addressList,
  subject: z.string().nullish(),
  receivedAt: z.string().nullish(),
  sentAt: z.string().nullish(),
  size: z.number().optional(),
  preview: z.string().nullish(),
  hasAttachment: z.boolean().optional(),
  messageId: z.array(z.string()).nullish(),
  inReplyTo: z.array(z.string()).nullish(),
  references: z.array(z.string()).nullish(),
  textBody: z.array(partSchema).nullish(),
  attachments: z.array(partSchema).nullish(),
  bodyValues: z
    .record(z.string(), z.object({ value: z.string(), isTruncated: z.boolean().optional() }))
    .nullish(),
});
export type Email = z.infer<typeof emailSchema>;
export type Part = z.infer<typeof partSchema>;

const identitySchema = z.object({ id: z.string(), name: z.string().nullish(), email: z.string() });
export type Identity = z.infer<typeof identitySchema>;

export function parseServer<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new JmapError("The server answered with data in an unexpected shape.");
  return r.data;
}

const SUMMARY = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "subject",
  "receivedAt",
  "size",
  "preview",
  "hasAttachment",
];

export async function listMailboxes(c: JmapClient): Promise<Mailbox[]> {
  const s = await c.session();
  const r = await c.call([
    [
      "Mailbox/get",
      {
        accountId: s.accountId,
        ids: null,
        properties: ["name", "role", "parentId", "totalEmails", "unreadEmails"],
      },
      "m",
    ],
  ]);
  return parseServer(z.array(mailboxSchema), JmapClient.pick(r, "Mailbox/get", "m").list);
}

export interface SearchParams {
  text?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  mailboxId?: string | undefined;
  unread?: boolean | undefined;
  flagged?: boolean | undefined;
  hasAttachment?: boolean | undefined;
  after?: string | undefined;
  before?: string | undefined;
  limit: number;
  position: number;
}

/** JMAP wants UTCDate: no offset and no fractional seconds. */
export function toUtcDate(input: string): string {
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new PolicyError(`Not a valid date: ${input.slice(0, 40)}`);
  return `${new Date(t).toISOString().slice(0, 19)}Z`;
}

export function buildFilter(p: SearchParams): Record<string, unknown> | undefined {
  const f: Record<string, unknown> = {};
  if (p.mailboxId) f.inMailbox = p.mailboxId;
  if (p.text) f.text = p.text;
  if (p.from) f.from = p.from;
  if (p.to) f.to = p.to;
  if (p.subject) f.subject = p.subject;
  if (p.unread === true) f.notKeyword = "$seen";
  if (p.unread === false) f.hasKeyword = "$seen";
  if (p.flagged === true) f.hasKeyword = "$flagged";
  if (p.hasAttachment !== undefined) f.hasAttachment = p.hasAttachment;
  if (p.after) f.after = toUtcDate(p.after);
  if (p.before) f.before = toUtcDate(p.before);
  return Object.keys(f).length > 0 ? f : undefined;
}

export async function searchEmails(
  c: JmapClient,
  p: SearchParams,
): Promise<{ emails: Email[]; total?: number | undefined; position: number }> {
  const s = await c.session();
  const filter = buildFilter(p);
  const query: Record<string, unknown> = {
    accountId: s.accountId,
    sort: [{ property: "receivedAt", isAscending: false }],
    position: p.position,
    limit: p.limit,
    calculateTotal: true,
  };
  if (filter) query.filter = filter;
  const r = await c.call([
    ["Email/query", query, "q"],
    [
      "Email/get",
      {
        accountId: s.accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: SUMMARY,
      },
      "g",
    ],
  ]);
  const q = JmapClient.pick(r, "Email/query", "q");
  const g = JmapClient.pick(r, "Email/get", "g");
  const order: string[] = Array.isArray(q.ids) ? (q.ids as string[]) : [];
  const byId = new Map(parseServer(z.array(emailSchema), g.list).map((e) => [e.id, e]));
  return {
    emails: order.map((id) => byId.get(id)).filter((e): e is Email => e !== undefined),
    total: typeof q.total === "number" ? q.total : undefined,
    position: typeof q.position === "number" ? q.position : p.position,
  };
}

const BODY_BYTES = 400_000;

export async function getEmail(c: JmapClient, id: string): Promise<Email | undefined> {
  const s = await c.session();
  const r = await c.call([
    [
      "Email/get",
      {
        accountId: s.accountId,
        ids: [id],
        properties: [
          ...SUMMARY,
          "cc",
          "bcc",
          "replyTo",
          "sentAt",
          "messageId",
          "inReplyTo",
          "references",
          "textBody",
          "attachments",
          "bodyValues",
        ],
        fetchTextBodyValues: true,
        maxBodyValueBytes: BODY_BYTES,
      },
      "g",
    ],
  ]);
  const g = JmapClient.pick(r, "Email/get", "g");
  return parseServer(z.array(emailSchema), g.list)[0];
}

export async function getThread(c: JmapClient, threadId: string, max: number): Promise<Email[]> {
  const s = await c.session();
  const r = await c.call([
    ["Thread/get", { accountId: s.accountId, ids: [threadId] }, "t"],
    [
      "Email/get",
      {
        accountId: s.accountId,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: SUMMARY,
      },
      "g",
    ],
  ]);
  const g = JmapClient.pick(r, "Email/get", "g");
  return parseServer(z.array(emailSchema), g.list)
    .sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? ""))
    .slice(0, max);
}

export async function listIdentities(c: JmapClient, submissionCap: string): Promise<Identity[]> {
  const s = await c.session();
  if (!s.capabilities[submissionCap]) {
    throw new PolicyError(
      "This server does not offer the submission capability, so it has no identities.",
    );
  }
  const r = await c.call(
    [["Identity/get", { accountId: s.accountId, ids: null, properties: ["name", "email"] }, "i"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", submissionCap],
  );
  return parseServer(z.array(identitySchema), JmapClient.pick(r, "Identity/get", "i").list);
}

export type SetResult = { updated: string[]; failed: { id: string; type: string }[] };

/** Applies one patch to many emails. Reports each failure instead of hiding it. */
export async function updateEmails(
  c: JmapClient,
  ids: string[],
  patch: Record<string, unknown>,
): Promise<SetResult> {
  const s = await c.session();
  const update = Object.fromEntries(ids.map((id) => [id, patch]));
  const r = await c.call([["Email/set", { accountId: s.accountId, update }, "u"]]);
  return collectSetResult(JmapClient.pick(r, "Email/set", "u"), ids);
}

export function collectSetResult(a: Record<string, unknown>, ids: string[]): SetResult {
  const ok = (a.updated ?? {}) as Record<string, unknown>;
  const bad = (a.notUpdated ?? {}) as Record<string, { type?: unknown }>;
  return {
    updated: ids.filter((id) => Object.hasOwn(ok, id)),
    failed: Object.entries(bad).map(([id, e]) => ({
      id,
      type: typeof e?.type === "string" ? e.type : "unknown",
    })),
  };
}

export function mailboxByRole(boxes: Mailbox[], role: string): Mailbox | undefined {
  return boxes.find((b) => b.role === role);
}

export type { Reply };
