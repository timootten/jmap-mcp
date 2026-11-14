import { afterAll, describe, expect, test } from "bun:test";
import { type McpProc, startServer } from "./helpers.ts";

// Read-only check against a real server. Skipped unless JMAP_LIVE_TEST=1.
// Needs JMAP_LIVE_SESSION_URL, JMAP_LIVE_USERNAME and JMAP_LIVE_PASSWORD (optional: JMAP_LIVE_API_ORIGIN).
const enabled = process.env.JMAP_LIVE_TEST === "1";
const live = describe.skipIf(!enabled);

live("live (read only)", () => {
  let p: McpProc | undefined;
  afterAll(() => p?.close());

  test("lists mailboxes and identities, searches, reads one mail", async () => {
    const env: Record<string, string> = {
      JMAP_SESSION_URL: process.env.JMAP_LIVE_SESSION_URL ?? "",
      JMAP_USERNAME: process.env.JMAP_LIVE_USERNAME ?? "",
      JMAP_PASSWORD: process.env.JMAP_LIVE_PASSWORD ?? "",
      JMAP_NAME: "live",
    };
    if (process.env.JMAP_LIVE_API_ORIGIN) env.JMAP_API_ORIGIN = process.env.JMAP_LIVE_API_ORIGIN;
    p = await startServer(env);
    expect(await p.tools()).toEqual([
      "account_info",
      "get_email",
      "get_thread",
      "list_identities",
      "list_mailboxes",
      "search_emails",
    ]);

    const boxes = await p.call("list_mailboxes");
    expect(boxes.isError).toBe(false);
    expect(boxes.text).toMatch(/role: inbox/);

    const ids = await p.call("list_identities");
    expect(ids.isError).toBe(false);

    const found = await p.call("search_emails", { limit: 3 });
    expect(found.isError).toBe(false);
    const nonce = /\[UNTRUSTED_([0-9a-f]{16}) /.exec(found.text)?.[1];
    expect(nonce).toBeDefined();

    const id = /\bid: ([A-Za-z0-9_-]+)/.exec(found.text)?.[1];
    if (id) {
      const mail = await p.call("get_email", { id, max_chars: 500 });
      expect(mail.isError).toBe(false);
      expect(mail.text).toMatch(/\[\/UNTRUSTED_[0-9a-f]{16}\]/);
    }
    const info = await p.call("account_info");
    expect(info.text).not.toContain(process.env.JMAP_LIVE_PASSWORD ?? "\u0000never");
    console.log(
      `live ok: mailbox list ${boxes.text.split("\n").length} lines, search ${found.text.split("\n").length} lines`,
    );
  }, 60_000);
});
