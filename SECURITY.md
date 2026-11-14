# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
<https://github.com/timootten/jmap-mcp/security/advisories/new>

Do not open a public issue for security problems. Expect a first answer within a few days.

## Scope

In scope: bypassing the recipient allowlist, the rate limit or the sender check; credentials leaving the
allowed origins or appearing in logs, errors or tool results; content from a mail escaping its
`[UNTRUSTED_<nonce>]` fence or surviving the sanitizer; unbounded time or memory use on hostile input.

Out of scope: a model doing something harmful that the environment variables allow (see the threat model
in the README), and problems in the MCP client, in Stalwart or in other JMAP servers.

## Supported versions

Only the latest release receives fixes.
