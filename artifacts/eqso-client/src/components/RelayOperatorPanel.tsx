import { useState, useEffect, useCallback } from "react";
import { getApiBase } from "./LoginPanel";

interface TelemetryData {
  rmsLevel: number;
  voxActive: boolean;
  txPackets: number;
  rxPackets: number;
  receivedAt: number;
  stale: boolean;
}

interface RelayStatus {
  online: boolean;
  callsign?: string | null;
  room?: string | null;
  protocol?: string;
  connectedAt?: number;
  uptimeMs?: number;
  txBytes?: number;
  rxBytes?: number;
  pttActive?: boolean;
  roomMembers?: { name: string; protocol: string; isRelay: boolean }[];
  reason?: string;
  telemetry?: TelemetryData | null;
}

interface RoomStatus {
  room: string | null;
  members: { name: string; protocol: string; isRelay: boolean; connectedAt: number }[];
  pttActive: boolean;
  activeSpeaker: string | null;
  relayIsTx: boolean;
}

interface RelayOperatorPanelProps {
  token: string;
  relayCallsign: string | null | undefined;
  onClose: () => void;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function authHdr(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const RMS_MAX = 3500; // umbral visual: RMS a partir del cual la barra llega al 100%

const COMMANDS = [
  { id: "test_ptt",  label: "Probar PTT",    color: "bg-orange-700 hover:bg-orange-600" },
  { id: "mute_rx",   label: "Silenciar RX",  color: "bg-yellow-700 hover:bg-yellow-600" },
  { id: "unmute_rx", label: "Activar RX",    color: "bg-blue-700 hover:bg-blue-600" },
  { id: "reconnect", label: "Reconectar",    color: "bg-red-800 hover:bg-red-700" },
] as const;

export function RelayOperatorPanel({ token, relayCallsign, onClose }: RelayOperatorPanelProps) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [room, setRoom] = useState<RoomStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [cmdLoading, setCmdLoading] = useState<string | null>(null);
  const [cmdResult, setCmdResult] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const [sRes, rRes] = await Promise.all([
        fetch(`${getApiBase()}/api/relay-operator/status`, { headers: authHdr(token) }),
        fetch(`${getApiBase()}/api/relay-operator/room`,   { headers: authHdr(token) }),
      ]);
      if (sRes.ok) setStatus(await sRes.json());
      if (rRes.ok) setRoom(await rRes.json());
      setError(null);
      setLastUpdate(new Date());
    } catch {
      setError("Error de conexión con el servidor");
    }
  }, [token]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [poll]);

  async function sendCommand(command: string) {
    setCmdLoading(command);
    setCmdResult(null);
    try {
      const res = await fetch(`${getApiBase()}/api/relay-operator/command`, {
        method: "POST",
        headers: authHdr(token),
        body: JSON.stringify({ command }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (res.ok) {
        setCmdResult(`✓ Comando "${command}" enviado`);
        setTimeout(() => setCmdResult(null), 4000);
        if (command !== "reconnect") await poll();
      } else {
        setCmdResult(`Error: ${data.error ?? "desconocido"}`);
      }
    } catch {
      setCmdResult("Error de conexión");
    } finally {
      setCmdLoading(null);
    }
  }

  const connected = status?.online === true;
  const telemetry = status?.telemetry;
  const hasLiveTelemetry = !!telemetry && !telemetry.stale;
  const rmsBarPct = Math.min(100, ((telemetry?.rmsLevel ?? 0) / RMS_MAX) * 100);

  return (
    <div className="flex flex-col flex-1 bg-gray-950 overflow-hidden">
      {/* Cabecera */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Panel de Operador</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Telemetría en vivo de tu radioenlace
            {relayCallsign && (
              <span className="ml-2 font-mono text-orange-400">{relayCallsign}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdate && (
            <span className="text-[10px] text-gray-600">
              {lastUpdate.toLocaleTimeString("es-ES")}
            </span>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 text-sm px-3 py-2 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Volver
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-2xl">
        {error && (
          <p className="text-xs bg-red-950 border border-red-800 text-red-300 rounded-lg px-3 py-2">{error}</p>
        )}

        {!relayCallsign && (
          <div className="bg-yellow-950 border border-yellow-800 rounded-xl p-5">
            <p className="text-sm text-yellow-300 font-medium">Sin relay asignado</p>
            <p className="text-xs text-yellow-600 mt-1">El administrador debe asignarte un indicativo de radioenlace.</p>
          </div>
        )}

        {/* ── Estado de conexión ── */}
        <div className={`rounded-xl border p-5 ${
          connected ? "border-green-800 bg-green-950/20" : "border-gray-800 bg-gray-900"
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-3 h-3 rounded-full ${
                connected ? "bg-green-500 animate-pulse" : "bg-red-600"
              }`} />
              <span className="text-sm font-semibold text-gray-100">
                {connected ? "Relay en línea" : "Relay desconectado"}
              </span>
            </div>
            {connected && status?.pttActive && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-red-300 bg-red-950 border border-red-800 rounded-lg px-2.5 py-1">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                TX ACTIVO
              </span>
            )}
          </div>
          {status?.reason && !connected && (
            <p className="text-xs text-gray-500 mt-2 ml-5">{status.reason}</p>
          )}

          {connected && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Sala</p>
                <p className="text-sm font-mono text-gray-100">{status?.room ?? "—"}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Tiempo en línea</p>
                <p className="text-sm font-mono text-gray-100">
                  {status?.uptimeMs != null ? fmtUptime(status.uptimeMs) : "—"}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── Telemetría en vivo ── */}
        {connected && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-200">Telemetría</h3>
              {hasLiveTelemetry ? (
                <span className="text-[10px] text-gray-500">
                  Actualizado: {new Date(telemetry!.receivedAt).toLocaleTimeString("es-ES")}
                </span>
              ) : (
                <span className="text-[10px] text-yellow-600 bg-yellow-950 border border-yellow-800 rounded px-2 py-0.5">
                  Sin datos (&gt;15 s)
                </span>
              )}
            </div>

            {/* Barra RMS + VOX */}
            <div className="mb-4">
              <div className="flex justify-between items-center text-xs mb-1.5">
                <span className="text-gray-500">Nivel audio (RMS)</span>
                <div className="flex items-center gap-2">
                  {telemetry?.voxActive && (
                    <span className="text-[10px] font-semibold text-red-400 bg-red-950 border border-red-800 rounded px-1.5 py-0.5 animate-pulse">
                      VOX ACTIVO
                    </span>
                  )}
                  <span className={`font-mono ${hasLiveTelemetry ? "text-gray-300" : "text-gray-600"}`}>
                    {hasLiveTelemetry ? telemetry!.rmsLevel : "—"}
                  </span>
                </div>
              </div>
              <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    !hasLiveTelemetry ? "bg-gray-700 w-0" :
                    telemetry!.voxActive ? "bg-red-500" :
                    rmsBarPct > 60 ? "bg-yellow-500" : "bg-blue-600"
                  }`}
                  style={{ width: `${hasLiveTelemetry ? rmsBarPct : 0}%` }}
                />
              </div>
            </div>

            {/* Paquetes TX / RX */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Paquetes TX</p>
                <p className={`text-sm font-mono ${hasLiveTelemetry ? "text-green-400" : "text-gray-600"}`}>
                  {hasLiveTelemetry ? (telemetry!.txPackets).toLocaleString("es-ES") : "—"}
                </p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Paquetes RX</p>
                <p className={`text-sm font-mono ${hasLiveTelemetry ? "text-blue-400" : "text-gray-600"}`}>
                  {hasLiveTelemetry ? (telemetry!.rxPackets).toLocaleString("es-ES") : "—"}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Sala actual ── */}
        {connected && room?.room && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-200">
                Sala: <span className="font-mono text-green-400">{room.room}</span>
              </h3>
              {room.pttActive && (
                <span className="flex items-center gap-1.5 text-xs text-orange-300">
                  <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
                  {room.relayIsTx ? "Tu relay transmite" : `Tx: ${room.activeSpeaker ?? "..."}`}
                </span>
              )}
            </div>
            {room.members.length === 0 ? (
              <p className="text-xs text-gray-600">Sin usuarios en sala</p>
            ) : (
              <div className="space-y-1.5">
                {room.members.map(m => (
                  <div key={m.name} className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      m.isRelay ? "bg-orange-400" : "bg-green-500"
                    }`} />
                    <span className="font-mono text-xs text-gray-300">{m.name}</span>
                    <span className="text-[10px] text-gray-600">
                      {m.isRelay ? "enlace" : m.protocol === "ws" ? "web" : "tcp"}
                    </span>
                    {room.activeSpeaker === m.name && (
                      <span className="ml-auto text-[10px] text-red-400 animate-pulse">TX</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Acciones ── */}
        {connected && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-200 mb-3">Acciones</h3>
            <div className="flex flex-wrap gap-2">
              {COMMANDS.map(cmd => (
                <button
                  key={cmd.id}
                  onClick={() => sendCommand(cmd.id)}
                  disabled={!!cmdLoading}
                  className={`${cmd.color} text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {cmdLoading === cmd.id ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 border border-white/50 border-t-white rounded-full animate-spin" />
                      {cmd.label}
                    </span>
                  ) : cmd.label}
                </button>
              ))}
            </div>
            {cmdResult && (
              <p className={`text-xs mt-2.5 ${cmdResult.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
                {cmdResult}
              </p>
            )}
          </div>
        )}

        {/* Hint cuando offline */}
        {!connected && relayCallsign && (
          <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-5 text-center">
            <p className="text-sm text-gray-500">
              El relay <span className="font-mono text-gray-400">{relayCallsign}</span> no está conectado al servidor.
            </p>
            <p className="text-xs text-gray-600 mt-1">
              Comprueba que el servicio eqso-relay está activo en el equipo físico.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
