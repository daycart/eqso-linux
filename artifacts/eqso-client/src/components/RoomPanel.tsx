import { useEffect, useRef, useState } from "react";
import type { RoomMember } from "@/hooks/useEqsoClient";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Users } from "lucide-react";
import "./RoomPanel.css";

interface RoomPanelProps {
  currentRoom: string;
  currentName: string;
  members: RoomMember[];
  activeSpeaker: string | null;
  pttActive: boolean;
  pttGranted: boolean;
  channelBusy: boolean;
  isRecording: boolean;
  isMicAllowed: boolean | null;
  inputLevel: number;
  rooms: string[];
  selectedRoom: string;
  isRemote: boolean;
  onRoomChange: (room: string) => void;
  onPttStart: () => void;
  onPttEnd: () => void;
  onDisconnect: () => void;
}

export function RoomPanel({
  currentRoom,
  currentName,
  members,
  activeSpeaker,
  pttActive,
  pttGranted,
  channelBusy,
  isRecording,
  isMicAllowed,
  inputLevel,
  rooms,
  selectedRoom,
  isRemote,
  onRoomChange,
  onPttStart,
  onPttEnd,
  onDisconnect,
}: RoomPanelProps) {
  const [usersOpen, setUsersOpen] = useState(false);
  const roomNav = useRef<HTMLElement>(null);
  const pointerHeld = useRef(false);
  useEffect(() => {
    roomNav.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentRoom]);

  const seen = new Set<string>([currentName]);
  const allMembers: RoomMember[] = [
    { name: currentName, message: "Tú" },
    ...members.reduce<RoomMember[]>((acc, m) => {
      const n = m.name.trim();
      if (!n || n === currentName || seen.has(n)) return acc;
      seen.add(n);
      acc.push({ name: n, message: m.message });
      return acc;
    }, []),
  ];

  const currentIsRelay = currentName.startsWith("0R-");
  const radioLinks = allMembers.filter(
    (m) => m.name !== currentName && m.name.trim().startsWith("0R-")
  );
  // Incluir al propio usuario si es un radioenlace
  const totalRelayCount = radioLinks.length + (currentIsRelay ? 1 : 0);
  const hasRadioLinks = totalRelayCount > 0;

  return (
    <div className="eqso-room-panel flex min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 bg-gray-900/60 px-3 py-2 md:hidden">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Sala</span>
        <nav ref={roomNav} aria-label="Salas disponibles" className="eqso-room-scroll flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {rooms.map((room) => (
            <button key={room} type="button" aria-current={room === currentRoom ? "true" : undefined}
              onClick={() => { onPttEnd(); onRoomChange(room); }}
              className={`min-h-11 shrink-0 rounded-lg border px-3 text-xs font-semibold transition-colors ${room === currentRoom ? "border-green-700/70 bg-green-900/40 text-green-200" : "border-transparent text-gray-400 hover:bg-gray-800"}`}>
              <span className="mr-1 text-green-500">#</span>{room}
            </button>
          ))}
        </nav>
        <Dialog open={usersOpen} onOpenChange={(open) => { if (open) onPttEnd(); setUsersOpen(open); }}>
          <DialogTrigger asChild>
            <button type="button" aria-label={`Ver usuarios de ${currentRoom}, ${allMembers.length} en sala`}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 text-xs text-gray-300">
              <Users className="h-4 w-4" aria-hidden="true" />{allMembers.length}
            </button>
          </DialogTrigger>
          <DialogContent className="eqso-mobile-users gap-0 border-gray-700 bg-gray-900 p-0 text-gray-100">
            <div className="border-b border-gray-800 p-4 pr-14">
              <DialogTitle className="text-base">Usuarios en #{currentRoom} ({allMembers.length})</DialogTitle>
              <DialogDescription className="mt-2 text-xs text-gray-400">Participantes conectados a esta sala.</DialogDescription>
            </div>
            <div className="max-h-[55dvh] overflow-y-auto p-2">
              {allMembers.map((member) => {
                const self = member.name === currentName;
                const relay = member.name.startsWith("0R-");
                const speaking = self ? pttActive && pttGranted : activeSpeaker === member.name;
                return (
                  <div key={member.name} className={`flex items-center gap-3 rounded-xl p-3 ${speaking ? "bg-amber-950/40" : ""}`}>
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${self ? "bg-green-800 text-green-100" : relay ? "bg-blue-900 text-blue-100" : "bg-gray-700 text-gray-200"}`}>
                      {member.name.replace(/^0R-/, "").slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`break-all font-mono text-sm ${self ? "text-green-200" : relay ? "text-blue-200" : "text-gray-100"}`}>
                        {member.name}{self && <span className="ml-1 font-sans text-xs text-gray-400">(tú)</span>}
                      </p>
                      <p className="mt-0.5 break-words text-xs text-gray-400">{relay ? "Nodo radioenlace" : self ? "Conectado a la sala" : member.message}</p>
                    </div>
                    {speaking && <span className="text-xs text-amber-200">TX</span>}
                  </div>
                );
              })}
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <aside className="hidden w-64 shrink-0 border-r border-gray-800 bg-gray-900 md:flex md:flex-col">
        <div className="px-4 py-3 border-b border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Salas</p>
          <div className="space-y-0.5">
            {rooms.map((room) => {
              const isActive = room === currentRoom;
              return (
                <button
                  key={room}
                  onClick={() => onRoomChange(room)}
                  title={isActive ? `Sala activa: #${room}` : `Cambiar a sala #${room}`}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between gap-1 ${
                    isActive
                      ? "bg-green-900/50 text-green-300 font-medium"
                      : "text-gray-500 hover:bg-gray-800 hover:text-gray-300"
                  }`}
                >
                  <span># {room}</span>
                  {isActive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="px-4 py-3 flex-1 overflow-y-auto">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Usuarios en #{currentRoom} ({allMembers.length})
          </p>
          <div className="space-y-1">
            {allMembers.map((m) => {
              const isRadioLink = m.name.startsWith("0R-");
              const isSelf = m.name === currentName;
              const isSelfTx = isSelf && pttActive && pttGranted;
              const isSpeaking = activeSpeaker === m.name;
              const initials = m.name.replace(/^0R-/, "").slice(0, 2).toUpperCase();
              return (
                <div
                  key={m.name}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                    isSelfTx
                      ? "bg-red-900/30"
                      : isSpeaking
                      ? "bg-yellow-900/30"
                      : ""
                  }`}
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                    isSelfTx
                      ? "bg-red-700 text-red-100"
                      : isSelf && isRadioLink
                      ? "bg-green-700 text-green-100"
                      : isSelf
                      ? "bg-green-700 text-green-100"
                      : isSpeaking
                      ? "bg-yellow-700 text-yellow-100"
                      : isRadioLink
                      ? "bg-blue-800 text-blue-100"
                      : "bg-gray-700 text-gray-300"
                  }`}>
                    {isRadioLink ? (
                      <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                        <path d="M4.5 6.375a4.125 4.125 0 1 1 8.25 0 4.125 4.125 0 0 1-8.25 0ZM14.25 8.625a3.375 3.375 0 1 1 6.75 0 3.375 3.375 0 0 1-6.75 0ZM1.5 19.125a7.125 7.125 0 0 1 14.25 0v.003l-.001.119a.75.75 0 0 1-.363.63 13.067 13.067 0 0 1-6.761 1.873c-2.472 0-4.786-.684-6.76-1.873a.75.75 0 0 1-.364-.63l-.001-.122ZM17.25 19.128l-.001.144a2.25 2.25 0 0 1-.233.96 10.088 10.088 0 0 0 5.06-1.01.75.75 0 0 0 .42-.643 4.875 4.875 0 0 0-6.957-4.611 8.586 8.586 0 0 1 1.71 5.157v.003Z" />
                      </svg>
                    ) : (
                      initials
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className={`text-sm font-mono truncate ${
                      isSelfTx
                        ? "text-red-300"
                        : isSpeaking
                        ? "text-yellow-300"
                        : isSelf
                        ? "text-green-300"
                        : isRadioLink
                        ? "text-blue-300"
                        : "text-gray-200"
                    }`}>
                      {m.name}
                      {isSelf && (
                        <span className="text-gray-500 font-sans text-xs ml-1">(tú)</span>
                      )}
                    </p>
                    {isRadioLink && (
                      <p className={`text-xs ${isSelf ? "text-green-600" : "text-blue-500"}`}>Nodo radioenlace</p>
                    )}
                    {m.message && !isRadioLink && !isSelf && (
                      <p className="text-xs text-gray-500 truncate">{m.message}</p>
                    )}
                  </div>
                  {(isSpeaking || isSelfTx) && (
                    <div className="ml-auto flex-shrink-0 flex items-center gap-0.5">
                      {[120, 60, 180, 90, 150].map((dur, i) => (
                        <span
                          key={i}
                          className={`w-1 rounded-full ${isSelfTx ? "bg-red-400" : "bg-yellow-400"}`}
                          style={{
                            animation: `vuBar ${dur}ms ease-in-out ${i * 40}ms infinite alternate`,
                            minHeight: "4px",
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-gray-800">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-full bg-green-700 flex items-center justify-center text-xs font-bold text-green-100 flex-shrink-0">
              {currentName[0]}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-mono text-white truncate">{currentName}</p>
              <p className="text-xs text-green-400"># {currentRoom}</p>
            </div>
          </div>
          <button
            onClick={onDisconnect}
            className="w-full text-xs text-red-400 hover:text-red-300 py-1.5 border border-red-900/50 hover:border-red-700 rounded-lg transition-colors"
          >
            Desconectar
          </button>
        </div>
      </aside>

      <div className="eqso-room-main min-w-0 flex-1 flex flex-col bg-gray-950">
        <div className="hidden border-b border-gray-800 px-6 py-3 md:flex flex-wrap items-center gap-3">
          <span className="text-gray-400 text-lg">#</span>
          <span className="font-bold text-white">{currentRoom}</span>
          <span className="text-gray-600 text-sm">{allMembers.length} usuario{allMembers.length !== 1 ? "s" : ""}</span>
          <div className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border ${
            hasRadioLinks
              ? "bg-blue-900/30 border-blue-700/50 text-blue-300"
              : "bg-amber-900/30 border-amber-700/50 text-amber-300"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasRadioLinks ? "bg-blue-400" : "bg-amber-400 animate-pulse"}`} />
            {hasRadioLinks
              ? `${totalRelayCount} nodo${totalRelayCount !== 1 ? "s" : ""} RF`
              : "Sin nodo RF"}
          </div>
          {channelBusy && !pttActive && (
            <div className="ml-auto flex items-center gap-2 bg-yellow-900/30 border border-yellow-700/50 rounded-full px-3 py-1">
              <span className="flex gap-0.5">
                {[1,2,3].map((i) => (
                  <span key={i} className="w-0.5 h-3 bg-yellow-400 rounded-full animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                ))}
              </span>
              <span className="text-yellow-300 text-xs font-medium">
                {activeSpeaker ? `${activeSpeaker} transmitiendo` : "Canal ocupado"}
              </span>
            </div>
          )}
        </div>

        <div className="eqso-radio-stage relative flex-1 flex flex-col items-center justify-center p-8">
          <div className="eqso-radio-meta mb-3 flex w-full items-center justify-between gap-3 md:hidden">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Estás en</p>
              <h1 className="break-all font-mono text-xl font-bold text-white"><span className="text-green-500">#</span> {currentRoom}</h1>
            </div>
            <div className="min-w-0 text-right">
              <p className={`text-xs ${hasRadioLinks ? "text-blue-300" : "text-amber-300"}`}>
                {hasRadioLinks ? `${totalRelayCount} nodo${totalRelayCount !== 1 ? "s" : ""} RF` : "Sin nodo RF"}
              </p>
              <p className="mt-1 break-all font-mono text-xs text-gray-400">{currentName}</p>
            </div>
          </div>
          <div className="hidden text-center mb-10 md:block">
            <p className="text-gray-500 text-sm mb-1">Sala activa</p>
            <p className="text-3xl font-bold font-mono text-white"># {currentRoom}</p>
            <p className="text-gray-500 text-sm mt-1 font-mono">{currentName}</p>
          </div>

          {!hasRadioLinks && (
            <div role="status" className="eqso-notice mb-6 bg-amber-950/50 border border-amber-700/60 text-amber-300 text-sm rounded-lg px-4 py-3 text-center max-w-sm">
              <p className="font-semibold mb-1">Sin nodos de radioenlace en la sala</p>
              <p className="text-amber-400/80 text-xs">
                No hay nodos conectados a #{currentRoom}. Tus transmisiones llegan al servidor pero no se emiten por RF.
              </p>
            </div>
          )}

          {isMicAllowed === false && (
            <div role="alert" className="eqso-notice mb-6 bg-red-950/50 border border-red-800 text-red-300 text-sm rounded-lg px-4 py-3 text-center max-w-sm">
              Micrófono denegado. Activa los permisos del micrófono en tu navegador para poder transmitir.
            </div>
          )}

          <div className="eqso-ptt-controls flex w-full flex-col items-center gap-6">
            <p className={`eqso-channel-status text-center text-xs font-medium md:hidden ${pttActive ? pttGranted ? "text-red-300" : "text-orange-300" : channelBusy ? "text-amber-300" : "text-green-300"}`} aria-live="polite">
              {pttActive ? pttGranted ? "Transmitiendo" : "Esperando autorización…" : channelBusy ? activeSpeaker ? `${activeSpeaker} transmitiendo` : "Canal ocupado" : "Canal disponible"}
            </p>
            <div className="eqso-ptt-wrap relative">
              <button
                type="button"
                data-ptt
                aria-label={pttActive && pttGranted ? "Transmitiendo. Suelta para dejar de hablar" : channelBusy && !pttActive ? "Canal ocupado" : "Mantén pulsado para hablar"}
                aria-pressed={pttActive && pttGranted}
                onPointerDown={(event) => {
                  event.preventDefault();
                  if (pointerHeld.current) return;
                  pointerHeld.current = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  onPttStart();
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  pointerHeld.current = false;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  onPttEnd();
                }}
                onPointerCancel={(event) => {
                  pointerHeld.current = false;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  onPttEnd();
                }}
                onLostPointerCapture={() => {
                  if (!pointerHeld.current) return;
                  pointerHeld.current = false;
                  onPttEnd();
                }}
                onContextMenu={(event) => event.preventDefault()}
                disabled={channelBusy && !pttActive}
                className={`eqso-ptt-button ${pttActive && pttGranted ? "tx" : pttActive ? "waiting" : channelBusy ? "locked" : ""} w-40 h-40 rounded-full flex flex-col items-center justify-center gap-2 transition-all duration-150 select-none touch-none
                  ${pttActive && pttGranted
                    ? "bg-red-600 scale-95 shadow-lg shadow-red-900/50 border-4 border-red-400"
                    : pttActive && !pttGranted
                    ? "bg-orange-700 scale-95 border-4 border-orange-500"
                    : channelBusy
                    ? "bg-gray-800 border-4 border-gray-700 cursor-not-allowed opacity-60"
                    : "bg-green-700 hover:bg-green-600 active:scale-95 border-4 border-green-500 shadow-lg shadow-green-900/30 cursor-pointer"
                  }`}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className={`w-14 h-14 ${pttActive && pttGranted ? "text-red-100" : "text-white"}`}>
                  <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1h2v1a5 5 0 0 0 10 0v-1h2z"/>
                  <rect x="11" y="18" width="2" height="4"/>
                </svg>
                <span className="text-xs font-bold text-white/80 uppercase tracking-widest">
                  {pttActive && pttGranted ? "TX" : pttActive ? "..." : "PTT"}
                </span>
              </button>

              {pttActive && pttGranted && isRecording && (
                <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-1 rounded-full bg-red-400 animate-pulse"
                      style={{
                        height: `${Math.max(4, inputLevel * 24 * (0.5 + Math.random() * 0.5))}px`,
                        animationDelay: `${i * 60}ms`,
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="text-center">
              <p className="text-gray-500 text-sm">
                {pttActive && pttGranted
                  ? "Transmitiendo... suelta para dejar de hablar"
                  : pttActive
                  ? "Esperando..."
                  : channelBusy
                  ? "Canal ocupado"
                  : "Mantén pulsado para hablar"}
              </p>
              <p className="eqso-keyboard-hint text-gray-600 text-xs mt-1">
                También puedes usar la barra espaciadora
              </p>
            </div>
          </div>
        </div>

        <div className="eqso-radio-footer border-t border-gray-800 px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isRecording ? "bg-red-500 animate-pulse" : "bg-gray-600"}`} />
            <span className="text-xs text-gray-400">Micrófono{isMicAllowed === false ? " denegado" : isRecording ? " activo" : ""}</span>
          </div>
          {isRecording && (
            <div className="flex items-center gap-1">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="w-0.5 rounded-full bg-red-400 transition-all duration-100"
                  style={{ height: `${Math.max(2, inputLevel * 16 * Math.random())}px` }}
                />
              ))}
            </div>
          )}
          <button type="button" onClick={onDisconnect} className="ml-auto min-h-11 px-2 text-xs text-red-400 md:hidden">Desconectar</button>
          <div className="ml-auto hidden text-xs text-gray-600 font-mono md:block">
            TCP :2171 | WS /ws
          </div>
        </div>
      </div>
    </div>
  );
}
