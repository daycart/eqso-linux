import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}

for (const filename of ["package-lock.json", "yarn.lock"]) {
  const filePath = join(process.cwd(), filename);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}