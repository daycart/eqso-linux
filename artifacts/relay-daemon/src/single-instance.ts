import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";

interface LockOwner {
  pid: number;
  startedAt: string;
}

export interface InstanceLock {
  lockPath: string;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM significa que el proceso existe, aunque este usuario no pueda
    // enviarle señales.
    return code === "EPERM";
  }
}

function readOwner(ownerPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Partial<LockOwner>;
    return typeof parsed.pid === "number"
      ? { pid: parsed.pid, startedAt: parsed.startedAt ?? "desconocido" }
      : null;
  } catch {
    return null;
  }
}

/**
 * Garantiza una sola instancia por archivo de configuración.
 *
 * mkdir es atómico en Windows y Linux. Si un cierre forzado deja el directorio
 * atrás, se elimina únicamente cuando el PID propietario ya no existe.
 */
export function acquireInstanceLock(configPath: string): InstanceLock {
  const absoluteConfigPath = path.resolve(configPath);
  const configHash = crypto
    .createHash("sha256")
    .update(absoluteConfigPath.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  const lockPath = path.join(os.tmpdir(), `eqso-relay-${configHash}.running`);
  const ownerPath = `${lockPath}/owner.json`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockPath);
      const owner: LockOwner = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(ownerPath, JSON.stringify(owner), { encoding: "utf8" });

      let released = false;
      return {
        lockPath,
        release(): void {
          if (released) return;
          released = true;
          fs.rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      const owner = readOwner(ownerPath);
      if (!owner || processIsAlive(owner.pid)) {
        throw new Error(
          `Ya existe otra instancia para ${absoluteConfigPath} ` +
          (owner
            ? `(PID ${owner.pid}, iniciada ${owner.startedAt})`
            : "(bloqueo en inicialización)"),
        );
      }

      // Bloqueo huérfano de un proceso terminado a la fuerza.
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  throw new Error(`No se pudo adquirir el bloqueo de instancia ${lockPath}`);
}