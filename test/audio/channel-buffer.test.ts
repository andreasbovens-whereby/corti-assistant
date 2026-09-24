import { describe, expect, it } from "vitest";
import { ChannelBuffer } from "../../src/audio/channel-buffer.js";

const range = (from: number, to: number) => Int16Array.from({ length: to - from }, (_, i) => from + i);

describe("ChannelBuffer", () => {
  it("returns samples in order across ring wrap-around", () => {
    const buffer = new ChannelBuffer({ maxSamples: 10, trimToSamples: 5 });
    const out = new Int16Array(4);
    let next = 1;
    for (let round = 0; round < 20; round++) {
      buffer.write(range(next, next + 4));
      expect(buffer.read(out)).toBe(4);
      expect(Array.from(out)).toEqual(Array.from(range(next, next + 4)));
      next += 4;
    }
  });

  it("pads a short read with silence", () => {
    const buffer = new ChannelBuffer({ maxSamples: 10, trimToSamples: 5 });
    buffer.write(range(1, 4));
    const out = new Int16Array(6).fill(99);
    expect(buffer.read(out)).toBe(3);
    expect(Array.from(out)).toEqual([1, 2, 3, 0, 0, 0]);
    expect(buffer.length).toBe(0);
  });

  it("drops the oldest samples on overflow, keeping the newest", () => {
    const buffer = new ChannelBuffer({ maxSamples: 10, trimToSamples: 4 });
    expect(buffer.write(range(1, 9))).toBe(0);
    expect(buffer.write(range(9, 13))).toBe(8); // 12 > 10, so trim to the newest 4
    const out = new Int16Array(10);
    expect(buffer.read(out)).toBe(4);
    expect(Array.from(out.subarray(0, 4))).toEqual([9, 10, 11, 12]);
  });

  it("handles a single write larger than the buffer", () => {
    const buffer = new ChannelBuffer({ maxSamples: 10, trimToSamples: 3 });
    buffer.write(range(1, 3));
    expect(buffer.write(range(3, 50))).toBe(46);
    const out = new Int16Array(3);
    buffer.read(out);
    expect(Array.from(out)).toEqual([47, 48, 49]);
  });

  it("trimTo keeps only the newest samples", () => {
    const buffer = new ChannelBuffer({ maxSamples: 10, trimToSamples: 3 });
    buffer.write(range(1, 9));
    expect(buffer.trimTo(2)).toBe(6);
    const out = new Int16Array(2);
    buffer.read(out);
    expect(Array.from(out)).toEqual([7, 8]);
  });
});
