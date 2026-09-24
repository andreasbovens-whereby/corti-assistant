import { describe, expect, it } from "vitest";
import { Ticker, type Tick } from "../../src/audio/clock.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { seededRandom } from "../helpers/signals.js";

function setup(options: { maxLagMs?: number } = {}) {
  const clock = new FakeClock();
  const ticks: Tick[] = [];
  const skips: number[] = [];
  const ticker = new Ticker({
    clock,
    periodMs: 250,
    onTick: (tick) => ticks.push(tick),
    onSkip: (skipped) => skips.push(skipped),
    ...options,
  });
  return { clock, ticks, skips, ticker };
}

describe("Ticker", () => {
  it("doesn't drift over 60 minutes of late timers", () => {
    const { clock, ticks, ticker } = setup();
    const random = seededRandom(1);
    // Every timer fires 0-40 ms late. A naive setInterval-style loop would drift by
    // about 20 ms per tick: 72 s over an hour.
    clock.timerLateness = () => random() * 40;
    ticker.start();
    clock.advanceTo(60 * 60 * 1000 + 100);

    expect(ticks).toHaveLength(14_400);
    ticks.forEach((tick, n) => {
      expect(tick.index).toBe(n);
      expect(tick.scheduledAt).toBe((n + 1) * 250);
      expect(tick.firedAt).toBeGreaterThanOrEqual(tick.scheduledAt);
      expect(tick.firedAt - tick.scheduledAt).toBeLessThanOrEqual(40);
    });
  });

  it("catches up on a short stall", () => {
    const { clock, ticks, skips, ticker } = setup();
    ticker.start();
    clock.advanceTo(1000); // 4 ticks
    clock.stall(600); // blocked event loop: ticks 5 and 6 are overdue
    clock.advanceTo(1600);
    expect(ticks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ticks[4]!.firedAt).toBe(1600);
    expect(ticks[5]!.firedAt).toBe(1600);
    expect(skips).toEqual([]);
  });

  it("skips ahead after a long stall instead of bursting", () => {
    const { clock, ticks, skips, ticker } = setup({ maxLagMs: 1000 });
    ticker.start();
    clock.advanceTo(1000);
    clock.stall(3000);
    clock.advanceTo(4000);
    // Ticks 4-14 were missed. Only the latest is emitted, and the timeline stays on the grid.
    expect(skips).toEqual([11]);
    expect(ticks.map((t) => t.index)).toEqual([0, 1, 2, 3, 15]);
    clock.advanceTo(4250);
    expect(ticks.at(-1)).toMatchObject({ index: 16, scheduledAt: 4250 });
  });

  it("stops cleanly", () => {
    const { clock, ticks, ticker } = setup();
    ticker.start();
    clock.advanceTo(500);
    ticker.stop();
    clock.advanceTo(5000);
    expect(ticks).toHaveLength(2);
    expect(ticker.isRunning).toBe(false);
  });
});
