/**
 * PTTSerialProvider — shared context for Web Serial PTT state.
 *
 * Ensures the serial port and config are shared between home.tsx and
 * PTTConfigModal instead of each creating their own isolated instance.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type PTTMethod = "COM" | "VOX";
export type PTTPin = "RTS" | "DTR";

export interface PTTConfig {
  method: PTTMethod;
  pin: PTTPin;
  invertVoltage: boolean;
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

interface PTTSerialContextValue {
  config: PTTConfig;
  setConfig: (cfg: PTTConfig) => void;
  isSupported: boolean;
  portOpen: boolean;
  portError: string | null;
  requestPort: () => Promise<boolean>;
  closePort: () => Promise<void>;
  keyDown: () => Promise<void>;
  keyUp: () => Promise<void>;
}

const PTTSerialContext = createContext<PTTSerialContextValue | null>(null);

export function PTTSerialProvider({ children }: { children: ReactNode }) {
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
    if (!isSupported) return;
    const cfg = loadConfig();
    if (cfg.method !== "COM") return;
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
        /* puerto ocupado o desconectado */
      }
    });
    return () => { cancelled = true; };
  }, [isSupported]);

  /* Close port when app unmounts */
  useEffect(() => {
    return () => {
      portRef.current?.close().catch(() => {});
    };
  }, []);

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

  const closePort = useCallback(async () => {
    if (portRef.current) {
      await portRef.current.close().catch(() => {});
      portRef.current = null;
      setPortOpen(false);
    }
  }, []);

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

  const keyUp = useCallback(async () => {
    if (config.method !== "COM" || !portRef.current) return;
    const idle = config.invertVoltage;
    try {
      if (config.pin === "RTS") {
        await portRef.current.setSignals({ requestToSend: idle });
      } else {
        await portRef.current.setSignals({ dataTerminalReady: idle });
      }
    } catch {
      /* puerto desconectado */
    }
  }, [config]);

  return (
    <PTTSerialContext.Provider
      value={{ config, setConfig, isSupported, portOpen, portError, requestPort, closePort, keyDown, keyUp }}
    >
      {children}
    </PTTSerialContext.Provider>
  );
}

export function usePTTSerial(): PTTSerialContextValue {
  const ctx = useContext(PTTSerialContext);
  if (!ctx) throw new Error("usePTTSerial debe usarse dentro de PTTSerialProvider");
  return ctx;
}
