import { build } from "esbuild";
import { rmSync } from "fs";
import { spawnSync } from "child_process";

const outdir = ".test-dist";

try {
  await build({
    entryPoints: ["src/vox.test.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: `${outdir}/vox.test.mjs`,
    sourcemap: "inline",
  });

  const result = spawnSync(
    process.execPath,
    ["--test", `${outdir}/vox.test.mjs`],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}