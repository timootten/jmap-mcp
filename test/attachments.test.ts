import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttachmentSource,
  checkAttachmentDir,
  listAttachmentFiles,
  loadAttachments,
  MAX_ATTACHMENTS,
  readAttachment,
} from "../src/attachments.ts";
import { ConfigError, PolicyError } from "../src/errors.ts";

let base: string;
let dir: string;
let outside: string;
let src: AttachmentSource;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "jmap-att-")));
  dir = join(base, "outbox");
  outside = join(base, "secret");
  mkdirSync(dir);
  mkdirSync(outside);
  writeFileSync(join(outside, "passwd.txt"), "top secret");
  src = { dir, maxBytes: 1000 };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (rel: string, content: string | Uint8Array = "hello") => {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

const refuses = (rel: string, match?: RegExp) => {
  try {
    readAttachment(src, rel, src.maxBytes);
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    if (match) expect((e as Error).message).toMatch(match);
    if (!rel.includes(base)) expect((e as Error).message).not.toContain(base);
    return;
  }
  throw new Error(`expected a refusal for ${JSON.stringify(rel)}`);
};

describe("readAttachment", () => {
  test("reads a file and derives name and type", () => {
    put("report.PDF", "%PDF-1.4 test");
    const f = readAttachment(src, "report.PDF", 1000);
    expect(f.name).toBe("report.PDF");
    expect(f.type).toBe("application/pdf");
    expect(new TextDecoder().decode(f.bytes)).toBe("%PDF-1.4 test");
  });
  test("knows common types and falls back to octet-stream", () => {
    for (const [file, type] of [
      ["a.png", "image/png"],
      ["a.jpeg", "image/jpeg"],
      ["a.csv", "text/csv"],
      ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["a.exe", "application/octet-stream"],
      ["noext", "application/octet-stream"],
    ] as const) {
      put(file);
      expect(readAttachment(src, file, 1000).type).toBe(type);
    }
  });
  test("subfolders work, the name is the last part", () => {
    put("2026/q3/summary.txt");
    const f = readAttachment(src, "2026/q3/summary.txt", 1000);
    expect(f.name).toBe("summary.txt");
    expect(f.path).toBe("2026/q3/summary.txt");
  });
  test("umlauts and spaces are fine", () => {
    put("Übersicht 2026.pdf");
    expect(readAttachment(src, "Übersicht 2026.pdf", 1000).name).toBe("Übersicht 2026.pdf");
  });
  test("direction and control characters are removed from the name", () => {
    put("invoice\u202Egpj.exe");
    expect(readAttachment(src, "invoice\u202Egpj.exe", 1000).name).toBe("invoicegpj.exe");
    put("line\nbreak.txt");
    expect(readAttachment(src, "line\nbreak.txt", 1000).name).toBe("line break.txt");
  });

  test("refuses paths that leave the folder", () => {
    for (const rel of [
      "../secret/passwd.txt",
      "a/../../secret/passwd.txt",
      "/etc/passwd",
      `${outside}/passwd.txt`,
      "..",
      ".",
      "",
      "a//b",
      "a/",
      "a\\b",
      "x\0y",
      "~/x",
    ]) {
      refuses(rel);
    }
  });
  test("refuses hidden files and folders", () => {
    put(".env", "KEY=1");
    put(".git/config", "x");
    put("ok/.hidden", "x");
    for (const rel of [".env", ".git/config", "ok/.hidden"]) refuses(rel, /hidden/);
  });
  test("refuses a symlink that points outside, also through a folder", () => {
    symlinkSync(join(outside, "passwd.txt"), join(dir, "link.txt"));
    symlinkSync(outside, join(dir, "linked"));
    refuses("link.txt", /outside/);
    refuses("linked/passwd.txt", /outside/);
  });
  test("allows a symlink that stays inside", () => {
    put("real.txt", "inside");
    symlinkSync(join(dir, "real.txt"), join(dir, "alias.txt"));
    expect(new TextDecoder().decode(readAttachment(src, "alias.txt", 1000).bytes)).toBe("inside");
  });
  test("a folder named like the root prefix does not pass", () => {
    const sibling = `${dir}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "x.txt"), "x");
    symlinkSync(join(sibling, "x.txt"), join(dir, "x.txt"));
    refuses("x.txt", /outside/);
  });
  test("refuses missing files, folders, empty files and special files", () => {
    refuses("nope.txt", /not found/);
    mkdirSync(join(dir, "sub"));
    refuses("sub", /not a regular file/);
    put("empty.txt", "");
    refuses("empty.txt", /empty/);
    const fifo = join(dir, "pipe");
    const r = Bun.spawnSync(["mkfifo", fifo]);
    if (r.exitCode === 0) refuses("pipe", /not a regular file/);
  });
  test("refuses files above the budget", () => {
    put("big.bin", new Uint8Array(2000));
    refuses("big.bin", /too large/);
    put("fits.bin", new Uint8Array(1000));
    expect(readAttachment(src, "fits.bin", 1000).bytes.length).toBe(1000);
  });
  test("error messages never show the real path", () => {
    refuses("../secret/passwd.txt");
    refuses("nope.txt");
  });
});

describe("loadAttachments", () => {
  test("loads several files in order", () => {
    put("a.txt", "a");
    put("b.txt", "bb");
    const files = loadAttachments(src, ["b.txt", "a.txt"]);
    expect(files.map((f) => f.name)).toEqual(["b.txt", "a.txt"]);
  });
  test("the budget covers all files together", () => {
    put("a.bin", new Uint8Array(600));
    put("b.bin", new Uint8Array(600));
    expect(() => loadAttachments(src, ["a.bin"])).not.toThrow();
    expect(() => loadAttachments(src, ["a.bin", "b.bin"])).toThrow(/too large/);
  });
  test("limits the count and refuses duplicates", () => {
    put("a.txt");
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => "a.txt");
    expect(() => loadAttachments(src, many)).toThrow(/Too many/);
    expect(() => loadAttachments(src, ["a.txt", "a.txt"])).toThrow(/twice/);
  });
  test("one bad file refuses the whole message", () => {
    put("a.txt");
    expect(() => loadAttachments(src, ["a.txt", "../secret/passwd.txt"])).toThrow(PolicyError);
  });
});

describe("listAttachmentFiles", () => {
  test("lists regular files, skips hidden entries, folders and symlinks", () => {
    put("b.pdf", "12345");
    put("a.txt", "1");
    put("sub/c.png", "123");
    put(".secret", "x");
    put(".hidden/d.txt", "x");
    symlinkSync(join(outside, "passwd.txt"), join(dir, "link.txt"));
    symlinkSync(outside, join(dir, "linked"));
    const { files, truncated } = listAttachmentFiles(src);
    expect(truncated).toBe(false);
    expect(files).toEqual([
      { path: "a.txt", size: 1, type: "text/plain" },
      { path: "b.pdf", size: 5, type: "application/pdf" },
      { path: "sub/c.png", size: 3, type: "image/png" },
    ]);
  });
  test("caps the number of entries and the depth", () => {
    for (let i = 0; i < 205; i++) put(`f${String(i).padStart(3, "0")}.txt`);
    put("a/b/c/d/deep.txt");
    const { files, truncated } = listAttachmentFiles(src);
    expect(files.length).toBe(200);
    expect(truncated).toBe(true);
    expect(files.some((f) => f.path.includes("deep"))).toBe(false);
  });
  test("an empty folder lists nothing", () => {
    expect(listAttachmentFiles(src)).toEqual({ files: [], truncated: false });
  });
});

describe("checkAttachmentDir", () => {
  test("accepts a dedicated folder", () => {
    expect(() => checkAttachmentDir(dir)).not.toThrow();
  });
  test("refuses a missing path, a file, the root and the home directory", () => {
    expect(() => checkAttachmentDir(join(base, "missing"))).toThrow(ConfigError);
    writeFileSync(join(base, "file"), "x");
    expect(() => checkAttachmentDir(join(base, "file"))).toThrow(/not a folder/);
    expect(() => checkAttachmentDir("/")).toThrow(/dedicated/);
    expect(() => checkAttachmentDir(homedir())).toThrow(/dedicated/);
  });
});
