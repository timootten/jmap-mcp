import {
  closeSync,
  constants,
  type Dirent,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join, sep } from "node:path";
import { clip, ConfigError, PolicyError } from "./errors.ts";
import { headerSafe, stripInvisible } from "./sanitize.ts";

// Files that may be attached come from one folder chosen by the operator. The model names
// files relative to that folder and never gets a general way to read the file system.

export const MAX_ATTACHMENTS = 10;
const MAX_NAME = 200;
const MAX_PATH = 500;
const MAX_LISTED = 200;
const MAX_DEPTH = 3;

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface AttachmentSource {
  dir: string;
  /** Total size of all files of one message. */
  maxBytes: number;
}

export interface AttachmentFile {
  /** Path relative to the folder, as it was listed. */
  path: string;
  /** File name as the recipient sees it. Cleaned of control and direction characters. */
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface ListedFile {
  path: string;
  size: number;
  type: string;
}

function typeOf(name: string): string {
  return TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1_000_000) * 10) / 10} MB`;
}

/** Startup check. The folder must exist and must not be something as broad as the home directory. */
export function checkAttachmentDir(dir: string): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new ConfigError("JMAP_ATTACHMENT_DIR: the folder does not exist");
  }
  if (!statSync(real).isDirectory()) throw new ConfigError("JMAP_ATTACHMENT_DIR: not a folder");
  let home: string | undefined;
  try {
    home = realpathSync(homedir());
  } catch {}
  if (real === sep || real === home) {
    throw new ConfigError(
      "JMAP_ATTACHMENT_DIR: use a dedicated folder, not the file system root or the home directory",
    );
  }
}

function rootOf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    throw new PolicyError("The attachment folder is not available.");
  }
}

function within(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function shown(rel: string): string {
  return clip(headerSafe(rel), 80);
}

/** Splits a relative path. No empty parts, no `.` or `..`, no hidden files or folders. */
function segments(rel: string): string[] {
  const parts = rel.split("/");
  if (
    rel.length === 0 ||
    rel.length > MAX_PATH ||
    rel.includes("\0") ||
    rel.includes("\\") ||
    parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))
  ) {
    throw new PolicyError(
      `Not an allowed attachment path: ${shown(rel)}. Use a path relative to the attachment folder, as listed by list_attachment_files. No "..", no absolute paths, no hidden files.`,
    );
  }
  return parts;
}

function fileName(last: string): string {
  const cleaned = headerSafe(stripInvisible(last).text)
    .replace(/[/\\]/g, "_")
    .slice(0, MAX_NAME)
    .trim();
  return cleaned === "" ? "attachment" : cleaned;
}

/**
 * Reads one file from the folder. The path is resolved with symlinks first and must stay
 * inside the folder. The file is then opened without following a symlink, and on Linux the
 * opened file is checked again, so swapping a path component in between does not help.
 */
export function readAttachment(
  source: AttachmentSource,
  rel: string,
  budget: number,
): AttachmentFile {
  const parts = segments(rel);
  const root = rootOf(source.dir);
  const outside = () =>
    new PolicyError(`Attachment is outside the attachment folder: ${shown(rel)}.`);

  let real: string;
  try {
    real = realpathSync(join(root, ...parts));
  } catch {
    throw new PolicyError(
      `Attachment not found: ${shown(rel)}. Use list_attachment_files to see what is available.`,
    );
  }
  if (!within(root, real)) throw outside();

  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new PolicyError(`Attachment cannot be read: ${shown(rel)}.`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PolicyError(`Attachment is not a regular file: ${shown(rel)}.`);
    if (existsSync("/proc/self/fd") && !within(root, realpathSync(`/proc/self/fd/${fd}`))) {
      throw outside();
    }
    if (st.size === 0) throw new PolicyError(`Attachment is empty: ${shown(rel)}.`);
    if (st.size > budget) {
      throw new PolicyError(
        `Attachments are too large: ${shown(rel)} does not fit into the limit of ${megabytes(source.maxBytes)} per message.`,
      );
    }
    const bytes = new Uint8Array(st.size);
    let got = 0;
    while (got < bytes.length) {
      const n = readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) throw new PolicyError(`Attachment changed while it was read: ${shown(rel)}.`);
      got += n;
    }
    const name = fileName(parts.at(-1) as string);
    return { path: parts.join("/"), name, type: typeOf(name), bytes };
  } finally {
    closeSync(fd);
  }
}

/** Reads all files of one message. The total size is limited, and so is the number. */
export function loadAttachments(source: AttachmentSource, rels: string[]): AttachmentFile[] {
  if (rels.length > MAX_ATTACHMENTS) {
    throw new PolicyError(`Too many attachments (limit ${MAX_ATTACHMENTS}).`);
  }
  const seen = new Set<string>();
  const files: AttachmentFile[] = [];
  let budget = source.maxBytes;
  for (const rel of rels) {
    const file = readAttachment(source, rel, budget);
    if (seen.has(file.path)) throw new PolicyError(`Attachment listed twice: ${shown(rel)}.`);
    seen.add(file.path);
    budget -= file.bytes.length;
    files.push(file);
  }
  return files;
}

/** Regular files in the folder, without hidden entries and without symlinks. */
export function listAttachmentFiles(source: AttachmentSource): {
  files: ListedFile[];
  truncated: boolean;
} {
  const root = rootOf(source.dir);
  const files: ListedFile[] = [];
  let truncated = false;
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(join(dir, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= MAX_LISTED) {
          truncated = true;
          return;
        }
        try {
          files.push({ path: rel, size: statSync(join(dir, e.name)).size, type: typeOf(e.name) });
        } catch {}
      }
    }
  };
  walk(root, "", 0);
  return { files, truncated };
}
