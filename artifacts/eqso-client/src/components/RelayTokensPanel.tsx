import { useCallback, useEffect, useState } from "react";
import { getApiBase } from "./LoginPanel";

interface RelayTokenRow {
  id: number;
  callsign: string;
  label: string;
  legacyDisabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("es-ES") : "—";
}

export function RelayTokensPanel({ token }: { token: string }) {
  const [rows, setRows] = useState<RelayTokenRow[]>([]);
  const [callsign, setCallsign] = useState("");
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${getApiBase()}/api/admin/relay-tokens`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "No se pudieron consultar los tokens");
      setRows(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de conexión");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || created) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${getApiBase()}/api/admin/relay-tokens`, {
        method: "POST", headers, body: JSON.stringify({ callsign: callsign.trim().toUpperCase(), label: label.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "No se pudo crear el token");
      setCreated(data.token);
      setCallsign("");
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de conexión");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: RelayTokenRow) {
    if (busy || !window.confirm(`¿Revocar el token de ${row.callsign} (${row.label})? Su conexión activa se cerrará si usa este token.`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${getApiBase()}/api/admin/relay-tokens/${row.id}/revoke`, {
        method: "POST", headers,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "No se pudo revocar el token");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de conexión");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-6 text-gray-200">
      <div>
        <h2 className="text-lg font-semibold">Tokens de radioenlace</h2>
        <p className="text-sm text-gray-400 mt-1">
          Cada token permite conectar un indicativo 0R- al servidor, también desde eQSO 1.13:
          introdúcelo en el campo de contraseña del cliente.
        </p>
        <p className="text-xs text-amber-300 mt-2">
          Para los radioenlaces 1.13 autorizados, la contraseña de «Servidor Local»
          seguirá funcionando hasta su primera conexión con un token propio.
          Si están configuradas, la clave compartida anterior y la contraseña general del servicio también
          seguirán funcionando para cada indicativo hasta su primera conexión con un token propio.
          Desde entonces, ese indicativo solo aceptará tokens propios.
          No revoques el último token activo sin preparar uno de sustitución.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}

      {created && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4 space-y-3">
          <h3 className="font-semibold text-amber-200">Token creado: cópialo ahora</h3>
          <p className="text-xs text-gray-300">Solo se mostrará en esta ocasión. Guárdalo en el campo de contraseña del cliente eQSO.</p>
          <code className="block break-all select-all rounded bg-gray-950 p-3 text-green-300">{created}</code>
          <div className="flex gap-3">
            <button type="button" className="rounded bg-gray-700 px-3 py-2 text-sm hover:bg-gray-600" onClick={async () => {
              try { await navigator.clipboard.writeText(created); } catch { setError("No se pudo copiar; selecciona el texto manualmente"); }
            }}>Copiar token</button>
            <button type="button" className="rounded bg-amber-800 px-3 py-2 text-sm hover:bg-amber-700" onClick={() => setCreated(null)}>
              Ya lo he guardado
            </button>
          </div>
        </div>
      )}

      <form onSubmit={create} className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
        <h3 className="font-semibold">Crear token</h3>
        <div className="flex flex-wrap gap-3">
          <label className="flex-1 min-w-44 text-xs text-gray-400">Indicativo 0R-
            <input required maxLength={30} pattern="0[Rr]-[A-Za-z0-9-]+" value={callsign} onChange={(e) => setCallsign(e.target.value)}
              placeholder="0R-PRUEBAS" className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white uppercase" />
          </label>
          <label className="flex-1 min-w-44 text-xs text-gray-400">Nombre del equipo
            <input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Radio de pruebas" className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" />
          </label>
        </div>
        <button type="submit" disabled={busy || !!created} className="rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50">
          {busy ? "Guardando…" : "Crear token"}
        </button>
      </form>

      <div className="space-y-2">
        <h3 className="font-semibold">Tokens creados</h3>
        {loading ? <p className="text-sm text-gray-400">Cargando…</p> : rows.length === 0
          ? <p className="text-sm text-gray-400">Todavía no hay tokens creados desde el panel.</p>
          : rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-gray-700 bg-gray-900 p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-mono font-semibold text-green-300">{row.callsign} <span className="font-sans text-sm font-normal text-gray-300">· {row.label}</span></div>
                <div className="text-xs text-gray-400 mt-1">
                  {row.revokedAt ? `Revocado ${formatDate(row.revokedAt)}` : row.legacyDisabled ? "Activo · solo tokens propios" : "Activo · en transición"}
                  {" · "}Creado {formatDate(row.createdAt)} · Último uso {formatDate(row.lastUsedAt)}
                </div>
              </div>
              {!row.revokedAt && (
                <button type="button" disabled={busy} onClick={() => void revoke(row)}
                  className="rounded border border-red-800 px-3 py-2 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50">
                  Revocar
                </button>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}