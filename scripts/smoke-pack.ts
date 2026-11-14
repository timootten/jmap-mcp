// Packs the package, installs the tarball into an empty project and starts the real bin over stdio.
// This is what users get from the registry, so it catches missing files in "files".
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string };
const work = mkdtempSync(join(tmpdir(), "jmap-mcp-smoke-"));

function run(cmd: string[], cwd: string) {
  const r = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr.toString()}`);
  return r.stdout.toString();
}

try {
  run(["bun", "pm", "pack", "--destination", work], root);
  const tarball = join(work, `timootten-jmap-mcp-${pkg.version}.tgz`);
  const proj = join(work, "project");
  run(["mkdir", proj], work);
  writeFileSync(join(proj, "package.json"), '{"name":"smoke","private":true}');
  run(["bun", "add", tarball], proj);

  const child = Bun.spawn({
    cmd: ["bunx", "jmap-mcp"],
    cwd: proj,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? work,
      JMAP_SESSION_URL: "https://127.0.0.1:9/jmap/session",
      JMAP_USERNAME: "smoke@example.org",
      JMAP_PASSWORD: "app xxxxxxxx",
      JMAP_STATE_DIR: join(work, "state"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  child.stdin.flush();

  const seen: Record<number, any> = {};
  const deadline = Date.now() + 20_000;
  let buf = "";
  const reader = child.stdout.getReader();
  while (Date.now() < deadline && !(seen[1] && seen[2])) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (typeof msg.id === "number") seen[msg.id] = msg.result;
    }
  }
  child.kill();

  const version = seen[1]?.serverInfo?.version;
  if (version !== pkg.version)
    throw new Error(`server reports ${version}, package is ${pkg.version}`);
  const tools = (seen[2]?.tools ?? []).map((t: { name: string }) => t.name).sort();
  const expected = [
    "account_info",
    "get_email",
    "get_thread",
    "list_identities",
    "list_mailboxes",
    "search_emails",
  ];
  if (JSON.stringify(tools) !== JSON.stringify(expected))
    throw new Error(`unexpected tools: ${tools}`);
  process.stdout.write(`smoke ok: ${pkg.version}, ${tools.length} tools\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
