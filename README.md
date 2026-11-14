# jmap-mcp

A small MCP server (stdio, Bun) for **one** JMAP mail account (RFC 8620, RFC 8621 incl. submission).
It is written to be read in an afternoon: about 2,500 lines of TypeScript, three runtime dependencies
(`@modelcontextprotocol/server`, `zod`, `htmlparser2`), no JMAP client library.

Tested against Stalwart, but it only uses standard JMAP and runs against a mock server in its tests.

Several accounts are several entries in your MCP client config. Each entry starts the same program with its own environment.
There is no config file.

Reading is on by default and can be switched off (`JMAP_READ=false`) for send-only setups. Drafts, sending, organizing and attachments are switched on one by one. The defaults are restrictive. Sending can be opened up as far as you want (`JMAP_ALLOWED_RECIPIENTS=*`, `JMAP_SEND_LIMIT_PER_HOUR=unlimited`).

## Threat model

Incoming mail is hostile input. The goal: a prompt injection in a mail cannot do more than the environment variables allow.

**What the server enforces in code (not in the model):**

| Protection                  | How                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipient allowlist         | Applies to To, Cc and Bcc (unless `JMAP_ALLOWED_RECIPIENTS=*`, which allows any recipient but still checks the address syntax), also for `reply_email` and `send_draft`. One plain address per entry. Addresses are parsed strictly (no display names, comments, lists, non-ASCII) and compared lowercase. Patterns are exact addresses or `@domain` (no wildcards, no subdomains). One bad recipient rejects the whole message. |
| Sender                      | `from` must match a JMAP identity of the account.                                                                                                                                                                                                                                                                                                                                                                                |
| Rate limit                  | `JMAP_SEND_LIMIT_PER_HOUR`, sliding window, in memory and in a small file in `JMAP_STATE_DIR`. If the file is unreadable or corrupt, sending is refused.                                                                                                                                                                                                                                                                         |
| Audit log                   | JSON lines on stderr: time, account name, recipients, subject length, result. Never mail text, never credentials.                                                                                                                                                                                                                                                                                                                |
| Untrusted content           | Everything from a mail (subject, addresses, body, file names, previews) is returned in `[UNTRUSTED_<nonce>] ... [/UNTRUSTED_<nonce>]` blocks. The nonce is new for every call and every line inside carries it. Marker-like strings in the content are removed. The server instructions tell the model that these blocks are data.                                                                                               |
| Sanitizing                  | Zero-width and bidi characters, control characters, hidden HTML (`display:none`, `visibility:hidden`, `opacity:0`, font size 0, `hidden`, comments, scripts, styles), tracking pixels and Markdown images are removed. A visible warning with the character count is appended when something was removed. All scans are linear time (tests include 300,000 repetitions of `<style `).                                            |
| Network                     | HTTPS only (`http` for loopback with `JMAP_ALLOW_INSECURE_LOCALHOST=true`). Redirects are only followed inside the same origin. Credentials go only to the session origin and `JMAP_API_ORIGIN`. A session that names another host is rejected. Timeouts and size limits on every response.                                                                                                                                      |
| Secrets                     | Held in a wrapper that prints as `[redacted]`, removed from `process.env` after start, redacted from all log lines and error text. Server error text is shortened and cleaned before it reaches the model.                                                                                                                                                                                                                       |
| No delete, no config change | There is no delete tool. Moving to Trash is refused. No tool changes configuration.                                                                                                                                                                                                                                                                                                                                              |

**What it does not protect against:**

- A mail can still _persuade the model to do something inside the allowed scope_: send a text of its choosing to an allowed recipient, mark or move mail (if `JMAP_ORGANIZE`), read mail and attachments and repeat their content to an allowed recipient. Keep the allowlist short and use the permission rules below.
- With `JMAP_ALLOWED_RECIPIENTS=*` and `JMAP_SEND_LIMIT_PER_HOUR=unlimited` nothing limits where mail goes or how much is sent. A prompt injection can then mail mailbox content to anyone. Use these settings only for send-only accounts (`JMAP_READ=false`) or keep the `ask` permission rules in your client. The address syntax and the sender identity are still checked.
- The fencing is a mitigation, not a guarantee. Models can still be fooled by text inside a fence.
- Whoever can edit your MCP client config can change every setting. Protect that file.
- Plain text only. The server sends no HTML and no attachments.
- Data you send to an allowed recipient is not under this server's control any more.
- A compromised machine or compromised dependencies. Versions are pinned and `bun.lock` is committed, but nothing is audited for you.

