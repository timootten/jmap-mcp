#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.ts";
import { ConfigError, makeRedactor } from "./errors.ts";
import { CAP_SUBMISSION, JmapClient } from "./jmap.ts";
import { createLogger } from "./log.ts";
import { RateLimiter } from "./ratelimit.ts";
import { createServer, describeError } from "./server.ts";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (e) {
  const msg = e instanceof ConfigError ? e.message : "Invalid configuration.";
  process.stderr.write(`jmap-mcp: ${msg}\n`);
  process.exit(1);
}

const redact = makeRedactor(config.secrets);
const log = createLogger(config.name, redact);
const client = new JmapClient(config);
const limiter = config.send
  ? new RateLimiter(config.sendLimitPerHour, config.stateDir, config.name)
  : undefined;

if (config.send && config.allowlist?.any) {
  log.warn(
    "JMAP_ALLOWED_RECIPIENTS=*: the recipient allowlist is off. Every valid address can receive mail.",
  );
}
if (config.attachmentDir && config.send && config.allowlist?.any) {
  log.warn(
    "JMAP_ATTACHMENT_DIR is set and any recipient is allowed: every file in that folder can be mailed to anyone. Keep the folder small and free of secrets.",
  );
}
if (config.send && config.sendLimitPerHour === Number.POSITIVE_INFINITY) {
  log.warn("JMAP_SEND_LIMIT_PER_HOUR=unlimited: the send rate limit is off.");
}

let submission = true;
try {
  const s = await client.session();
  if (!s.capabilities[CAP_SUBMISSION]) {
    submission = false;
    if (config.send) {
      log.warn(
        "JMAP_SEND=true, but the server has no urn:ietf:params:jmap:submission capability. Sending is disabled; reading still works.",
      );
    }
  }
} catch (e) {
  log.warn(
    `Session not reachable at start, will retry on the first call: ${describeError(e, { log, redact })}`,
  );
}

serveStdio(() => createServer({ config, client, limiter, log, redact }, { submission }), {
  onerror: (e) => log.warn(`transport error: ${e.name}`),
});
log.info(
  `ready: read=${config.read} drafts=${config.drafts} send=${config.send && submission} organize=${config.organize} attachments=${config.attachments} send_files=${config.attachmentDir !== undefined}`,
);
