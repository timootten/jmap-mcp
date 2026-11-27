import type { Redactor } from "./errors.ts";

export interface AuditEvent {
  tool: string;
  result: "sent" | "draft_created" | "denied" | "error";
  recipients?: string[];
  subjectLength?: number;
  /** Attached file names (cleaned and cut), or the paths a refused request asked for. */
  attachments?: string[];
  attachmentBytes?: number;
  /** Fixed reason code written by this program, never server text. */
  reason?: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  audit(event: AuditEvent): void;
}

/** JSON lines on stderr. stdout belongs to the MCP protocol. */
export function createLogger(
  account: string,
  redact: Redactor,
  write: (line: string) => void = (l) => process.stderr.write(l),
): Logger {
  const emit = (record: Record<string, unknown>) =>
    write(`${redact(JSON.stringify({ ts: new Date().toISOString(), account, ...record }))}\n`);
  return {
    info: (msg) => emit({ level: "info", msg }),
    warn: (msg) => emit({ level: "warn", msg }),
    audit: (e) => emit({ level: "audit", ...e }),
  };
}
