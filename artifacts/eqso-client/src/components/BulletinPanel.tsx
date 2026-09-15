import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBulletinStatus,
  useGetCurrentBulletin,
  useListBulletinHistory,
  useGenerateBulletin,
  getGetBulletinStatusQueryKey,
  getGetCurrentBulletinQueryKey,
  getListBulletinHistoryQueryKey,
  getBulletinAudio,
  useListBulletinTransmissionRooms,
  useListBulletinTransmissions,
  useTransmitBulletin,
  getListBulletinTransmissionsQueryKey,
  getListBulletinTransmissionRoomsQueryKey
} from "@workspace/api-client-react";
import type { WeatherBulletin, BulletinTransmission } from "@workspace/api-client-react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "./ui/alert-dialog";

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function BulletinPanel({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const requestOpts = useMemo(() => ({ request: { headers: { Authorization: `Bearer ${token}` } } }), [token]);

  const { data: status, isLoading: loadingStatus, error: statusError } = useGetBulletinStatus(requestOpts);
  const { data: current, isLoading: loadingCurrent } = useGetCurrentBulletin(requestOpts);
  const { data: history, isLoading: loadingHistory } = useListBulletinHistory(requestOpts);
  const { data: roomsData } = useListBulletinTransmissionRooms(requestOpts);
  const { data: transmissions, isLoading: loadingTransmissions } = useListBulletinTransmissions(requestOpts);

  const generateMut = useGenerateBulletin({ request: requestOpts.request });
  const transmitMut = useTransmitBulletin({ request: requestOpts.request });

  const [playingAudioUrl, setPlayingAudioUrl] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLoadingId, setAudioLoadingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Phase 2 state
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [transmitTarget, setTransmitTarget] = useState<WeatherBulletin | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string>("");

  const handleGenerate = () => {
    if (generateMut.isPending) return;
    generateMut.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBulletinStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCurrentBulletinQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListBulletinHistoryQueryKey() });
      }
    });
  };

  const handleTransmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!transmitTarget || !selectedRoom) return;

    transmitMut.mutate({
      id: transmitTarget.id,
      data: { room: selectedRoom, confirmed: true }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBulletinTransmissionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListBulletinTransmissionRoomsQueryKey() });
      }
    });
  };

  const playAudio = async (id: string) => {
    try {
      if (playingId === id) {
        if (audioRef.current) {
          if (isPlaying) {
            audioRef.current.pause();
          } else {
            audioRef.current.play();
          }
        }
        return;
      }

      setAudioLoadingId(id);
      const blob = await getBulletinAudio(id, requestOpts.request);
      const url = URL.createObjectURL(blob);
      if (playingAudioUrl) {
        URL.revokeObjectURL(playingAudioUrl);
      }
      setPlayingAudioUrl(url);
      setPlayingId(id);

      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.play();
      }
    } catch (e) {
      console.error(e);
      alert("Error al cargar el audio del boletín.");
    } finally {
      setAudioLoadingId(null);
    }
  };

  useEffect(() => {
    return () => {
      if (playingAudioUrl) {
        URL.revokeObjectURL(playingAudioUrl);
      }
    };
  }, [playingAudioUrl]);

  const isCurrentReviewed = current ? reviewedIds.has(current.id) : false;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <audio
        ref={audioRef}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
           setIsPlaying(false);
           if (playingId) {
             setReviewedIds(prev => new Set(prev).add(playingId!));
           }
           setPlayingId(null);
        }}
        className="hidden"
      />

      <AlertDialog open={!!transmitTarget} onOpenChange={(open) => {
        if (!open && !transmitMut.isPending) {
          setTransmitTarget(null);
          setSelectedRoom("");
          transmitMut.reset();
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar Transmisión Manual</AlertDialogTitle>
            <AlertDialogDescription asChild>
              {transmitTarget && (
                 <div className="space-y-4 mt-3">
                    <div className="bg-gray-900 border border-gray-800 p-3 rounded-lg text-gray-300 text-sm">
                      <p className="mb-1"><span className="font-semibold text-gray-400">Boletín generado:</span> {formatDateTime(transmitTarget.generatedAt)}</p>
                      <p><span className="font-semibold text-gray-400">Municipio:</span> {transmitTarget.municipality}</p>
                    </div>

                    {transmitMut.isError && (
                      <div className="bg-red-950/40 border border-red-900/50 text-red-300 p-3 rounded-lg text-xs leading-relaxed">
                        <strong className="text-red-400 block mb-1">Error al transmitir:</strong>
                        {(transmitMut.error as Error).message || "Fallo desconocido en la operación."}
                      </div>
                    )}
                    {transmitMut.isSuccess && (
                      <div className="bg-green-950/40 border border-green-900/50 text-green-300 p-3 rounded-lg text-sm leading-relaxed">
                        <strong className="text-green-400 block mb-1">Transmisión completada con éxito.</strong>
                        El audio fue emitido correctamente a la red.<br/>
                        Paquetes enviados: {transmitMut.data?.packetCount}<br/>
                        Duración: {(transmitMut.data?.durationMs! / 1000).toFixed(1)} segundos
                      </div>
                    )}

                    {!transmitMut.isSuccess && (
                      <div className="space-y-3 pt-2">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium text-gray-200">Seleccione la sala de destino:</label>
                          <select
                            value={selectedRoom}
                            onChange={e => setSelectedRoom(e.target.value)}
                            disabled={transmitMut.isPending}
                            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-red-600 focus:ring-1 focus:ring-red-600 transition-colors"
                          >
                            <option value="" disabled>-- Seleccione una sala --</option>
                            {roomsData?.rooms.map(r => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                          {roomsData?.rooms.length === 0 && (
                            <p className="text-xs text-red-400">No hay salas elegibles disponibles en el servidor.</p>
                          )}
                        </div>

                        <div className="bg-yellow-950/30 border border-yellow-900/50 text-yellow-500/90 text-xs p-3 rounded-lg flex items-start gap-3 mt-4">
                          <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                          <p className="leading-relaxed">
                            Esta acción emitirá el audio real del boletín en la sala eQSO seleccionada y <strong className="font-semibold">puede transmitirse al aire por radiofrecuencia (RF)</strong> a través de los enlaces conectados. Esta operación <strong className="font-semibold">no se puede cancelar</strong> una vez iniciada.
                          </p>
                        </div>
                      </div>
                    )}
                 </div>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {!transmitMut.isPending && !transmitMut.isSuccess && (
              <AlertDialogCancel onClick={() => { setTransmitTarget(null); setSelectedRoom(""); }}>Cancelar</AlertDialogCancel>
            )}
            {transmitMut.isSuccess ? (
               <button
                 onClick={() => { setTransmitTarget(null); setSelectedRoom(""); transmitMut.reset(); }}
                 className="bg-gray-800 hover:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm transition-colors border border-gray-700"
               >
                 Cerrar
               </button>
            ) : (
               <button
                 onClick={handleTransmit}
                 disabled={!selectedRoom || transmitMut.isPending}
                 className="bg-red-700 hover:bg-red-600 disabled:bg-gray-800 disabled:text-gray-500 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center justify-center min-w-[140px] gap-2 transition-colors shadow-sm border border-red-600 disabled:border-gray-700"
               >
                 {transmitMut.isPending ? (
                   <>
                     <svg className="animate-spin w-4 h-4 text-current" fill="none" viewBox="0 0 24 24">
                       <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                       <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                     </svg>
                     Emitiendo...
                   </>
                 ) : (
                   <>
                     <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>
                     Transmitir ahora
                   </>
                 )}
               </button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Banner */}
      <div className="bg-yellow-950/40 border border-yellow-800/80 rounded-xl p-4 flex items-start gap-4">
        <svg className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <h3 className="text-yellow-400 font-medium text-sm">Fase 2: Transmisión manual operativa</h3>
          <p className="text-yellow-500/80 text-xs mt-1 max-w-3xl leading-relaxed">
            Este módulo genera boletines meteorológicos y permite su transmisión a eQSO. La generación y la emisión son procesos estrictamente manuales. Es obligatorio escuchar el audio generado por completo antes de que el sistema habilite la confirmación de transmisión. No existe programación desatendida.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column */}
        <div className="lg:col-span-7 space-y-6">
          {/* Generation Card */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-200">Generación manual</h3>
              {loadingStatus ? (
                <span className="text-xs text-gray-500">Cargando...</span>
              ) : (
                status && (
                  <span className="text-[10px] uppercase font-bold tracking-wider text-green-400 border border-green-800/50 bg-green-950/30 px-2 py-0.5 rounded-full">
                    {status.identity}
                  </span>
                )
              )}
            </div>

            {statusError ? (
              <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 p-3 rounded-lg mb-4">
                Error al cargar el estado: {(statusError as Error).message || "Desconocido"}
              </div>
            ) : (
              <p className="text-xs text-gray-400 mb-5 flex items-center gap-2">
                <span className="font-medium text-gray-500">Área de enfoque:</span>
                {status?.geographicFocus || "—"}
              </p>
            )}

            {generateMut.error && (
              <div className="mb-4 bg-red-950/40 border border-red-900/60 text-red-300 text-xs p-3 rounded-lg">
                Error: {generateMut.error.message || "No se pudo generar el boletín"}
              </div>
            )}

            <button
              onClick={handleGenerate}
              disabled={generateMut.isPending || loadingStatus}
              className="w-full bg-blue-700/90 hover:bg-blue-600 disabled:bg-gray-800 disabled:text-gray-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm border border-blue-600 disabled:border-gray-700"
            >
              {generateMut.isPending ? (
                <>
                  <svg className="animate-spin w-4 h-4 text-current" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Generando boletín...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                  </svg>
                  Generar nuevo boletín
                </>
              )}
            </button>
          </div>

          {/* Current Bulletin */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
            <div className="border-b border-gray-800 p-5 bg-gray-900/50">
              <h3 className="text-sm font-semibold text-gray-200">Boletín actual</h3>
            </div>
            <div className="p-5 flex-1">
              {loadingCurrent ? (
                <div className="flex flex-col items-center justify-center py-10 space-y-3">
                  <div className="w-5 h-5 border-2 border-gray-700 border-t-gray-400 rounded-full animate-spin"></div>
                  <p className="text-xs text-gray-500">Cargando boletín...</p>
                </div>
              ) : !current ? (
                <div className="text-center py-10">
                  <svg className="w-10 h-10 text-gray-700 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  <p className="text-sm font-medium text-gray-400">Ningún boletín activo</p>
                  <p className="text-xs text-gray-600 mt-1">Genera uno nuevo para visualizarlo aquí.</p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                     <div className="flex items-center gap-2">
                       <span className="text-[10px] bg-blue-950/50 text-blue-400 border border-blue-900/50 px-2 py-0.5 rounded">
                         {current.municipality}
                       </span>
                       <span className="text-xs text-gray-400">
                         {formatDateTime(current.generatedAt)}
                       </span>
                     </div>
                     <div className="flex items-center gap-3">
                       {isCurrentReviewed ? (
                         <span className="text-[11px] font-medium text-green-400 flex items-center gap-1.5 px-2 py-1.5 rounded bg-green-950/30 border border-green-900/30">
                           <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                           Audio revisado
                         </span>
                       ) : (
                         <span className="text-[11px] font-medium text-yellow-500 flex items-center gap-1.5 px-2 py-1.5 rounded bg-yellow-950/30 border border-yellow-900/30">
                           <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                           Requiere escucha
                         </span>
                       )}
                       <button
                         onClick={() => playAudio(current.id)}
                         disabled={audioLoadingId === current.id}
                         className={`text-xs px-4 py-2 rounded-lg transition-colors flex items-center gap-2 border font-medium ${
                           playingId === current.id
                             ? "bg-green-900 border-green-700 text-green-200"
                             : "bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white"
                         } disabled:opacity-50 disabled:cursor-not-allowed`}
                       >
                         {audioLoadingId === current.id ? (
                           <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                         ) : (
                           <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                             {playingId === current.id && isPlaying ? (
                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                             ) : (
                                <path d="M8 5v14l11-7z" />
                             )}
                           </svg>
                         )}
                         {audioLoadingId === current.id ? "Descargando..." : (playingId === current.id && isPlaying ? "Pausar audio" : "Reproducir audio")}
                       </button>
                     </div>
                  </div>

                  <div className="bg-gray-950/80 border border-gray-800/80 p-5 rounded-xl text-sm text-gray-300 leading-relaxed font-serif whitespace-pre-wrap shadow-inner">
                    {current.forecastText}
                  </div>

                  <div className="pt-4 border-t border-gray-800/60 grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                    <div className="space-y-4">
                      <div className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Fuente de datos</p>
                        <p className="text-xs text-gray-300">{current.sourceAttribution}</p>
                        <p className="text-[11px] text-gray-500">Publicado: {formatDateTime(current.sourcePublishedAt)}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Referencia original</p>
                        <p className="text-[11px] text-gray-500">Recuperado: {formatDateTime(current.sourceRetrievedAt)}</p>
                        <a href={current.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 hover:underline inline-flex items-center gap-1">
                          Consultar portal oficial
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </div>
                    </div>
                    <div className="flex flex-col sm:items-end justify-end h-full">
                      <button
                        onClick={() => setTransmitTarget(current)}
                        disabled={!isCurrentReviewed}
                        className="bg-red-800/90 hover:bg-red-700 disabled:bg-gray-800 disabled:text-gray-500 text-white disabled:border-gray-700 border border-red-700 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm w-full sm:w-auto flex items-center justify-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>
                        Preparar transmisión
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column - Histories */}
        <div className="lg:col-span-5 flex flex-col gap-6">

          {/* Transmissions History Card */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-gray-200">Historial de transmisiones</h3>
            </div>

            {loadingTransmissions ? (
              <div className="flex flex-col items-center justify-center py-8 space-y-3">
                <div className="w-5 h-5 border-2 border-gray-700 border-t-gray-400 rounded-full animate-spin"></div>
                <p className="text-[11px] text-gray-500">Cargando emisiones...</p>
              </div>
            ) : !transmissions || transmissions.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-[11px] text-gray-500">No hay transmisiones previas registradas.</p>
              </div>
            ) : (
              <div className="space-y-3 flex-1 overflow-y-auto pr-1">
                {transmissions.map((t) => (
                  <div key={t.id} className="border border-gray-800/80 bg-gray-950/50 rounded-lg p-3 flex flex-col gap-2.5 transition-colors hover:border-gray-700">
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium text-gray-300 truncate">
                          Sala: <span className="text-gray-100">{t.room}</span>
                        </p>
                        <p className="text-[10px] text-gray-500 mt-0.5 truncate">
                          Boletín: {formatDateTime(t.bulletinGeneratedAt)}
                        </p>
                      </div>
                      <div className="shrink-0">
                        {t.status === "completed" && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-green-400 border border-green-800/50 bg-green-950/30 px-1.5 py-0.5 rounded-full">
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                            OK
                          </span>
                        )}
                        {t.status === "failed" && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-red-400 border border-red-800/50 bg-red-950/30 px-1.5 py-0.5 rounded-full">
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                            Error
                          </span>
                        )}
                        {t.status === "rejected" && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-yellow-500 border border-yellow-800/50 bg-yellow-950/30 px-1.5 py-0.5 rounded-full">
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                            Rechazado
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-gray-800/60">
                      <span className="text-[10px] text-gray-500 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        {formatDateTime(t.requestedAt)}
                      </span>
                      {t.status === "completed" && (
                        <span className="text-[10px] text-gray-400 flex items-center gap-1">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                          {t.packetCount} paq. / {(t.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>

                    {t.error && (
                      <div className="mt-0.5 bg-red-950/30 border border-red-900/30 rounded p-1.5 text-[10px] text-red-300 leading-relaxed">
                        <span className="font-semibold text-red-400">Detalle:</span> {t.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Generations History Card */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col flex-1 min-h-[300px]">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-gray-200">Historial de generaciones</h3>
              {status && (
                <span className="text-[10px] font-medium text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
                  {status.historyCount} registros
                </span>
              )}
            </div>

            {loadingHistory ? (
              <div className="flex flex-col items-center justify-center py-10 space-y-3">
                <div className="w-5 h-5 border-2 border-gray-700 border-t-gray-400 rounded-full animate-spin"></div>
                <p className="text-xs text-gray-500">Cargando historial...</p>
              </div>
            ) : !history || history.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-xs text-gray-500">No hay boletines previos.</p>
              </div>
            ) : (
              <div className="space-y-3 overflow-y-auto pr-1">
                {history.map((b) => (
                  <div key={b.id} className="border border-gray-800/80 bg-gray-950/50 rounded-lg p-3.5 flex flex-col gap-3 transition-colors hover:border-gray-700">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col min-w-0 pr-2">
                        <span className="text-xs font-medium text-gray-300 truncate">
                          {formatDateTime(b.generatedAt)}
                        </span>
                        <span className="text-[10px] text-gray-500 mt-0.5 truncate">
                          {b.municipality}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                           onClick={() => setExpandedId(expandedId === b.id ? null : b.id)}
                           className="text-[10px] font-medium text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-gray-800/50 border border-gray-700/50 transition-colors"
                        >
                          {expandedId === b.id ? "Ocultar" : "Ver texto"}
                        </button>
                        <button
                           onClick={() => playAudio(b.id)}
                           disabled={audioLoadingId === b.id}
                           className={`text-[11px] px-2.5 py-1 rounded transition-colors flex items-center gap-1.5 border font-medium ${
                             playingId === b.id
                               ? "bg-green-900/80 border-green-700/80 text-green-300"
                               : "bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white"
                           } disabled:opacity-50`}
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                             {audioLoadingId === b.id ? (
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                             ) : playingId === b.id && isPlaying ? (
                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                             ) : (
                                <path d="M8 5v14l11-7z" />
                             )}
                          </svg>
                          {audioLoadingId === b.id ? "..." : (playingId === b.id && isPlaying ? "Pausa" : "Play")}
                        </button>
                      </div>
                    </div>

                    {expandedId === b.id ? (
                      <div className="mt-1 text-[11px] text-gray-400 font-serif leading-relaxed whitespace-pre-wrap border-t border-gray-800/60 pt-3">
                        {b.forecastText}
                      </div>
                    ) : (
                      <p className="text-[11px] text-gray-600 line-clamp-2 leading-relaxed">
                        {b.forecastText}
                      </p>
                    )}

                    <div className="flex items-center justify-between pt-2.5 mt-1 border-t border-gray-800/60">
                      <div className="flex items-center gap-2">
                        {reviewedIds.has(b.id) ? (
                          <span className="text-[10px] font-medium text-green-400 flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-950/30 border border-green-900/30">
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                            Revisado
                          </span>
                        ) : (
                          <span className="text-[10px] font-medium text-yellow-500 flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-950/30 border border-yellow-900/30">
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                            Requiere escucha
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => setTransmitTarget(b)}
                        disabled={!reviewedIds.has(b.id)}
                        className="text-[10px] bg-red-900/80 hover:bg-red-800 disabled:bg-gray-800 text-white disabled:text-gray-500 px-3 py-1.5 rounded-md border border-red-800 disabled:border-gray-700 transition-colors font-medium flex items-center gap-1.5"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>
                        Transmitir
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
