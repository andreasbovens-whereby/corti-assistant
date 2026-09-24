import { describe, expect, it } from "vitest";
import { Resampler } from "../../src/audio/resampler.js";
import { db, rms, sine, toneAmplitude } from "../helpers/signals.js";

const IN = 48_000;
const OUT = 16_000;
const AMPLITUDE = 16_000;

/** Resamples one second of a 48 kHz tone in 10 ms frames, like WebRTC delivers it. */
function resampleTone(frequency: number, seconds = 1): Int16Array {
  const resampler = new Resampler({ inputRate: IN, outputRate: OUT });
  const input = sine(frequency, IN, IN * seconds, AMPLITUDE);
  const parts: Int16Array[] = [];
  for (let i = 0; i < input.length; i += 480) parts.push(resampler.process(input.subarray(i, i + 480)));
  return concat(parts);
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Skips the filter's start-up transient. */
const steady = (samples: Int16Array) => samples.subarray(400);

describe("Resampler 48 kHz -> 16 kHz", () => {
  it("produces exactly one output sample per three input samples", () => {
    const resampler = new Resampler({ inputRate: IN, outputRate: OUT });
    for (let i = 0; i < 100; i++) expect(resampler.process(new Int16Array(480)).length).toBe(160);
  });

  it.each([300, 1000, 3000, 6500])("preserves a %d Hz tone's frequency and level", (frequency) => {
    const out = steady(resampleTone(frequency));
    const atTone = toneAmplitude(out, frequency, OUT);
    // Passband gain within 0.1 dB.
    expect(Math.abs(db(atTone / AMPLITUDE))).toBeLessThan(0.1);
    // Nearly all energy is at the input frequency: nothing else was created.
    const residual = Math.sqrt(Math.max(0, rms(out) ** 2 - (atTone / Math.SQRT2) ** 2));
    expect(db(residual / AMPLITUDE)).toBeLessThan(-60);
  });

  it.each([8500, 10_000, 12_000, 15_000, 20_000])("removes a %d Hz tone instead of aliasing it", (frequency) => {
    const out = steady(resampleTone(frequency));
    const alias = Math.abs(OUT - (frequency % OUT)) % OUT;
    // At 80 dB stopband attenuation, a -6 dBFS tone ends up well below 1 LSB of 16-bit audio.
    expect(db(rms(out) / AMPLITUDE)).toBeLessThan(-75);
    expect(toneAmplitude(out, alias, OUT)).toBeLessThan(2);
  });

  it("is a real test: naive decimation aliases a 10 kHz tone to 6 kHz", () => {
    const input = sine(10_000, IN, IN, AMPLITUDE);
    const naive = Int16Array.from({ length: IN / 3 }, (_, i) => input[i * 3]!);
    expect(toneAmplitude(naive, 6000, OUT)).toBeGreaterThan(AMPLITUDE * 0.9);
  });

  it("gives the same result whether fed in frames or all at once", () => {
    const input = sine(1234, IN, IN, AMPLITUDE);
    const whole = new Resampler({ inputRate: IN, outputRate: OUT }).process(input);
    const framed = new Resampler({ inputRate: IN, outputRate: OUT });
    const sizes = [480, 960, 7, 1, 480, 333];
    const parts: Int16Array[] = [];
    for (let i = 0, n = 0; i < input.length; n++) {
      const size = sizes[n % sizes.length]!;
      parts.push(framed.process(input.subarray(i, i + size)));
      i += size;
    }
    expect(concat(parts)).toEqual(whole);
  });

  it("reset() clears the filter state", () => {
    const resampler = new Resampler({ inputRate: IN, outputRate: OUT });
    resampler.process(sine(1000, IN, 4800, AMPLITUDE));
    resampler.reset();
    expect(resampler.process(new Int16Array(480)).every((s) => s === 0)).toBe(true);
  });

  it("clips instead of wrapping around on full-scale input", () => {
    const square = Int16Array.from({ length: IN }, (_, i) => (Math.floor(i / 24) % 2 === 0 ? 32767 : -32768));
    const out = new Resampler({ inputRate: IN, outputRate: OUT }).process(square);
    // A wrapped overflow would flip sign in the middle of a half period.
    for (let i = 400; i < out.length - 1; i++) expect(Math.abs(out[i]! - out[i + 1]!)).toBeLessThan(40000);
  });
});

describe("Resampler at other rates", () => {
  it("passes 16 kHz through unchanged", () => {
    const input = sine(1000, OUT, 160);
    expect(new Resampler({ inputRate: OUT, outputRate: OUT }).process(input)).toEqual(input);
  });

  it.each([
    [32_000, 1000],
    [44_100, 2000],
    [24_000, 5000],
  ])("converts %d Hz input and preserves a %d Hz tone", (rate, frequency) => {
    const resampler = new Resampler({ inputRate: rate, outputRate: OUT });
    const frame = rate / 100;
    const parts: Int16Array[] = [];
    for (let n = 0; n < 100; n++) parts.push(resampler.process(sine(frequency, rate, frame, AMPLITUDE, n * frame)));
    const out = concat(parts);
    expect(Math.abs(out.length - OUT)).toBeLessThanOrEqual(1);
    expect(Math.abs(db(toneAmplitude(steady(out), frequency, OUT) / AMPLITUDE))).toBeLessThan(0.1);
  });

  it("rejects invalid rates", () => {
    expect(() => new Resampler({ inputRate: 0, outputRate: OUT })).toThrow(RangeError);
    expect(() => new Resampler({ inputRate: 44_100.5, outputRate: OUT })).toThrow(RangeError);
  });
});
