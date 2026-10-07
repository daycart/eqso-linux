import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBulletinSchedule,
  useUpdateBulletinSchedule,
  useListBulletinTransmissionRooms,
  getGetBulletinScheduleQueryKey,
  getGetBulletinStatusQueryKey,
  getGetCurrentBulletinQueryKey,
  getListBulletinHistoryQueryKey,
  getListBulletinTransmissionsQueryKey,
  getListBulletinTransmissionRoomsQueryKey,
} from "@workspace/api-client-react";
import type { BulletinScheduleInput, BulletinScheduleEvent } from "@workspace/api-client-react";

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const EVENT_LABEL: Record<string, { text: string; cls: string }> = {
  completed: { text: "Completado", cls: "text-green-400 border-green-800/50 bg-green-950/30" },
  failed: { text: "Fallido", cls: "text-red-400 border-red-800/50 bg-red-950/30" },
  skipped: { text: "Omitido", cls: "text-yellow-500 border-yellow-800/50 bg-yellow-950/30" },
};

function EventLine({ label, ev, testId }: { label: string; ev: BulletinScheduleEvent | null; testId: string }) {
  const meta = ev ? EVENT_LABEL[ev.status] : null;
  return (
    <div className="border border-gray-800/80 bg-gray-950/50 rounded-lg p-3 space-y-1.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{label}</p>
        {meta && (
          <span className={`text-[10px] uppercase font-bold tracking-wider border px-1.5 py-0.5 rounded-full ${meta.cls}`}>
            {meta.text}
          </span>
        )}
      </div>
      {ev ? (
        <>
          <p className="text-[11px] text-gray-400">{fmt(ev.at)}</p>
          <p className={`text-xs leading-relaxed ${ev.status === "failed" ? "text-red-300" : "text-gray-300"}`}>{ev.message}</p>
        </>
      ) : (
        <p className="text-xs text-gray-600">Sin ejecuciones registradas.</p>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full border transition-colors shrink-0 ${
        checked ? "bg-blue-700 border-blue-500" : "bg-gray-800 border-gray-700"
      }`}
    >
      <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-gray-100 transition-transform ${checked ? "translate-x-5" : ""}`} />
    </button>
  );
}

const inputCls =
  "w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600 transition-colors";

type Form = {
  generationEnabled: boolean;
  transmissionEnabled: boolean;
  generationIntervalMinutes: string;
  transmissionIntervalMinutes: string;
  maxAgeMinutes: string;
  room: string;
};

function toForm(c: BulletinScheduleInput): Form {
  return {
    generationEnabled: c.generationEnabled,
    transmissionEnabled: c.transmissionEnabled,
    generationIntervalMinutes: String(c.generationIntervalMinutes),
    transmissionIntervalMinutes: String(c.transmissionIntervalMinutes),
    maxAgeMinutes: String(c.maxAgeMinutes),
    room: c.room,
  };
}

export function BulletinSchedulePanel({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const request = useMemo(() => ({ headers: { Authorization: `Bearer ${token}` } }), [token]);

  const { data: schedule, isLoading, error, refetch } = useGetBulletinSchedule({
    request,
    query: { queryKey: getGetBulletinScheduleQueryKey(), refetchInterval: 10000 },
  });
  const { data: roomsData } = useListBulletinTransmissionRooms({ request });
  const update = useUpdateBulletinSchedule({ request });

  const [form, setForm] = useState<Form | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  // Initialise / resync from server only when the form is pristine.
  useEffect(() => {
    if (schedule && (!form || !dirty)) setForm(toForm(schedule.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule, dirty]);

  // Refresh related bulletin data when automation events change.
  const lastSeen = useRef<string | null>(null);
  const genAt = schedule?.lastGeneration?.at ?? "";
  const txAt = schedule?.lastTransmission?.at ?? "";
  useEffect(() => {
    if (!schedule) return;
    const sig = `${genAt}|${txAt}`;
    if (lastSeen.current !== null && lastSeen.current !== sig) {
      queryClient.invalidateQueries({ queryKey: getGetBulletinStatusQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCurrentBulletinQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBulletinHistoryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBulletinTransmissionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListBulletinTransmissionRoomsQueryKey() });
    }
    lastSeen.current = sig;
  }, [genAt, txAt, schedule, queryClient]);

  const patch = (p: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...p } : f));
    setDirty(true);
    setSaved(false);
  };

  const rooms = useMemo(() => {
    const list = roomsData?.rooms ?? [];
    return form?.room && !list.includes(form.room) ? [form.room, ...list] : list;
  }, [roomsData, form?.room]);

  if (isLoading || (!form && !error)) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 animate-pulse space-y-3" data-testid="schedule-loading">
        <div className="h-4 w-56 bg-gray-800 rounded" />
        <div className="h-24 bg-gray-800/60 rounded" />
      </div>
    );
  }
  if (error && !form) {
    return (
      <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-5 flex items-center justify-between gap-4" data-testid="schedule-error">
        <p className="text-xs text-red-300">No se pudo cargar la programación: {(error as Error).message || "error desconocido"}</p>
        <button onClick={() => refetch()} data-testid="button-schedule-retry" className="text-xs bg-gray-800 border border-gray-700 text-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-700">
          Reintentar
        </button>
      </div>
    );
  }
  if (!form) return null;

  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const gi = num(form.generationIntervalMinutes);
  const ti = num(form.transmissionIntervalMinutes);
  const ma = num(form.maxAgeMinutes);
  const inRange = (v: number, lo: number) => Number.isInteger(v) && v >= lo && v <= 10080;
  const errs: string[] = [];
  if (!inRange(gi, 15)) errs.push("Intervalo de generación: 15 a 10080 minutos.");
  if (!inRange(ti, 5)) errs.push("Intervalo de transmisión: 5 a 10080 minutos.");
  if (!inRange(ma, 15)) errs.push("Antigüedad máxima: 15 a 10080 minutos.");
  if (form.transmissionEnabled && !form.room) errs.push("Seleccione una sala de destino.");
  if (form.transmissionEnabled && !confirmed) errs.push("Confirme la emisión por RF para activar la transmisión.");
  const canSave = errs.length === 0 && !update.isPending;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const config: BulletinScheduleInput = {
      generationEnabled: form.generationEnabled,
      transmissionEnabled: form.transmissionEnabled,
      generationIntervalMinutes: gi,
      transmissionIntervalMinutes: ti,
      maxAgeMinutes: ma,
      room: form.room,
      confirmed: form.transmissionEnabled && confirmed ? true : false,
    };
    update.mutate({ data: config }, {
      onSuccess: (res) => {
        queryClient.setQueryData(getGetBulletinScheduleQueryKey(), res);
        setForm(toForm(res.config));
        setDirty(false);
        setSaved(true);
        setConfirmed(false);
        queryClient.invalidateQueries({ queryKey: getGetBulletinStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListBulletinTransmissionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListBulletinTransmissionRoomsQueryKey() });
      },
    });
  };

  const field = (label: string, key: "generationIntervalMinutes" | "transmissionIntervalMinutes" | "maxAgeMinutes", hint: string, tid: string) => (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-gray-300">{label}</span>
      <input
        type="number" inputMode="numeric" value={form[key]} data-testid={tid}
        onChange={(e) => patch({ [key]: e.target.value } as Partial<Form>)}
        className={inputCls}
      />
      <span className="text-[10px] text-gray-500">{hint}</span>
    </label>
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" data-testid="panel-bulletin-schedule">
      <div className="border-b border-gray-800 p-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Programación automática</h3>
          <p className="text-xs text-gray-500 mt-0.5">Generación y emisión periódicas, independientes del control manual.</p>
        </div>
        {dirty && (
          <span className="text-[10px] uppercase font-bold tracking-wider text-yellow-500 border border-yellow-800/50 bg-yellow-950/30 px-2 py-0.5 rounded-full" data-testid="badge-schedule-dirty">
            Cambios sin guardar
          </span>
        )}
      </div>

      <div className="p-5 grid grid-cols-1 xl:grid-cols-5 gap-6">
        <form onSubmit={save} className="xl:col-span-3 space-y-5">
          <section className="border border-gray-800/80 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-200">Generación automática</p>
                <p className="text-[11px] text-gray-500">Crea un boletín nuevo cada cierto tiempo. No emite audio.</p>
              </div>
              <Toggle checked={form.generationEnabled} onChange={(v) => patch({ generationEnabled: v })} label="Generación automática" testId="switch-generation-enabled" />
            </div>
            {field("Intervalo de generación (minutos)", "generationIntervalMinutes", "Entre 15 y 10080 (7 días).", "input-generation-interval")}
          </section>

          <section className="border border-red-900/40 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-200">Transmisión automática</p>
                <p className="text-[11px] text-gray-500">Emite el boletín vigente en la sala elegida, sin escucha previa.</p>
              </div>
              <Toggle
                checked={form.transmissionEnabled}
                onChange={(v) => { patch({ transmissionEnabled: v }); if (!v) setConfirmed(false); }}
                label="Transmisión automática" testId="switch-transmission-enabled"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field("Intervalo de transmisión (minutos)", "transmissionIntervalMinutes", "Entre 5 y 10080.", "input-transmission-interval")}
              <label className="block space-y-1">
                <span className="text-xs font-medium text-gray-300">Sala de destino</span>
                <select value={form.room} onChange={(e) => patch({ room: e.target.value })} className={inputCls} data-testid="select-schedule-room">
                  <option value="">-- Seleccione una sala --</option>
                  {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <span className="text-[10px] text-gray-500">Si la sala está ocupada, ese ciclo se omite.</span>
              </label>
            </div>
            {field("Antigüedad máxima del boletín (minutos)", "maxAgeMinutes", "Un boletín más antiguo no se transmite. Entre 15 y 10080.", "input-max-age")}

            {form.transmissionEnabled && (
              <label className="flex items-start gap-3 bg-yellow-950/30 border border-yellow-900/50 rounded-lg p-3 cursor-pointer">
                <input
                  type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
                  data-testid="checkbox-rf-confirm" className="mt-0.5 accent-red-600"
                />
                <span className="text-xs text-yellow-500/90 leading-relaxed">
                  Confirmo que la transmisión automática emitirá audio real en la sala seleccionada y <strong className="font-semibold">puede salir al aire por radiofrecuencia (RF)</strong> sin supervisión. La confirmación se pide en cada guardado.
                </span>
              </label>
            )}
          </section>

          <ul className="text-[11px] text-gray-500 leading-relaxed space-y-1 list-disc pl-4" data-testid="list-schedule-notes">
            <li>Guardar la configuración nunca emite de inmediato; la primera ejecución espera al siguiente intervalo.</li>
            <li>Si el servidor se reinicia no se recuperan ciclos perdidos.</li>
            <li>Desactivar la transmisión no cancela una emisión que ya haya comenzado.</li>
            <li>Una sala ocupada provoca que ese ciclo se omita, sin reintento.</li>
          </ul>

          {errs.length > 0 && dirty && (
            <div className="text-xs text-yellow-500 bg-yellow-950/20 border border-yellow-900/40 rounded-lg p-3 space-y-0.5" data-testid="text-schedule-validation">
              {errs.map((m) => <p key={m}>{m}</p>)}
            </div>
          )}
          {update.isError && (
            <div className="text-xs text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg p-3" data-testid="text-schedule-save-error">
              No se pudo guardar: {(update.error as Error).message || "error desconocido"}
            </div>
          )}
          {saved && !dirty && (
            <div className="text-xs text-green-300 bg-green-950/40 border border-green-900/50 rounded-lg p-3" data-testid="text-schedule-saved">
              Programación guardada. No se ha emitido nada de forma inmediata.
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit" disabled={!canSave || !dirty} data-testid="button-schedule-save"
              className="bg-blue-700/90 hover:bg-blue-600 disabled:bg-gray-800 disabled:text-gray-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg border border-blue-600 disabled:border-gray-700 transition-colors"
            >
              {update.isPending ? "Guardando..." : "Guardar programación"}
            </button>
            {dirty && (
              <button
                type="button" data-testid="button-schedule-discard"
                onClick={() => { if (schedule) setForm(toForm(schedule.config)); setConfirmed(false); setDirty(false); }}
                className="text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 px-4 py-2.5 rounded-lg transition-colors"
              >
                Descartar
              </button>
            )}
          </div>
        </form>

        <aside className="xl:col-span-2 space-y-3" data-testid="panel-schedule-status">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-300">Estado en vivo</p>
            <span className="text-[10px] text-gray-600">Actualiza cada 10 s</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { l: "Próxima generación", v: schedule?.config.generationEnabled ? fmt(schedule.nextGenerationAt) : "Desactivada", r: schedule?.generationRunning, t: "next-generation" },
              { l: "Próxima transmisión", v: schedule?.config.transmissionEnabled ? fmt(schedule.nextTransmissionAt) : "Desactivada", r: schedule?.transmissionRunning, t: "next-transmission" },
            ].map((x) => (
              <div key={x.t} className="border border-gray-800/80 bg-gray-950/50 rounded-lg p-3 space-y-1" data-testid={`status-${x.t}`}>
                <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{x.l}</p>
                <p className="text-xs text-gray-200">{x.v}</p>
                {x.r && <p className="text-[10px] font-semibold text-blue-400 animate-pulse">En ejecución ahora</p>}
              </div>
            ))}
          </div>
          <EventLine label="Última generación" ev={schedule?.lastGeneration ?? null} testId="status-last-generation" />
          <EventLine label="Última transmisión" ev={schedule?.lastTransmission ?? null} testId="status-last-transmission" />
          {error && (
            <p className="text-[11px] text-red-400" data-testid="text-schedule-poll-error">No se pudo actualizar el estado; se reintentará.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
