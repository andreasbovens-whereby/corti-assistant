import type { Clock } from "../../src/audio/clock.js";

interface Pending {
  at: number;
  seq: number;
  callback: () => void;
}

/**
 * Virtual-time clock. Timers fire in time order when the test advances the clock.
 * `timerLateness` simulates a busy event loop: each timer fires that many ms after it's due.
 */
export class FakeClock implements Clock {
  timerLateness: () => number = () => 0;
  private time = 0;
  private seq = 0;
  private pending: Pending[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    return this.insert(this.time + Math.max(0, delayMs) + this.timerLateness(), callback);
  }

  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p.seq !== handle);
  }

  /** Runs `callback` at an exact time, without lateness (for simulated audio sources). */
  at(time: number, callback: () => void): void {
    this.insert(Math.max(time, this.time), callback);
  }

  advanceTo(time: number): void {
    while (this.pending.length > 0 && this.pending[0]!.at <= time) {
      const next = this.pending.shift()!;
      this.time = Math.max(this.time, next.at);
      next.callback();
    }
    this.time = Math.max(this.time, time);
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.time + ms);
  }

  /** Blocks the "event loop": time jumps forward without running anything in between. */
  stall(ms: number): void {
    this.time += ms;
  }

  private insert(at: number, callback: () => void): number {
    const entry = { at, seq: ++this.seq, callback };
    // Few timers are pending at once, so a sorted insert is plenty.
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1]!.at > at) i--;
    this.pending.splice(i, 0, entry);
    return entry.seq;
  }
}
