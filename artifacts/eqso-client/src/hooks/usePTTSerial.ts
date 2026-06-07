/**
 * usePTTSerial — Web Serial API hook for PTT keying via RTS/DTR.
 *
 * Supports:
 *   - Puerto COM (Web Serial API — Chrome/Edge on Linux)
 *   - VOX mode (no serial, PTT is purely audio-triggered)
 *   - Pin: RTS or DTR
 *   - Invertir voltaje (inverted logic)
 *
 * Settings are persisted in localStorage under "ptt_config".
 */

import { useState, useCallback, useRef, useEffect } from "react";

export type PTTMethod = "COM" | "VOX";
export type PTTPin = "RTS" | "DTR";

export interface PTTConfig {
  method: PTTMethod;
  pin: PTTPin;
  invertVoltage: boolean;
  /** Human-readable port label stored after the user selects a port */
  portLabel: string;
}

const STORAGE_KEY = "ptt_config";

const DEFAULT_CONFIG: PTTConfig = {
  method: "VOX",
  pin: "RTS",
  invertVoltage: false,
  portLabel: "",
};

function loadConfig(): PTTConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: PTTConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function usePTTSerial() {
  const [config, setConfigState] = useState<PTTConfig>(loadConfig);
  const [portOpen, setPortOpen] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const portRef = useRef<SerialPort | null>(null);
  const isSupported = "serial" in navigator;

  const setConfig = useCallback((cfg: PTTConfig) => {
    setConfigState(cfg);
    saveConfig(cfg);
  }, []);

  /* Auto-reconnect to previously authorized port on mount */
  useEffect(() => {
    if (!isSupported || config.method !== "COM") return;
    let cancelled = false;
    navigator.serial.getPorts().then(async (ports) => {
      if (cancelled || ports.length === 0 || portRef.current) return;
      try {
        await ports[0].open({ baudRate: 9600 });
        if (cancelled) { ports[0].close().catch(() => {}); return; }
        portRef.current = ports[0];
        setPortOpen(true);
        setPortError(null);
        console.log("[PTT] auto-reconectado al puerto autorizado previamente");
      } catch {
        /* puerto ocupado o desconectado — el usuario tendrá que seleccionarlo manualmente */
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported]);

  /* Close any open port on unmount */
  useEffect(() => {
    return () => {
      portRef.current?.close().catch(() => {});
    };
  }, []);

  /**
   * Ask the browser to pick a serial port and open it.
   * Returns true on success, false on failure.
   */
  const requestPort = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      setPortError("Web Serial API no disponible (usa Chrome o Edge)");
      return false;
    }
    try {
      const port = await navigator.serial.requestPort();
      await portRef.current?.close().catch(() => {});
      await port.open({ baudRate: 9600 });
      portRef.current = port;
      setPortOpen(true);
      setPortError(null);

      const info = port.getInfo();
      const label =
        info.usbVendorId
          ? `Puerto USB (vid:${info.usbVendorId.toString(16)})`
          : "Puerto serie seleccionado";
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("No port selected")) {
        setPortError(`Error al abrir puerto: ${msg}`);
      }
      setPortOpen(false);
      return false;
    }
  }, [isSupported]);

  /**
   * Close the open port.
   */
  const closePort = useCallback(async () => {
    if (portRef.current) {
      await portRef.current.close().catch(() => {});
      portRef.current = null;
      setPortOpen(false);
    }
  }, []);

  /**
   * Key the transmitter DOWN (PTT active).
   */
  const keyDown = useCallback(async () => {
    console.log("[PTT] keyDown — method:", config.method, "portOpen:", !!portRef.current, "pin:", config.pin, "invert:", config.invertVoltage);
    if (config.method !== "COM" || !portRef.current) return;
    const active = !config.invertVoltage;
    try {
      if (config.pin === "RTS") {
        await portRef.current.setSignals({ requestToSend: active });
        console.log("[PTT] RTS →", active);
      } else {
        await portRef.current.setSignals({ dataTerminalReady: active });
        console.log("[PTT] DTR →", active);
      }
    } catch (err) {
      console.error("[PTT] keyDown error:", err);
    }
  }, [config]);

  /**
   * Release the transmitter (PTT off).
   */
  const keyUp = useCallback(async () => {
    console.log("[PTT] keyUp — method:", config.method, "portOpen:", !!portRef.current);
    if (config.method !== "COM" || !portRef.current) return;
    const idle = config.invertVoltage;
    try {
      if (config.pin === "RTS") {
        await portRef.current.setSignals({ requestToSend: idle });
        console.log("[PTT] RTS →", idle);
      } else {
        await portRef.current.setSignals({ dataTerminalReady: idle });
        console.log("[PTT] DTR →", idle);
      }
    } catch (err) {
      console.error("[PTT] keyUp error:", err);
    }
  }, [config]);

  return {
    config,
    setConfig,
    isSupported,
    portOpen,
    portError,
    requestPort,
    closePort,
    keyDown,
    keyUp,
  };
}
