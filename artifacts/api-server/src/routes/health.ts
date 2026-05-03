import { Router, type IRouter } from "express";
import { createReadStream } from "fs";
import { resolve } from "path";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/dl-daemon", (_req, res) => {
  const file = resolve(process.cwd(), "../relay-daemon/dist/main.mjs");
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Content-Disposition", "attachment; filename=main.mjs");
  createReadStream(file).pipe(res);
});

export default router;
