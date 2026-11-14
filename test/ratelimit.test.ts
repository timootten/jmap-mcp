import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter } from "../src/ratelimit.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jmap-rl-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RateLimiter", () => {
  test("allows up to the limit, then refuses", () => {
    const rl = new RateLimiter(2, dir, "acct");
    rl.reserve();
    rl.reserve();
    expect(() => rl.reserve()).toThrow(/Send limit reached/);
  });
  test("the window slides", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(1, dir, "acct", () => now);
    rl.reserve();
    now += 59 * 60_000;
    expect(() => rl.reserve()).toThrow(/about 1 minutes/);
    now += 2 * 60_000;
    expect(() => rl.reserve()).not.toThrow();
  });
  test("a restart does not reset it", () => {
    new RateLimiter(1, dir, "acct").reserve();
    const again = new RateLimiter(1, dir, "acct");
    expect(() => again.reserve()).toThrow(/Send limit reached/);
    expect(again.used()).toBe(1);
  });
  test("accounts are independent", () => {
    new RateLimiter(1, dir, "a").reserve();
    expect(() => new RateLimiter(1, dir, "b").reserve()).not.toThrow();
  });
  test("the state file is private and holds only timestamps", () => {
    const rl = new RateLimiter(5, dir, "acct");
    rl.reserve();
    expect(statSync(rl.file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(rl.file, "utf8")))).toEqual(["version", "sends"]);
  });
  test("a corrupt state file blocks sending instead of resetting the limit", () => {
    const rl = new RateLimiter(5, dir, "acct");
    writeFileSync(rl.file, "{not json");
    expect(() => rl.reserve()).toThrow(/corrupt/);
    writeFileSync(rl.file, JSON.stringify({ sends: ["x"] }));
    expect(() => rl.reserve()).toThrow(/corrupt/);
  });
  test("an unreadable state file blocks sending", () => {
    const rl = new RateLimiter(5, dir, "acct");
    writeFileSync(rl.file, "{}");
    chmodSync(rl.file, 0o000);
    if (process.getuid?.() !== 0) expect(() => rl.reserve()).toThrow(/not readable/);
  });
  test("an unwritable state dir blocks sending", () => {
    const file = join(dir, "blocker");
    writeFileSync(file, "");
    expect(() => new RateLimiter(5, join(file, "sub"), "acct").reserve()).toThrow(
      /cannot be written/,
    );
  });
});
