export class ConfigError extends Error {
  override name = "ConfigError";
}

/** A request refused by a local rule. The message is ours and safe to show. */
export class PolicyError extends Error {
  override name = "PolicyError";
}

/** A failed JMAP/HTTP exchange. `detail` is server-provided text and untrusted. */
export class JmapError extends Error {
  override name = "JmapError";
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail === undefined ? undefined : clip(detail, 300);
  }
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Holds a credential so it cannot end up in logs or JSON by accident. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

export type Redactor = (text: string) => string;

export function makeRedactor(secrets: Secret[]): Redactor {
  const values = secrets.map((s) => s.reveal()).filter((v) => v.length >= 4);
  return (text) => values.reduce((acc, v) => acc.split(v).join("[redacted]"), text);
}
