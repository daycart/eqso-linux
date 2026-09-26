import { Router } from "express";
import { requireAdmin } from "../lib/adminMiddleware";
import { createRelayToken, listRelayTokens, revokeRelayToken } from "../lib/relay-tokens";
import { disconnectManagedRelayToken } from "../eqso/tcp-server";
import { CreateRelayTokenBody, ListRelayTokensResponse, RevokeRelayTokenResponse } from "@workspace/api-zod";

export const relayTokensRouter = Router();
relayTokensRouter.use(requireAdmin);

relayTokensRouter.get("/relay-tokens", async (req, res): Promise<void> => {
  try {
    res.json(ListRelayTokensResponse.parse(await listRelayTokens()));
  } catch (err) {
    req.log.error({ err }, "Cannot list relay tokens");
    res.status(503).json({ error: "No se pudo consultar los tokens" });
  }
});

relayTokensRouter.post("/relay-tokens", async (req, res): Promise<void> => {
  const parsed = CreateRelayTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Indica un nombre y un indicativo 0R- válido (máx. 30 caracteres)" });
    return;
  }
  const callsign = parsed.data.callsign.trim().toUpperCase();
  const label = parsed.data.label.trim();
  if (!/^0R-[A-Z0-9-]{1,27}$/.test(callsign) || !label || label.length > 100) {
    res.status(400).json({ error: "Indica un nombre y un indicativo 0R- válido (máx. 30 caracteres)" });
    return;
  }
  try {
    const { row, token } = await createRelayToken(callsign, label);
    req.log.info({ id: row.id, callsign }, "Relay token created");
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      id: row.id, callsign, label, token, legacyDisabled: row.legacyDisabled,
      createdAt: row.createdAt, lastUsedAt: null, revokedAt: null,
    });
  } catch (err) {
    req.log.error({ err }, "Cannot create relay token");
    res.status(503).json({ error: "No se pudo crear el token" });
  }
});

relayTokensRouter.post("/relay-tokens/:id/revoke", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Identificador no válido" });
    return;
  }
  try {
    const row = await revokeRelayToken(id);
    if (!row) {
      res.status(404).json({ error: "Token no encontrado o ya revocado" });
      return;
    }
    disconnectManagedRelayToken(id);
    req.log.info({ id, callsign: row.callsign }, "Relay token revoked");
    res.json(RevokeRelayTokenResponse.parse({ ok: true }));
  } catch (err) {
    req.log.error({ err, id }, "Cannot revoke relay token");
    res.status(503).json({ error: "No se pudo revocar el token" });
  }
});