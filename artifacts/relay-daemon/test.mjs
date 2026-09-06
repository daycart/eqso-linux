import { build } from "esbuild";
import { mkdtempSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import os from "os";
import path from "path";

const outdir = mkdtempSync(path.join(os.tmpdir(), "eqso-relay-test-"));
const testBundle = path.join(outdir, "vox.test.mjs");

try {
  await build({
    entryPoints: ["src/vox.test.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: testBundle,
    sourcemap: "inline",
  });

  const result = spawnSync(
    process.execPath,
    ["--test", testBundle],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}