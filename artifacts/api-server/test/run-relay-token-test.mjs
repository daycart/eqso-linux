// Opt-in integration test against the development database only.
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required for relay token integration test");
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
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", output], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) process.exitCode = code;
} finally {
  await rm(directory, { force: true, recursive: true });
}