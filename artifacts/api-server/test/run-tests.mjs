import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const testDir = dirname(fileURLToPath(import.meta.url));
const tempDir = await mkdtemp(join(testDir, ".tmp-"));
const outputFile = join(tempDir, "tcp-server-legacy-ptt.test.mjs");
const schedulerOutputFile = join(tempDir, "bulletin-scheduler.test.mjs");
const wsOutputFile = join(tempDir, "ws-ptt-guard.test.mjs");
globalThis.require = createRequire(import.meta.url);

try {
  await build({
    entryPoints: [
      new URL("./tcp-server-legacy-ptt.test.ts", import.meta.url).pathname,
      new URL("./bulletin-scheduler.test.ts", import.meta.url).pathname,
    ],
    outdir: tempDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["ffmpeg-static", "*.node"],
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
    },
    sourcemap: "inline",
  });

  // Only this suite replaces external effects; legacy TCP/codec tests above
  // continue to bundle their real implementations.
  await build({
    entryPoints: [join(testDir, "ws-ptt-guard.test.ts")],
    outdir: tempDir,
    outExtension: { ".js": ".mjs" },
    bundle: true, platform: "node", format: "esm",
    external: ["ffmpeg-static", "*.node"],
    plugins: [
      {
        name: "isolated-ws-audio",
        setup(build) {
          build.onResolve({
            filter: /(?:ffmpeg-gsm|eqso-proxy|inactivity-manager|moderation-manager|lib\/auth|lib\/relay-tokens)$/,
          }, () => ({ path: join(testDir, "support/ws-audio-stubs.ts") }));
        },
      },
      esbuildPluginPino({ transports: ["pino-pretty"] }),
    ],
    banner: { js: `import { createRequire } from "node:module"; globalThis.require = createRequire(import.meta.url);` },
    sourcemap: "inline",
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--enable-source-maps", "--test", ...process.argv.slice(2), outputFile, schedulerOutputFile, wsOutputFile],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Test process terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
