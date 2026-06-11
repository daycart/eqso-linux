import { Router } from "express";
import { requireAuth } from "../lib/adminMiddleware";
import { roomManager } from "../eqso/room-manager";
import { logger } from "../lib/logger";

const router = Router();
router.use(requireAuth);

// GET /api/relay-operator/status — live status of the relay linked to this operator
router.get("/status", (req, res) => {
  const session = req.session!;
  if (session.role !== "relay_operator" && session.role !== "admin") {
    res.status(403).json({ error: "Acceso restringido a operadores de radioenlace" });
    return;
  }

  const relayCallsign = session.relayCallsign;
  if (!relayCallsign && session.role === "relay_operator") {
    res.json({ online: false, reason: "Sin indicativo de relay asignado" });
    return;
  }

  const allClients = roomManager.getAllClients();
  const relayClient = relayCallsign
    ? allClients.find(c => c.name.toUpperCase() === relayCallsign.toUpperCase())
    : null;

  if (!relayClient) {
    res.json({
      online: false,
      callsign: relayCallsign ?? null,
      reason: "Relay no conectado al servidor",
    });
    return;
  }

  const roomLock = relayClient.room ? roomManager.isLockedBy(relayClient.room, relayClient.id) : false;
  const roomMembers = relayClient.room
    ? roomManager.getRoomMembers(relayClient.room).map(m => ({
        name: m.name,
        protocol: m.protocol,
        isRelay: m.isRelay ?? false,
      }))
    : [];

  res.json({
    online: true,
    callsign: relayClient.name,
    room: relayClient.room || null,
    protocol: relayClient.protocol,
    connectedAt: relayClient.connectedAt,
    uptimeMs: Date.now() - relayClient.connectedAt,
    txBytes: relayClient.txBytes,
    rxBytes: relayClient.rxBytes,
    pttActive: roomLock,
    roomMembers,
  });
});

// GET /api/relay-operator/room — room status for the relay's room
router.get("/room", (req, res) => {
  const session = req.session!;
  if (session.role !== "relay_operator" && session.role !== "admin") {
    res.status(403).json({ error: "Acceso restringido a operadores de radioenlace" });
    return;
  }

  const relayCallsign = session.relayCallsign;
  if (!relayCallsign) {
    res.json({ room: null, members: [] });
    return;
  }

  const allClients = roomManager.getAllClients();
  const relayClient = allClients.find(c => c.name.toUpperCase() === relayCallsign.toUpperCase());
  if (!relayClient?.room) {
    res.json({ room: null, members: [] });
    return;
  }

  const members = roomManager.getRoomMembers(relayClient.room).map(m => ({
    name: m.name,
    protocol: m.protocol,
    isRelay: m.isRelay ?? false,
    connectedAt: m.connectedAt,
  }));

  const lockedById = roomManager.isLockedBy(relayClient.room, relayClient.id);
  const allRoomClients = roomManager.getAllClients().filter(c => c.room === relayClient.room);
  const activeTxClient = allRoomClients.find(c => roomManager.isLockedBy(relayClient.room!, c.id));

  res.json({
    room: relayClient.room,
    members,
    pttActive: !!activeTxClient,
    activeSpeaker: activeTxClient?.name ?? null,
    relayIsTx: lockedById,
  });
});

export { router as relayOperatorRouter };
