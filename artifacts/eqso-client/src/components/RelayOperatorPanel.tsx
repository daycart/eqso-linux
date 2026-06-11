import { useState, useEffect, useCallback } from "react";
import { getApiBase } from "./LoginPanel";

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

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
  return { Authorization: `Bearer ${token}` };
}

export function RelayOperatorPanel({ token, relayCallsign, onClose }: RelayOperatorPanelProps) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [room, setRoom] = useState<RoomStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const poll = useCallback(async () => {
    try {
      const [sRes, rRes] = await Promise.all([
        fetch(`${getApiBase()}/api/relay-operator/status`, { headers: authHdr(token) }),
        fetch(`${getApiBase()}/api/relay-operator/room`, { headers: authHdr(token) }),
      ]);
      if (sRes.ok) setStatus(await sRes.json());
      if (rRes.ok) setRoom(await rRes.json());
      setError(null);
      setLastUpdate(new Date());
    } catch {
      setError("Error de conexion con el servidor");
    }
  }, [token]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [poll]);

  const connected = status?.online === true;

  return (
    <div className="flex flex-col flex-1 bg-gray-950 overflow-hidden">
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
              Actualizado: {lastUpdate.toLocaleTimeString("es-ES")}
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

        {/* Estado del relay */}
        <div className={`rounded-xl border p-5 ${
          connected
            ? "border-green-800 bg-green-950/20"
            : "border-gray-800 bg-gray-900"
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className={`inline-block w-3 h-3 rounded-full ${
                  connected ? "bg-green-500 animate-pulse" : "bg-red-600"
                }`} />
                <span className="text-sm font-semibold text-gray-100">
                  {connected ? "Relay en línea" : "Relay desconectado"}
                </span>
              </div>
              {status?.reason && !connected && (
                <p className="text-xs text-gray-500 mt-1 ml-5">{status.reason}</p>
              )}
            </div>
            {connected && status?.pttActive && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-red-300 bg-red-950 border border-red-800 rounded-lg px-2.5 py-1">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                TX ACTIVO
              </span>
            )}
          </div>

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
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">TX (al servidor)</p>
                <p className="text-sm font-mono text-green-400">
                  {status?.txBytes != null ? fmtBytes(status.txBytes) : "—"}
                </p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">RX (del servidor)</p>
                <p className="text-sm font-mono text-blue-400">
                  {status?.rxBytes != null ? fmtBytes(status.rxBytes) : "—"}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Sala actual */}
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

        {/* Hint when offline */}
        {!connected && relayCallsign && (
          <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-5 text-center">
            <p className="text-sm text-gray-500">El relay <span className="font-mono text-gray-400">{relayCallsign}</span> no está conectado al servidor.</p>
            <p className="text-xs text-gray-600 mt-1">Comprueba que el servicio eqso-relay está activo en el equipo físico.</p>
          </div>
        )}
      </div>
    </div>
  );
}
