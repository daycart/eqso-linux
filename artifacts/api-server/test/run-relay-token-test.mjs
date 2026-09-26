// Opt-in integration test against the development database only.
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required for relay token integration test");
const testCredential = "eqso_test_token_do_not_log_7B22";
const directory = await mkdtemp(join(tmpdir(), "eqso-relay-token-test-"));
globalThis.require = createRequire(import.meta.url);
try {
  const output = join(directory, "relay-tokens.test.mjs");
  await build({
    entryPoints: [new URL("./relay-tokens.test.ts", import.meta.url).pathname],
    outdir: directory,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["*.node"],
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: { js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);` },
  });
  const { code, logs } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", output], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, EQSO_TEST_LOG_MARKER: testCredential },
    });
    let logs = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { logs += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { logs += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ code: exitCode ?? 1, logs }));
  });
  // Never print raw test logs: a regression could put a real credential in
  // them. Check both its text and hexadecimal representation.
  const leaked = logs.includes(testCredential) ||
    logs.toLowerCase().includes(Buffer.from(testCredential).toString("hex"));
  const expectedLogs = [
    "eQSO TCP JOIN parsed",
    "TCP relay rejected: invalid relay token",
    "eQSO proxy: server text message",
    "eQSO proxy: room list received",
    "eQSO proxy: user joined",
  ];
  const missingLog = expectedLogs.some((line) => !logs.includes(line));
  for (const line of logs.split(/\r?\n/)) {
    if (/^[✔✖ℹ] /.test(line)) process.stdout.write(`${line}\n`);
  }
  if (leaked) {
    process.stderr.write("Relay log safety test failed: credential appeared in log output (details withheld).\n");
    process.exitCode = 1;
  } else if (missingLog) {
    process.stderr.write("Relay log safety test failed: expected diagnostic events were not captured.\n");
    process.exitCode = 1;
  } else if (code !== 0) {
    process.stderr.write("Relay integration test failed (raw logs withheld to protect credentials).\n");
    process.exitCode = code;
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}