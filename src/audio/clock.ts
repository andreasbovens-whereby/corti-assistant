/** Time source and timers. Injected so tests can run a 60-minute call in virtual time. */
export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface Tick {
  /** 0 for the first tick after start. */
  index: number;
  /** When the tick was due. */
  scheduledAt: number;
  /** When it actually ran. */
  firedAt: number;
}

export interface TickerOptions {
  clock: Clock;
  periodMs: number;
  onTick: (tick: Tick) => void;
  /**
   * If the ticker falls further behind than this (for example, the event loop was
   * blocked), it skips the missed ticks instead of catching up in a burst.
   */
  maxLagMs?: number;
  onSkip?: (skippedTicks: number, lagMs: number) => void;
}

/**
 * Fixed-rate ticker that doesn't drift.
 *
 * Tick n is due at start + (n + 1) * period, computed from the start time, not from the
 * previous tick. A late timer delays one tick but not the ones after it, so the long-run
 * rate is exactly one tick per period. A few late ticks are caught up immediately;
 * falling more than `maxLagMs` behind skips ahead instead.
 */
export class Ticker {
  private readonly clock: Clock;
  private readonly periodMs: number;
  private readonly maxLagMs: number;
  private readonly onTick: (tick: Tick) => void;
  private readonly onSkip: ((skippedTicks: number, lagMs: number) => void) | undefined;
  private startedAt = 0;
  private nextIndex = 0;
  private timer: unknown = undefined;
  private running = false;

  constructor({ clock, periodMs, onTick, maxLagMs = 1000, onSkip }: TickerOptions) {
    this.clock = clock;
    this.periodMs = periodMs;
    this.maxLagMs = maxLagMs;
    this.onTick = onTick;
    this.onSkip = onSkip;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.clock.now();
    this.nextIndex = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private dueAt(index: number): number {
    return this.startedAt + (index + 1) * this.periodMs;
  }

  private schedule(): void {
    const delay = Math.max(0, this.dueAt(this.nextIndex) - this.clock.now());
    this.timer = this.clock.setTimeout(() => this.fire(), delay);
  }

  private fire(): void {
    this.timer = undefined;
    const now = this.clock.now();
    const lag = now - this.dueAt(this.nextIndex);

    if (lag > this.maxLagMs) {
      // Jump to the most recent due tick and run only that one.
      const latest = Math.floor((now - this.startedAt) / this.periodMs) - 1;
      this.onSkip?.(latest - this.nextIndex, lag);
      this.nextIndex = latest;
    }

    while (this.running && this.dueAt(this.nextIndex) <= now) {
      const index = this.nextIndex++;
      this.onTick({ index, scheduledAt: this.dueAt(index), firedAt: now });
    }
    if (this.running) this.schedule();
  }
}
