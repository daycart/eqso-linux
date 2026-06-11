import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { validateSession } from "../lib/auth";
import { relayTelemetryStore, type RelayTelemetryChange } from "./relay-telemetry-store";
import { logger } from "../lib/logger";

export function startRelayWsNotifier(httpServer: http.Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws-relay" });

  wss.on("connection", (ws, req) => {
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4401, "token required");
      return;
    }

    const session = validateSession(token);
    if (!session || (session.role !== "relay_operator" && session.role !== "admin")) {
      ws.close(4403, "forbidden");
      return;
    }

    const targetCallsign = (session.relayCallsign ?? "").toUpperCase();
    const isAdmin = session.role === "admin";

    function matches(callsign: string): boolean {
      return isAdmin || callsign === targetCallsign;
    }

    function send(msg: object): void {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
      }
    }

    function buildTelemetryMsg(callsign: string, data: RelayTelemetryChange["data"]) {
      if (!data) return null;
      return {
        type: "telemetry" as const,
        callsign,
        data: {
          rmsLevel: data.rmsLevel,
          voxActive: data.voxActive,
          txPackets: data.txPackets,
          rxPackets: data.rxPackets,
          pttState: data.pttState,
          uptimeSeconds: data.uptimeSeconds,
          voxThresholdRms: data.voxThresholdRms,
          receivedAt: data.receivedAt,
          stale: false,
        },
      };
    }

    const onTelemetryChange = (event: RelayTelemetryChange) => {
      if (!matches(event.callsign)) return;
      if (event.type === "update") {
        const msg = buildTelemetryMsg(event.callsign, event.data);
        if (msg) send(msg);
      } else {
        send({ type: "offline", callsign: event.callsign });
      }
    };

    relayTelemetryStore.on("change", onTelemetryChange);

    ws.on("close", () => {
      relayTelemetryStore.off("change", onTelemetryChange);
    });
    ws.on("error", () => {
      relayTelemetryStore.off("change", onTelemetryChange);
    });

    // Send initial snapshot
    if (!isAdmin && targetCallsign) {
      const t = relayTelemetryStore.get(targetCallsign);
      if (t) {
        const msg = buildTelemetryMsg(targetCallsign, t);
        if (msg) send({ ...msg, data: { ...msg.data, stale: relayTelemetryStore.isStale(targetCallsign) } });
      }
    }

    logger.info({ callsign: targetCallsign || "admin", role: session.role }, "Relay WS subscriber connected");
  });

  logger.info("Relay WS notifier ready on /ws-relay");
}
