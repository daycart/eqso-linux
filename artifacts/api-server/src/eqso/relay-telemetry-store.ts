import { EventEmitter } from "events";

export interface RelayTelemetry {
  callsign: string;
  voxActive: boolean;
  rmsLevel: number;
  txPackets: number;
  rxPackets: number;
  /** 0 = idle, 1 = TX (relay transmitting to server), 2 = RX (receiving from server) */
  pttState: 0 | 1 | 2;
  uptimeSeconds: number;
  receivedAt: number;
  /** VOX trigger threshold (RMS units). Present for daemons running v1.3+. */
  voxThresholdRms?: number;
}

export interface RelayTelemetryChange {
  type: "update" | "remove";
  callsign: string;
  data?: RelayTelemetry;
}

class RelayTelemetryStore extends EventEmitter {
  private store = new Map<string, RelayTelemetry>();

  update(callsign: string, data: Omit<RelayTelemetry, "callsign" | "receivedAt">): void {
    const entry: RelayTelemetry = { callsign, ...data, receivedAt: Date.now() };
    this.store.set(callsign.toUpperCase(), entry);
    this.emit("change", { type: "update", callsign: callsign.toUpperCase(), data: entry } satisfies RelayTelemetryChange);
  }

  get(callsign: string): RelayTelemetry | null {
    return this.store.get(callsign.toUpperCase()) ?? null;
  }

  getAll(): RelayTelemetry[] {
    return [...this.store.values()];
  }

  remove(callsign: string): void {
    this.store.delete(callsign.toUpperCase());
    this.emit("change", { type: "remove", callsign: callsign.toUpperCase() } satisfies RelayTelemetryChange);
  }

  isStale(callsign: string, maxAgeMs = 15_000): boolean {
    const t = this.store.get(callsign.toUpperCase());
    if (!t) return true;
    return Date.now() - t.receivedAt > maxAgeMs;
  }
}

export const relayTelemetryStore = new RelayTelemetryStore();
