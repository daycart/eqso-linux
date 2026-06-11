export interface RelayTelemetry {
  callsign: string;
  voxActive: boolean;
  rmsLevel: number;
  txPackets: number;
  rxPackets: number;
  receivedAt: number;
}

class RelayTelemetryStore {
  private store = new Map<string, RelayTelemetry>();

  update(callsign: string, data: Omit<RelayTelemetry, "callsign" | "receivedAt">): void {
    this.store.set(callsign.toUpperCase(), {
      callsign,
      ...data,
      receivedAt: Date.now(),
    });
  }

  get(callsign: string): RelayTelemetry | null {
    return this.store.get(callsign.toUpperCase()) ?? null;
  }

  getAll(): RelayTelemetry[] {
    return [...this.store.values()];
  }

  remove(callsign: string): void {
    this.store.delete(callsign.toUpperCase());
  }

  isStale(callsign: string, maxAgeMs = 15_000): boolean {
    const t = this.store.get(callsign.toUpperCase());
    if (!t) return true;
    return Date.now() - t.receivedAt > maxAgeMs;
  }
}

export const relayTelemetryStore = new RelayTelemetryStore();
