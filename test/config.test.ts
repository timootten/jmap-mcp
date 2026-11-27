import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

const base = () => ({
  JMAP_SESSION_URL: "https://mail.example.org/jmap/session",
  JMAP_USERNAME: "timo@example.org",
  JMAP_PASSWORD: "app abcd1234",
});

function fails(env: Record<string, string | undefined>, match: RegExp) {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  test("minimal read-only config", () => {
    const c = loadConfig(base());
    expect(c.send).toBe(false);
    expect(c.drafts).toBe(false);
    expect(c.organize).toBe(false);
    expect(c.attachments).toBe(false);
    expect(c.sendLimitPerHour).toBe(10);
    expect(c.name).toBe("timo@example.org");
    expect(c.apiOrigin).toBeUndefined();
  });

  test("password keeps its inner space and only loses one trailing newline", () => {
    expect(loadConfig({ ...base(), JMAP_PASSWORD: "app xxxxxxxx" }).secrets[0]?.reveal()).toBe(
      "app xxxxxxxx",
    );
    expect(loadConfig({ ...base(), JMAP_PASSWORD: "app xxxxxxxx\n" }).secrets[0]?.reveal()).toBe(
      "app xxxxxxxx",
    );
    expect(loadConfig({ ...base(), JMAP_PASSWORD: "app xxxxxxxx\r\n" }).secrets[0]?.reveal()).toBe(
      "app xxxxxxxx",
    );
    expect(loadConfig({ ...base(), JMAP_PASSWORD: "app xxxxxxxx \n" }).secrets[0]?.reveal()).toBe(
      "app xxxxxxxx ",
    );
    expect(loadConfig({ ...base(), JMAP_PASSWORD: "app xxxxxxxx\n\n" }).secrets[0]?.reveal()).toBe(
      "app xxxxxxxx\n",
    );
  });

  test("password and token are removed from the given env", () => {
    const env: Record<string, string | undefined> = { ...base() };
    loadConfig(env);
    expect("JMAP_PASSWORD" in env).toBe(false);
    const t: Record<string, string | undefined> = {
      JMAP_SESSION_URL: base().JMAP_SESSION_URL,
      JMAP_TOKEN: "tok_123456",
    };
    loadConfig(t);
    expect("JMAP_TOKEN" in t).toBe(false);
  });

  test("password is gone from process.env after loading", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, base());
      loadConfig(process.env);
      expect(process.env.JMAP_PASSWORD).toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test("secrets never show up in JSON or string conversion", () => {
    const c = loadConfig(base());
    expect(JSON.stringify(c)).not.toContain("abcd1234");
    expect(String(c.auth)).not.toContain("abcd1234");
  });

  test("bearer token works alone", () => {
    const c = loadConfig({ JMAP_SESSION_URL: base().JMAP_SESSION_URL, JMAP_TOKEN: "tok_123456" });
    expect(c.auth.kind).toBe("bearer");
    expect(c.name).toBe("jmap");
  });

  test("missing and conflicting credentials", () => {
    fails({ JMAP_SESSION_URL: base().JMAP_SESSION_URL }, /credentials missing/);
    fails({ ...base(), JMAP_PASSWORD: undefined }, /credentials missing/);
    fails({ ...base(), JMAP_TOKEN: "tok_123456" }, /not both/);
    fails(
      { JMAP_SESSION_URL: base().JMAP_SESSION_URL, JMAP_TOKEN: "tok", JMAP_PASSWORD: "x" },
      /not both/,
    );
  });

  test("session url is required and must be https", () => {
    fails({ ...base(), JMAP_SESSION_URL: undefined }, /JMAP_SESSION_URL/);
    fails({ ...base(), JMAP_SESSION_URL: "http://mail.example.org/s" }, /only https/);
    fails({ ...base(), JMAP_SESSION_URL: "ftp://mail.example.org/s" }, /only https/);
    fails({ ...base(), JMAP_SESSION_URL: "not a url" }, /not a valid URL/);
    fails({ ...base(), JMAP_SESSION_URL: "https://u:p@mail.example.org/s" }, /credentials/);
  });

  test("http is allowed for loopback only, and only with the flag", () => {
    const url = "http://127.0.0.1:8080/jmap/session";
    fails({ ...base(), JMAP_SESSION_URL: url }, /only https/);
    expect(
      loadConfig({ ...base(), JMAP_SESSION_URL: url, JMAP_ALLOW_INSECURE_LOCALHOST: "true" })
        .sessionOrigin,
    ).toBe("http://127.0.0.1:8080");
    fails(
      {
        ...base(),
        JMAP_SESSION_URL: "http://mail.example.org/s",
        JMAP_ALLOW_INSECURE_LOCALHOST: "true",
      },
      /only https/,
    );
  });

  test("api origin must be an origin", () => {
    expect(
      loadConfig({ ...base(), JMAP_API_ORIGIN: "https://stalwart.example.eu" }).apiOrigin,
    ).toBe("https://stalwart.example.eu");
    fails({ ...base(), JMAP_API_ORIGIN: "https://stalwart.example.eu/jmap" }, /origin only/);
    fails({ ...base(), JMAP_API_ORIGIN: "http://stalwart.example.eu" }, /only https/);
  });

  test("booleans accept exactly true or false", () => {
    for (const bad of ["TRUE", "True", "1", "yes", "on", " true", "true ", ""]) {
      fails({ ...base(), JMAP_DRAFTS: bad }, /JMAP_DRAFTS/);
    }
    expect(loadConfig({ ...base(), JMAP_DRAFTS: "true" }).drafts).toBe(true);
    expect(loadConfig({ ...base(), JMAP_ORGANIZE: "false" }).organize).toBe(false);
    fails({ ...base(), JMAP_SEND: "ture" }, /JMAP_SEND/);
  });

  test("unknown JMAP_ variables are a startup error", () => {
    fails({ ...base(), JMAP_SNED: "true" }, /JMAP_SNED/);
    fails({ ...base(), JMAP_draft: "true" }, /JMAP_draft/);
    expect(() => loadConfig({ ...base(), OTHER_THING: "x" })).not.toThrow();
  });

  test("sending needs an allowlist", () => {
    fails({ ...base(), JMAP_SEND: "true" }, /JMAP_ALLOWED_RECIPIENTS: required/);
    expect(
      loadConfig({ ...base(), JMAP_SEND: "true", JMAP_ALLOWED_RECIPIENTS: "*" }).allowlist?.any,
    ).toBe(true);
    fails({ ...base(), JMAP_SEND: "true", JMAP_ALLOWED_RECIPIENTS: "@*" }, /ALLOWED_RECIPIENTS/);
    fails(
      { ...base(), JMAP_SEND: "true", JMAP_ALLOWED_RECIPIENTS: "a@x.org,*" },
      /ALLOWED_RECIPIENTS/,
    );
    fails(
      { ...base(), JMAP_SEND: "true", JMAP_ALLOWED_RECIPIENTS: "a@x.org,,b@x.org" },
      /ALLOWED_RECIPIENTS/,
    );
    fails(
      { ...base(), JMAP_SEND: "true", JMAP_ALLOWED_RECIPIENTS: "*@x.org" },
      /ALLOWED_RECIPIENTS/,
    );
    const c = loadConfig({
      ...base(),
      JMAP_SEND: "true",
      JMAP_ALLOWED_RECIPIENTS: "Friend@Example.net, @example.org",
    });
    expect(c.allowlist?.patterns).toEqual(["friend@example.net", "@example.org"]);
  });

  test("send limit", () => {
    expect(loadConfig({ ...base(), JMAP_SEND_LIMIT_PER_HOUR: "3" }).sendLimitPerHour).toBe(3);
    expect(loadConfig({ ...base(), JMAP_SEND_LIMIT_PER_HOUR: "100000" }).sendLimitPerHour).toBe(
      100_000,
    );
    expect(loadConfig({ ...base(), JMAP_SEND_LIMIT_PER_HOUR: "unlimited" }).sendLimitPerHour).toBe(
      Number.POSITIVE_INFINITY,
    );
    for (const bad of ["0", "-1", "1.5", "abc", "100001", "Unlimited", "inf", ""]) {
      fails({ ...base(), JMAP_SEND_LIMIT_PER_HOUR: bad }, /JMAP_SEND_LIMIT_PER_HOUR/);
    }
  });

  test("JMAP_READ defaults to true and is a strict boolean", () => {
    expect(loadConfig(base()).read).toBe(true);
    expect(loadConfig({ ...base(), JMAP_READ: "false" }).read).toBe(false);
    fails({ ...base(), JMAP_READ: "no" }, /JMAP_READ/);
  });

  test("state dir", () => {
    expect(loadConfig({ ...base(), JMAP_STATE_DIR: "/var/x" }).stateDir).toBe("/var/x");
    fails({ ...base(), JMAP_STATE_DIR: "relative/dir" }, /absolute/);
    expect(loadConfig({ ...base(), XDG_STATE_HOME: "/xdg" }).stateDir).toBe("/xdg/jmap-mcp");
  });

  test("errors never echo the password", () => {
    try {
      loadConfig({ ...base(), JMAP_PASSWORD: "app secretvalue1", JMAP_DRAFTS: "maybe" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secretvalue1");
    }
  });
});

describe("attachment folder", () => {
  const folder = mkdtempSync(join(tmpdir(), "jmap-cfg-"));
  const file = join(folder, "file.txt");
  writeFileSync(file, "x");
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const withSend = { JMAP_SEND: "true", JMAP_ALLOWED_RECIPIENTS: "a@x.org" };

  test("is off by default", () => {
    const c = loadConfig(base());
    expect(c.attachmentDir).toBeUndefined();
    expect(c.attachmentMaxBytes).toBe(15_000_000);
  });
  test("works with sending or with drafts", () => {
    expect(loadConfig({ ...base(), ...withSend, JMAP_ATTACHMENT_DIR: folder }).attachmentDir).toBe(
      folder,
    );
    expect(
      loadConfig({ ...base(), JMAP_DRAFTS: "true", JMAP_ATTACHMENT_DIR: folder }).attachmentDir,
    ).toBe(folder);
  });
  test("needs sending or drafts, otherwise it is a typo-sized mistake", () => {
    fails({ ...base(), JMAP_ATTACHMENT_DIR: folder }, /needs JMAP_SEND=true or JMAP_DRAFTS=true/);
  });
  test("must be an existing, dedicated folder", () => {
    const on = { ...base(), ...withSend };
    fails({ ...on, JMAP_ATTACHMENT_DIR: "relative/dir" }, /absolute/);
    fails({ ...on, JMAP_ATTACHMENT_DIR: join(folder, "missing") }, /does not exist/);
    fails({ ...on, JMAP_ATTACHMENT_DIR: file }, /not a folder/);
    fails({ ...on, JMAP_ATTACHMENT_DIR: "/" }, /dedicated/);
  });
  test("size limit", () => {
    const on = { ...base(), ...withSend, JMAP_ATTACHMENT_DIR: folder };
    expect(loadConfig({ ...on, JMAP_ATTACHMENT_MAX_MB: "5" }).attachmentMaxBytes).toBe(5_000_000);
    expect(loadConfig({ ...on, JMAP_ATTACHMENT_MAX_MB: "100" }).attachmentMaxBytes).toBe(
      100_000_000,
    );
    for (const bad of ["0", "101", "1.5", "-1", "abc", "5MB", ""]) {
      fails({ ...on, JMAP_ATTACHMENT_MAX_MB: bad }, /JMAP_ATTACHMENT_MAX_MB/);
    }
    fails({ ...base(), ...withSend, JMAP_ATTACHMENT_MAX_MB: "5" }, /without JMAP_ATTACHMENT_DIR/);
  });
  test("a typo in the name is a startup error", () => {
    fails({ ...base(), ...withSend, JMAP_ATTACHMENT_FOLDER: folder }, /JMAP_ATTACHMENT_FOLDER/);
  });
});
