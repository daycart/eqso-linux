/** Bound work in codec pipes, including bytes already accepted by the OS. */
export class AudioBacklog {
  private pending: number[] = [];

  accept(now = performance.now()): boolean {
    if (this.pending.length >= 8) return false;
    this.pending.push(now);
    return true;
  }

  complete(now = performance.now()): boolean {
    const submitted = this.pending.shift();
    return submitted !== undefined && now - submitted <= 1200;
  }

  invalidate(): void {
    this.pending.fill(-Infinity);
  }

  clear(): void {
    this.pending = [];
  }
}