## Install and start

```jsonc
"command": ["bunx", "@timootten/jmap-mcp@0.1.0"]
```

The package ships TypeScript (`bin` points at `src/index.ts` with a `#!/usr/bin/env bun` shebang). Bun runs it directly, no build step. Pin an exact version.

## Environment variables

All variables are validated at start. Any error ends the process with a message on stderr (fail closed). Any unknown `JMAP_*` variable is an error.

| Variable                          | Required            | Meaning                                                                                                                                                                                                             |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JMAP_SESSION_URL`                | yes                 | JMAP session URL, https only                                                                                                                                                                                        |
| `JMAP_API_ORIGIN`                 | no                  | Replaces the origin of `apiUrl`, `uploadUrl`, `downloadUrl`, `eventSourceUrl` from the session. Needed when the server advertises a host that is not reachable from outside (seen with Stalwart).                   |
| `JMAP_USERNAME` + `JMAP_PASSWORD` | yes (Basic)         | User and password or app password. Taken as is, including inner spaces (`app xxxxxxxx`). At most one trailing line ending is removed.                                                                               |
| `JMAP_TOKEN`                      | yes (Bearer)        | Bearer token. Exactly one of the two login methods.                                                                                                                                                                 |
| `JMAP_NAME`                       | no                  | Short name for logs and the state file. Default: user name.                                                                                                                                                         |
| `JMAP_READ`                       | no                  | `false` removes `list_mailboxes`, `search_emails`, `get_email`, `get_thread` and `list_identities`, for send-only setups. Default `true`. `reply_email` and `send_draft` still read the mail or draft they work on. |
| `JMAP_SEND`                       | no                  | `true` or `false` (default `false`)                                                                                                                                                                                 |
| `JMAP_ALLOWED_RECIPIENTS`         | if `JMAP_SEND=true` | Comma-separated exact addresses or `@domain` patterns, or a lone `*` for any recipient (a warning is logged at start). `*` cannot be mixed with other entries.                                                      |
| `JMAP_SEND_LIMIT_PER_HOUR`        | no                  | Default `10`. A whole number from 1 to 100000, or `unlimited` (a warning is logged at start, no state file is used).                                                                                                |
| `JMAP_DRAFTS`                     | no                  | `create_draft`. Default `false`                                                                                                                                                                                     |
| `JMAP_ORGANIZE`                   | no                  | `mark_emails`, `move_emails`. Default `false`                                                                                                                                                                       |
| `JMAP_ATTACHMENTS`                | no                  | `get_attachment`. Default `false`                                                                                                                                                                                   |
| `JMAP_STATE_DIR`                  | no                  | Absolute path for the rate-limit file. Default `$XDG_STATE_HOME/jmap-mcp` (or `~/.local/state/jmap-mcp`)                                                                                                            |
| `JMAP_ALLOW_INSECURE_LOCALHOST`   | no                  | `true` allows `http` for `localhost`, `127.0.0.1`, `[::1]` only. Default `false`                                                                                                                                    |

Booleans are exactly `true` or `false`. `True`, `1`, `yes` and a trailing space are startup errors.

If the server has no `urn:ietf:params:jmap:submission` capability, sending is not offered even with `JMAP_SEND=true` (a warning goes to stderr, reading still works).
If the session cannot be reached at start, the server still starts. The first call reports the problem and later calls retry.

## Tools

| Tool                                                                            | Switch                   | Notes                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `account_info`                                                                  | always                   | name, user, enabled capabilities, number of allowlist patterns, identities. No credentials. |
| `list_mailboxes`, `search_emails`, `get_email`, `get_thread`, `list_identities` | `JMAP_READ` (default on) | read only, paged (`limit`, `position`, `offset`)                                            |
| `create_draft`                                                                  | `JMAP_DRAFTS`            | saves to Drafts, sends nothing                                                              |
| `send_email`, `reply_email`, `send_draft`                                       | `JMAP_SEND`              | allowlist, rate limit, audit                                                                |
| `mark_emails`, `move_emails`                                                    | `JMAP_ORGANIZE`          | max 50 ids, no move to Trash                                                                |
| `get_attachment`                                                                | `JMAP_ATTACHMENTS`       | text up to 100 KB, images (png, jpeg, gif, webp) up to 500 KB                               |

A tool is only registered when its switch is on, and every call checks the switch again. All tools carry `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`.

Sending creates a draft (`$draft`, Drafts mailbox) with `Email/set`, then `EmailSubmission/set` with an explicit envelope equal to the checked recipients. `onSuccessUpdateEmail` removes `$draft` and moves the mail to Sent.

## OpenCode

Checked against the config schema of OpenCode 2.2.7 (`opencode debug config` loads the example without errors). Servers live under `mcp.servers.<name>`, rules in the `permissions` array.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "mail-shadehost-eu": {
        "type": "local",
        "command": ["bunx", "@timootten/jmap-mcp@0.1.0"],
        "cwd": "~",
        "environment": {
          "JMAP_SESSION_URL": "https://stalwart.example.eu/jmap/session",
          "JMAP_API_ORIGIN": "https://stalwart.example.eu",
          "JMAP_USERNAME": "timo@example.eu",
          "JMAP_PASSWORD": "{env:STALWART_PW_SHADEHOST_EU}"
        }
      },
      "mail-timootten-com": {
        "type": "local",
        "command": ["bunx", "@timootten/jmap-mcp@0.1.0"],
        "cwd": "~",
        "environment": {
          "JMAP_SESSION_URL": "https://stalwart.example.eu/jmap/session",
          "JMAP_API_ORIGIN": "https://stalwart.example.eu",
          "JMAP_USERNAME": "hi@example.com",
          "JMAP_PASSWORD": "{env:STALWART_PW_TIMOOTTEN_COM}",
          "JMAP_SEND": "true",
          "JMAP_ALLOWED_RECIPIENTS": "friend@example.net,@example.org"
        }
      }
    }
  },
  "permissions": [
    { "action": "mail-timootten-com_send_email", "resource": "*", "effect": "ask" },
    { "action": "mail-timootten-com_reply_email", "resource": "*", "effect": "ask" },
    { "action": "mail-timootten-com_send_draft", "resource": "*", "effect": "ask" },
    { "action": "edit", "resource": "~/.config/opencode/opencode.jsonc", "effect": "deny" }
  ]
}
```

