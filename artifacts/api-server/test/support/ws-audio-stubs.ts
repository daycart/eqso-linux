// Test-only substitutes: no codec subprocesses, sockets, credentials or RF.
import { EventEmitter } from "node:events";

export const GSM_FRAME_SAMPLES = 160;
export const FRAMES_PER_PACKET = 6;
export const GSM_PACKET_BYTES = 198;

export class FfmpegGsmEncoder extends EventEmitter {
  static instances: FfmpegGsmEncoder[] = [];
  packets = 0;
  constructor() { super(); FfmpegGsmEncoder.instances.push(this); }
  start() {}
  stop() {}
  discardPending() {}
  encode() { this.packets++; }
}
export class FfmpegGsmDecoder extends EventEmitter {
  start() {}
  stop() {}
  decode() {}
}
export class EqsoProxy extends EventEmitter {
  static instances: EqsoProxy[] = [];
  starts = 0;
  releases = 0;
  packets = 0;
  constructor(..._args: unknown[]) { super(); EqsoProxy.instances.push(this); }
  connect() {}
  disconnect() {}
  sendJoin() {}
  startTransmitting() { this.starts++; }
  sendPttEnd() { this.releases++; }
  sendAudio() { this.packets++; }
}
export const inactivityManager = { recordActivity() {} };
export const moderationManager = { isMuted: () => false, isBanned: () => false };
export const validateSession = () => null;
export const createWebRelayCredential = () => { throw new Error("Unexpected relay credential in isolated test"); };
