import { Router } from "express";
import { requireAuth, requireAdmin } from "../lib/adminMiddleware";
import { roomManager } from "../eqso/room-manager";
import { relayTelemetryStore } from "../eqso/relay-telemetry-store";
import { logger } from "../lib/logger";

const router = Router();
router.use(requireAuth);

function getTelemetryPayload(callsign: string | null | undefined) {
  if (!callsign) return null;
  const t = relayTelemetryStore.get(callsign);
  if (!t) return null;
  return {
    rmsLevel: t.rmsLevel,
    voxActive: t.voxActive,
    txPackets: t.txPackets,
    rxPackets: t.rxPackets,
    pttState: t.pttState,
    uptimeSeconds: t.uptimeSeconds,
    receivedAt: t.receivedAt,
    stale: relayTelemetryStore.isStale(callsign),
    voxThresholdRms: t.voxThresholdRms,
  };
}

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
      telemetry: getTelemetryPayload(relayCallsign),
    });
    return;
  }

  const roomLock = relayClient.room ? roomManager.isLockedBy(relayClient.room, relayClient.id) : false;

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
    telemetry: getTelemetryPayload(relayClient.name),
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

  const lockedById = roomManager.isLockedBy(relayClient.room, relayClient.id);
  const allRoomClients = roomManager.getAllClients().filter(c => c.room === relayClient.room);
  const activeTxClient = allRoomClients.find(c => roomManager.isLockedBy(relayClient.room!, c.id));
  const memberCount = roomManager.getRoomMembers(relayClient.room).length;

  res.json({
    room: relayClient.room,
    memberCount,
    pttActive: !!activeTxClient,
    relayIsTx: lockedById,
  });
});

// POST /api/relay-operator/command — send command to the relay daemon
router.post("/command", (req, res) => {
  const session = req.session!;
  if (session.role !== "relay_operator" && session.role !== "admin") {
    res.status(403).json({ error: "Acceso restringido a operadores de radioenlace" });
    return;
  }

  const { command, callsign: bodyCallsign } = req.body as { command: string; callsign?: string };

  const targetCallsign =
    session.role === "admin" && bodyCallsign
      ? bodyCallsign
      : session.relayCallsign;

  if (!targetCallsign) {
    res.status(400).json({ error: "Sin indicativo de relay asignado" });
    return;
  }

  const cmdByte =
    command === "reconnect" ? 0x01 :
    command === "mute_rx"   ? 0x02 :
    command === "test_ptt"  ? 0x03 :
    command === "unmute_rx" ? 0x04 :
    null;

  if (cmdByte === null) {
    res.status(400).json({ error: `Comando desconocido: ${command}` });
    return;
  }

  const allClients = roomManager.getAllClients();
  const relay = allClients.find(c => c.name.toUpperCase() === targetCallsign.toUpperCase());

  if (!relay) {
    res.status(404).json({ error: "Relay no conectado al servidor" });
    return;
  }

  relay.send(Buffer.from([0x1f, cmdByte]));
  logger.info({ command, callsign: targetCallsign, role: session.role }, "Relay command sent");
  res.json({ ok: true, command, callsign: targetCallsign });
});

// GET /api/relay-operator/all-daemons — admin: all connected relay daemons with telemetry
router.get("/all-daemons", requireAdmin, (req, res) => {
  const allClients = roomManager.getAllClients();
  const relayClients = allClients.filter(c => c.name.startsWith("0R-") || c.isRelay);

  const result = relayClients.map(c => {
    const t = relayTelemetryStore.get(c.name);
    return {
      callsign: c.name,
      room: c.room,
      connectedAt: c.connectedAt,
      uptimeMs: Date.now() - c.connectedAt,
      txBytes: c.txBytes,
      rxBytes: c.rxBytes,
      telemetry: t
        ? {
            rmsLevel: t.rmsLevel,
            voxActive: t.voxActive,
            txPackets: t.txPackets,
            rxPackets: t.rxPackets,
            pttState: t.pttState,
            uptimeSeconds: t.uptimeSeconds,
            receivedAt: t.receivedAt,
            stale: relayTelemetryStore.isStale(c.name),
            voxThresholdRms: t.voxThresholdRms,
          }
        : null,
    };
  });

  res.json(result);
});

export { router as relayOperatorRouter };
