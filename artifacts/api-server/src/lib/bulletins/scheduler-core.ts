import type { BulletinScheduleInput, BulletinScheduleEvent } from "@workspace/api-zod";

type StoredScheduleEvent = Omit<BulletinScheduleEvent, "at"> & { at: string };
type ScheduleStatus = ScheduleState & { generationRunning: boolean; transmissionRunning: boolean };

export const DEFAULT_SCHEDULE: BulletinScheduleInput = {
  generationEnabled: false, transmissionEnabled: false,
  generationIntervalMinutes: 180, transmissionIntervalMinutes: 60,
  maxAgeMinutes: 360, room: "",
};

export interface ScheduleState {
  config: BulletinScheduleInput;
  nextGenerationAt: string | null;
  nextTransmissionAt: string | null;
  lastGeneration: StoredScheduleEvent | null;
  lastTransmission: StoredScheduleEvent | null;
}

export interface ScheduledBulletin {
  generatedAt: string;
  sourceRetrievedAt: string;
  forecastDates: string[];
}

export interface SchedulerDependencies {
  now(): number;
  save(state: ScheduleState): Promise<void>;
  generate(): Promise<unknown>;
  current(): Promise<ScheduledBulletin | undefined>;
  transmit(bulletin: ScheduledBulletin, room: string): Promise<"completed" | "rejected">;
  rooms(): string[];
}

export class BulletinScheduler {
  private state: ScheduleState = {
    config: { ...DEFAULT_SCHEDULE },
    nextGenerationAt: null, nextTransmissionAt: null,
    lastGeneration: null, lastTransmission: null,
  };
  private queue: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private generationRunning = false;
  private transmissionRunning = false;

  constructor(private readonly dependencies: SchedulerDependencies) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private next(minutes: number): string {
    return new Date(this.dependencies.now() + minutes * 60_000).toISOString();
  }

  /** Persist first: a failed write must never enable an unrecorded RF schedule. */
  private async commit(state: ScheduleState): Promise<void> {
    await this.dependencies.save(state);
    this.state = state;
  }

  async initialize(saved?: ScheduleState): Promise<void> {
    await this.serialized(async () => {
      const state = saved ?? this.state;
      // Start a new interval on restart; never catch up missed emissions.
      await this.commit({
        ...state,
        nextGenerationAt: state.config.generationEnabled ? this.next(state.config.generationIntervalMinutes) : null,
        nextTransmissionAt: state.config.transmissionEnabled ? this.next(state.config.transmissionIntervalMinutes) : null,
      });
    });
  }

  async configure(input: BulletinScheduleInput): Promise<ScheduleStatus> {
    return this.serialized(async () => {
      if (input.transmissionEnabled && (!input.confirmed || !this.dependencies.rooms().includes(input.room))) {
        throw new Error("Seleccione una sala válida y confirme las emisiones RF automáticas");
      }
      const { confirmed: _confirmation, ...config } = input;
      await this.commit({
        ...this.state, config,
        nextGenerationAt: config.generationEnabled ? this.next(config.generationIntervalMinutes) : null,
        nextTransmissionAt: config.transmissionEnabled ? this.next(config.transmissionIntervalMinutes) : null,
      });
      return this.status();
    });
  }

  status(): ScheduleStatus {
    return structuredClone({
      ...this.state,
      generationRunning: this.generationRunning,
      transmissionRunning: this.transmissionRunning,
    });
  }

  private async record(kind: "lastGeneration" | "lastTransmission", status: BulletinScheduleEvent["status"], message: string) {
    await this.serialized(() => this.commit({
      ...this.state,
      [kind]: { at: new Date(this.dependencies.now()).toISOString(), status, message },
    }));
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.serialized(async () => {
        const now = this.dependencies.now();
        const state = this.state;
        const generation = state.config.generationEnabled && !!state.nextGenerationAt && Date.parse(state.nextGenerationAt) <= now;
        const transmission = state.config.transmissionEnabled && !!state.nextTransmissionAt && Date.parse(state.nextTransmissionAt) <= now;
        if (generation || transmission) {
          await this.commit({
            ...state,
            nextGenerationAt: generation ? this.next(state.config.generationIntervalMinutes) : state.nextGenerationAt,
            nextTransmissionAt: transmission ? this.next(state.config.transmissionIntervalMinutes) : state.nextTransmissionAt,
          });
        }
        return { generation, transmission, config: { ...state.config } };
      });

      let generationFailed = false;
      if (due.generation && this.state.config.generationEnabled) {
        this.generationRunning = true;
        try {
          await this.dependencies.generate();
          await this.record("lastGeneration", "completed", "Boletín creado automáticamente");
        } catch (error) {
          generationFailed = true;
          await this.record("lastGeneration", "failed", error instanceof Error ? error.message : "Error de generación");
        } finally {
          this.generationRunning = false;
        }
      }

      if (!due.transmission) return;
      // A disable or configuration change while generating cancels the unstarted emission.
      if (!this.state.config.transmissionEnabled || JSON.stringify(due.config) !== JSON.stringify(this.state.config)) {
        await this.record("lastTransmission", "skipped", "Programación modificada antes de emitir");
        return;
      }
      if (generationFailed) {
        await this.record("lastTransmission", "skipped", "No se emite: falló la actualización de este ciclo");
        return;
      }
      this.transmissionRunning = true;
      try {
        const bulletin = await this.dependencies.current();
        const now = this.dependencies.now();
        const maxAge = this.state.config.maxAgeMinutes * 60_000;
        const today = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date(now));
        const fresh = bulletin && [bulletin.generatedAt, bulletin.sourceRetrievedAt].every(time => {
          const age = now - Date.parse(time);
          return Number.isFinite(age) && age >= 0 && age <= maxAge;
        }) && bulletin.forecastDates.includes(today);
        if (!fresh) {
          await this.record("lastTransmission", "skipped", "No hay un boletín vigente; no se transmite");
        } else if (!this.state.config.transmissionEnabled || JSON.stringify(due.config) !== JSON.stringify(this.state.config)) {
          await this.record("lastTransmission", "skipped", "Programación modificada antes de emitir");
        } else if (!this.dependencies.rooms().includes(due.config.room)) {
          await this.record("lastTransmission", "skipped", "La sala configurada ya no está disponible");
        } else {
          const result = await this.dependencies.transmit(bulletin!, due.config.room);
          await this.record("lastTransmission", result === "completed" ? "completed" : "skipped",
            result === "completed" ? "Boletín emitido automáticamente" : "Sala ocupada; se omite hasta el próximo ciclo");
        }
      } catch (error) {
        await this.record("lastTransmission", "failed", error instanceof Error ? error.message : "Error de transmisión");
      } finally {
        this.transmissionRunning = false;
      }
    } finally {
      this.ticking = false;
    }
  }
}
