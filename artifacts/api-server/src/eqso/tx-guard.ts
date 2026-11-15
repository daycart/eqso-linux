/** Per-connection limits. Releases are never rate-limited or postponed. */
export class TxGuard {
  active = false;
  private releasedAt = -Infinity;
  private starts: number[] = [];
  private audioUntil = 0;
  private notifiedAt = -Infinity;

  shouldNotify(now = performance.now()): boolean {
    if (now - this.notifiedAt < 500) return false;
    this.notifiedAt = now;
    return true;
  }

  start(now = performance.now()): "accepted" | "duplicate" | "limited" {
    if (this.active) return "duplicate";
    this.starts = this.starts.filter((time) => now - time < 5000);
    if (now - this.releasedAt < 500 || this.starts.length >= 6) return "limited";
    this.active = true;
    this.starts.push(now);
    this.audioUntil = now;
    return "accepted";
  }

  end(now = performance.now()): boolean {
    if (!this.active) return false;
    this.active = false;
    this.releasedAt = now;
    return true;
  }

  /** Allow normal packet bursts, but never queue over 600 ms of input audio. */
  audio(samples: number, now = performance.now()): boolean {
    if (!this.active || samples <= 0 || samples > 4096) return false;
    const until = Math.max(now, this.audioUntil) + samples / 8;
    if (until > now + 600) return false;
    this.audioUntil = until;
    return true;
  }
}
