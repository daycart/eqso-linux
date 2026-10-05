import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

// Optional historical TCP source, without checking out or changing the app.
const revision = process.argv[2];
if (revision && !/^[0-9a-f]{7,40}$/i.test(revision)) {
  throw new Error("Expected an optional Git commit hash, not a branch or command.");
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
const historicalSource = revision
  ? execFileSync("git", [
      "show", `${revision}:artifacts/api-server/src/eqso/tcp-server.ts`,
    ], { cwd: root, encoding: "utf8" })
  : undefined;
const testDir = fileURLToPath(new URL("../test/", import.meta.url));
const tempDir = await mkdtemp(join(testDir, ".tmp-ack-probe-"));
globalThis.require = createRequire(import.meta.url);

try {
  await build({
    entryPoints: [join(testDir, "v113-ack-keepalive.probe.ts")],
    outdir: tempDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["ffmpeg-static", "*.node"],
    plugins: [
      ...(historicalSource === undefined ? [] : [{
        name: "historical-tcp-source",
        setup(builder) {
          builder.onLoad({ filter: /\/src\/eqso\/tcp-server\.ts$/ }, (args) => ({
            contents: historicalSource,
            loader: "ts",
            resolveDir: dirname(args.path),
          }));
        },
      }]),
      esbuildPluginPino({ transports: ["pino-pretty"] }),
    ],
    banner: {
      js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
    },
  });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(tempDir, "v113-ack-keepalive.probe.mjs"),
    ], {
      stdio: "inherit",
      env: {
        ...process.env,
        EQSO_V113_VOX_TRIAL: "1",
        EQSO_ACK_PROBE_REVISION: revision ?? "workspace",
        EQSO_ACK_PROBE_EXPECT_INTACT: revision ? "0" : "1",
      },
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 75_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`Probe terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
