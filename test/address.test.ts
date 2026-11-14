import { describe, expect, test } from "bun:test";
import {
  Allowlist,
  cleanName,
  enforceAllowlist,
  normalizeEmail,
  parseAllowlist,
  toAddress,
} from "../src/address.ts";
import { PolicyError } from "../src/errors.ts";

const allow = parseAllowlist("friend@example.net, @example.org");
const rec = (to: string[], cc: string[] = [], bcc: string[] = []) => ({
  to: to.map(toAddress),
  cc: cc.map(toAddress),
  bcc: bcc.map(toAddress),
});

describe("normalizeEmail", () => {
  test("lowercases a plain address", () => {
    expect(normalizeEmail("Friend@Example.NET")).toBe("friend@example.net");
  });
  test("rejects everything that is not a single plain addr-spec", () => {
    const bad = [
      "a@x.org, b@evil.org",
      "a@x.org,b@evil.org",
      "a@x.org;b@evil.org",
      "a@x.org b@evil.org",
      "Friend <friend@example.net>",
      '"Friend" <friend@example.net>',
      "friend@example.net (comment)",
      "(c)friend@example.net",
      "a@b@c.org",
      "@example.org",
      "friend@",
      "friend",
      "friend@example",
      "friend@exa mple.org",
      "friend@example.org\n",
      "friend@example.org\r\nBcc: evil@evil.org",
      "friend@example.org\u0000",
      "frien\u0434@example.org",
      "friend@exаmple.org",
      "friend@-example.org",
      "friend@example..org",
      "..a@example.org",
      "a..b@example.org",
      "a@[127.0.0.1]",
      "",
      `${"a".repeat(65)}@example.org`,
    ];
    for (const b of bad) expect(() => normalizeEmail(b), JSON.stringify(b)).toThrow(PolicyError);
  });
});

describe("cleanName", () => {
  test("strips characters that could imitate an address", () => {
    expect(cleanName('Evil <evil@evil.org> "x"')).toBe("Evil evil evil.org x");
    expect(cleanName("a\r\nBcc: x")).toBe("a Bcc: x");
    expect(cleanName("\u202eabc")).toBe("abc");
    expect(cleanName("")).toBeUndefined();
  });
});

describe("Allowlist", () => {
  test("exact addresses and domain patterns, case-insensitive", () => {
    expect(allow.matches("friend@example.net")).toBe(true);
    expect(allow.matches(normalizeEmail("FRIEND@EXAMPLE.NET"))).toBe(true);
    expect(allow.matches("anyone@example.org")).toBe(true);
    expect(allow.matches("other@example.net")).toBe(false);
  });
  test("a domain pattern does not match subdomains or look-alikes", () => {
    expect(allow.matches("x@sub.example.org")).toBe(false);
    expect(allow.matches("x@evilexample.org")).toBe(false);
    expect(allow.matches("x@example.org.evil.com")).toBe(false);
  });
  test("rejects wildcard patterns", () => {
    for (const p of ["@*", "*@example.org", "a*@example.org", "@", "@.org", "a@b@c", ""]) {
      expect(() => new Allowlist([p]), p).toThrow();
    }
  });
});

describe("Allowlist with *", () => {
  test("a lone * allows every valid address", () => {
    const any = parseAllowlist("*");
    expect(any.any).toBe(true);
    expect(any.matches("someone@random.example")).toBe(true);
    expect(enforceAllowlist(rec(["a@x.org"], ["b@y.org"], ["c@z.org"]), any)).toEqual([
      "a@x.org",
      "b@y.org",
      "c@z.org",
    ]);
  });
  test("* cannot be mixed with other entries", () => {
    expect(() => parseAllowlist("a@x.org,*")).toThrow();
    expect(() => parseAllowlist("*,@x.org")).toThrow();
  });
  test("address syntax is still checked with *", () => {
    expect(() => toAddress("a@x.org, b@evil.org")).toThrow(PolicyError);
    expect(() => toAddress("Name <a@x.org>")).toThrow(PolicyError);
  });
});

describe("enforceAllowlist", () => {
  test("accepts allowed recipients in all three fields", () => {
    const r = enforceAllowlist(
      rec(["friend@example.net"], ["a@example.org"], ["b@example.org"]),
      allow,
    );
    expect(r).toEqual(["friend@example.net", "a@example.org", "b@example.org"]);
  });
  test("rejects a disallowed To, Cc and Bcc", () => {
    expect(() => enforceAllowlist(rec(["evil@evil.org"]), allow)).toThrow(/evil@evil.org \(to\)/);
    expect(() => enforceAllowlist(rec(["friend@example.net"], ["evil@evil.org"]), allow)).toThrow(
      /\(cc\)/,
    );
    expect(() =>
      enforceAllowlist(rec(["friend@example.net"], [], ["evil@evil.org"]), allow),
    ).toThrow(/\(bcc\)/);
  });
  test("one bad recipient rejects the whole message", () => {
    expect(() => enforceAllowlist(rec(["friend@example.net", "evil@evil.org"]), allow)).toThrow(
      PolicyError,
    );
  });
  test("a list in one field is refused before it gets here", () => {
    expect(() => toAddress("friend@example.net, evil@evil.org")).toThrow(PolicyError);
    expect(() => toAddress("a@example.org,b@evil.org")).toThrow(PolicyError);
  });
  test("display-name injection does not change the checked address", () => {
    const a = toAddress({ name: "friend@example.net", email: "evil@evil.org" });
    expect(a.email).toBe("evil@evil.org");
    expect(() => enforceAllowlist({ to: [a], cc: [], bcc: [] }, allow)).toThrow(PolicyError);
    const b = toAddress({ name: "x <evil@evil.org>", email: "friend@example.net" });
    expect(b.name).not.toContain("<");
  });
  test("needs a To recipient and caps the count", () => {
    expect(() => enforceAllowlist(rec([], ["friend@example.net"]), allow)).toThrow(/To recipient/);
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.org`);
    expect(() => enforceAllowlist(rec(many), allow)).toThrow(/Too many/);
  });
});