Tool names are `<server>_<tool>`. The `ask` rules make OpenCode ask before every send. The `deny` rule is meant to stop the agent from editing the file that holds the allowlist.

Limits of this setup:

- The `edit` rule only covers OpenCode's own edit tools. A shell tool can still change the file unless you also restrict `shell`. Better: make the file read-only for the user that runs the agent, or manage it from outside the agent's reach.
- Whether the `ask` and `deny` rules take effect on MCP tools and files in your setup was not tested (OpenCode has no offline way to evaluate permissions, and a real test would need a send). Test it once with a harmless call before relying on it.
- If the config is rendered from a repo (for example by an entrypoint script that copies it on every start), edits inside the container do not persist anyway.

## Stalwart rights

An app password that may send needs: `authenticate`, the `jmapMailbox*` and `jmapEmail*` read rights, `emailSend`, `jmapEmailCreate`, `jmapEmailUpdate`, `jmapBlobUpload`, and `jmapEmailSubmission{Get,Changes,Query,Create}`.
Without `jmapEmailDestroy` the server cannot delete anything for good. This is intended.
Read-only accounts need only the read rights. `JMAP_ORGANIZE` needs `jmapEmailUpdate`, `JMAP_DRAFTS` needs `jmapEmailCreate`.

## Development

```sh
bun install --frozen-lockfile
bun run check   # tsc + biome
bun test
```

Optional read-only live test (skipped unless `JMAP_LIVE_TEST=1`):

```sh
JMAP_LIVE_TEST=1 JMAP_LIVE_SESSION_URL=... JMAP_LIVE_USERNAME=... JMAP_LIVE_PASSWORD=... \
  [JMAP_LIVE_API_ORIGIN=...] bun test test/live.test.ts
```

Layout: `config.ts` (env), `address.ts` (parsing, allowlist), `sanitize.ts` and `fence.ts` (untrusted content), `jmap.ts` (HTTP and session), `mail.ts` (read and update calls), `send.ts` (drafts and submission), `ratelimit.ts`, `log.ts`, `server.ts` (tools), `index.ts` (start).

## License

MIT
