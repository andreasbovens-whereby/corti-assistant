import { describe, expect, it } from "vitest";
import {
  AudioPipeline,
  audioFormat,
  CHUNK_MS,
  downmix,
  SAMPLES_PER_CHUNK,
  type Chunk,
} from "../../src/audio/pipeline.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { deinterleave, seededRandom, sine, toneAmplitude } from "../helpers/signals.js";

const WEBRTC_RATE = 48_000;
const FRAME_MS = 10;

interface Source {
  channel: number;
  /** Defaults to one source per channel. */
  sourceId?: string;
  /** Returns the frame's samples (mono), or null to stop sending. */
  frame: (index: number) => Int16Array | null;
  sampleRate?: number;
  /** Extra delay before frame n arrives. Arrival order is preserved, like a FIFO network path. */
  jitterMs?: () => number;
  startMs?: number;
}

/** Simulates WebRTC delivering 10 ms frames per participant on the fake clock. */
function feed(clock: FakeClock, pipeline: AudioPipeline, source: Source): void {
  const { channel, frame, sampleRate = WEBRTC_RATE, jitterMs = () => 0, startMs = 0 } = source;
  const sourceId = source.sourceId ?? `source-${channel}`;
  pipeline.addSource(sourceId, channel);
  let lastArrival = 0;
  const schedule = (n: number) => {
    const arrival = Math.max(lastArrival, startMs + (n + 1) * FRAME_MS + jitterMs());
    lastArrival = arrival;
    clock.at(arrival, () => {
      const samples = frame(n);
      if (samples === null) return;
      pipeline.pushFrame(sourceId, { samples, sampleRate, channelCount: 1, bitsPerSample: 16 });
      schedule(n + 1);
    });
  };
  schedule(0);
}

const toneSource = (channel: number, frequency: number, stopAtMs = Infinity): Source => {
  const frameSamples = (WEBRTC_RATE * FRAME_MS) / 1000;
  return {
    channel,
    frame: (n) => (n * FRAME_MS >= stopAtMs ? null : sine(frequency, WEBRTC_RATE, frameSamples, 16000, n * frameSamples)),
  };
};

function setup(channelCount = 2) {
  const clock = new FakeClock();
  const logger = recordingLogger();
  const chunks: (Chunk & { at: number })[] = [];
  const pipeline = new AudioPipeline({
    channelCount,
    clock,
    logger,
    onChunk: (chunk) => chunks.push({ ...chunk, at: clock.now() }),
  });
  return { clock, logger, chunks, pipeline };
}

describe("AudioPipeline", () => {
  it("emits 250 ms interleaved stereo chunks with each participant on its own channel", () => {
    const { clock, chunks, pipeline } = setup();
    feed(clock, pipeline, toneSource(0, 440));
    feed(clock, pipeline, toneSource(1, 1000));
    pipeline.start();
    clock.advanceTo(2000);

    expect(chunks).toHaveLength(8);
    chunks.forEach((chunk, n) => {
      expect(chunk.index).toBe(n);
      expect(chunk.at).toBe((n + 1) * CHUNK_MS);
      expect(chunk.data.length).toBe(SAMPLES_PER_CHUNK * 2 * 2); // 4000 frames x 2 channels x 16 bit
    });

    const [doctor, patient] = deinterleave(chunks[4]!.data, 2);
    expect(toneAmplitude(doctor!, 440, 16_000)).toBeGreaterThan(15_000);
    expect(toneAmplitude(doctor!, 1000, 16_000)).toBeLessThan(50);
    expect(toneAmplitude(patient!, 1000, 16_000)).toBeGreaterThan(15_000);
    expect(toneAmplitude(patient!, 440, 16_000)).toBeLessThan(50);
  });

  it("pads with silence when one side stops, without disturbing the other", () => {
    const { clock, chunks, pipeline } = setup();
    feed(clock, pipeline, toneSource(0, 440));
    feed(clock, pipeline, toneSource(1, 1000, 2000)); // patient mutes or drops after 2 s
    pipeline.start();
    clock.advanceTo(5000);

    expect(chunks).toHaveLength(20);
    chunks.forEach((chunk, n) => expect(chunk.at).toBe((n + 1) * CHUNK_MS)); // cadence unaffected
    for (const chunk of chunks.slice(9)) {
      const [doctor, patient] = deinterleave(chunk.data, 2);
      expect(chunk.paddedSamples).toEqual([0, SAMPLES_PER_CHUNK]);
      expect(patient!.every((s) => s === 0)).toBe(true);
      expect(toneAmplitude(doctor!, 440, 16_000)).toBeGreaterThan(15_000);
    }
    expect(pipeline.stats().channels[1]!.paddedSamples).toBeGreaterThanOrEqual(12 * SAMPLES_PER_CHUNK);
  });

  it("sends silence for a channel whose participant hasn't joined yet", () => {
    const { clock, chunks, pipeline } = setup();
    feed(clock, pipeline, toneSource(0, 440));
    feed(clock, pipeline, { ...toneSource(1, 1000), startMs: 1500 });
    pipeline.start();
    clock.advanceTo(3000);

    // The doctor may miss the one frame that arrives at the same instant as the first tick.
    expect(chunks[0]!.paddedSamples[0]).toBeLessThanOrEqual(160);
    expect(chunks[0]!.paddedSamples[1]).toBe(SAMPLES_PER_CHUNK);
    const [, patientLater] = deinterleave(chunks[9]!.data, 2);
    expect(toneAmplitude(patientLater!, 1000, 16_000)).toBeGreaterThan(15_000);
  });

  it("stays aligned and at real-time speed over a simulated 60-minute call", () => {
    const { clock, chunks, pipeline, logger } = setup();
    const random = seededRandom(42);
    clock.timerLateness = () => random() * 20;

    // Each sample carries its own capture index, so the output shows exactly which moment
    // of each participant's audio ended up at each output position. 16 kHz sources skip
    // resampling (tested separately) to keep an hour of audio fast to simulate.
    const WRAP = 30_000;
    const indexSource = (channel: number, jitter: number): Source => ({
      channel,
      sampleRate: 16_000,
      jitterMs: () => random() * jitter,
      frame: (n) => {
        const samples = new Int16Array(160);
        for (let i = 0; i < 160; i++) samples[i] = ((n * 160 + i) % WRAP) + 1;
        return samples;
      },
    });
    feed(clock, pipeline, indexSource(0, 15));
    feed(clock, pipeline, indexSource(1, 5));

    // For each channel, (output position - capture index) is the delay added by the
    // pipeline. Alignment means both channels have (almost) the same delay.
    const minute = (60 * 1000) / CHUNK_MS;
    const worstSkewByMinute: number[] = [];
    let worstSkew = 0;
    let worstDelay = 0;
    const delay = new Array<number>(2).fill(0);
    let chunksChecked = 0;
    const check = (chunk: Chunk) => {
      const channels = deinterleave(chunk.data, 2);
      for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
        const position = chunk.index * SAMPLES_PER_CHUNK + i;
        for (let c = 0; c < 2; c++) {
          const value = channels[c]![i]!;
          if (value !== 0) delay[c] = (((position - (value - 1)) % WRAP) + WRAP) % WRAP;
        }
        worstSkew = Math.max(worstSkew, Math.abs(delay[0]! - delay[1]!));
        worstDelay = Math.max(worstDelay, delay[0]!, delay[1]!);
      }
      if (++chunksChecked % minute === 0) {
        worstSkewByMinute.push(worstSkew);
        worstSkew = 0;
      }
    };

    pipeline.start();
    const hourMs = 60 * 60 * 1000;
    for (let t = 0; t < hourMs; t += 60_000) {
      clock.advanceTo(t + 60_000 + 25); // allow for the last tick's timer lateness
      chunks.splice(0).forEach(check);
    }

    // Real-time speed: exactly 4 chunks per second, every chunk accounted for.
    expect(chunksChecked).toBe(14_400);
    expect(pipeline.stats().chunksSent).toBe(14_400);
    // Alignment: audio arrives in whole 10 ms frames, so a tick can miss up to the worst
    // jitter (15 ms) rounded up to a frame, plus one frame: 25 ms = 400 samples. The
    // channels never drift further apart than that, and minute 60 is no worse than minute 1.
    const bound = 400;
    expect(worstSkewByMinute).toHaveLength(60);
    expect(Math.max(...worstSkewByMinute)).toBeLessThanOrEqual(bound);
    expect(Math.max(...worstSkewByMinute.slice(-10))).toBeLessThanOrEqual(Math.max(...worstSkewByMinute.slice(0, 10)));
    // Latency stays bounded (no slow build-up), and nothing had to be dropped.
    expect(worstDelay).toBeLessThanOrEqual(bound);
    expect(pipeline.stats().channels.every((c) => c.droppedSamples === 0)).toBe(true);
    expect(logger.entries.filter((e) => e.level === "warn")).toEqual([]);
  }, 30_000); // an hour of audio in virtual time takes a few seconds of real CPU

  it("mixes several sources on one channel (extra participants join the patient channel)", () => {
    const { clock, chunks, pipeline } = setup();
    feed(clock, pipeline, toneSource(0, 440));
    feed(clock, pipeline, { ...toneSource(1, 1000), sourceId: "patient" });
    feed(clock, pipeline, { ...toneSource(1, 2500), sourceId: "relative" });
    pipeline.start();
    clock.advanceTo(1000);

    const [doctor, patientChannel] = deinterleave(chunks[2]!.data, 2);
    expect(toneAmplitude(doctor!, 440, 16_000)).toBeGreaterThan(15_000);
    expect(toneAmplitude(doctor!, 2500, 16_000)).toBeLessThan(50);
    // Both people are on channel 1, at full level, and the chunk isn't twice as long.
    expect(toneAmplitude(patientChannel!, 1000, 16_000)).toBeGreaterThan(15_000);
    expect(toneAmplitude(patientChannel!, 2500, 16_000)).toBeGreaterThan(15_000);
    expect(chunks[2]!.data.length).toBe(SAMPLES_PER_CHUNK * 2 * 2);
    expect(pipeline.stats().channels.map((c) => c.sources)).toEqual([1, 2]);
  });

  it("clips a loud mix instead of wrapping around", () => {
    const { clock, chunks, pipeline } = setup(1);
    const loud = new Int16Array(SAMPLES_PER_CHUNK).fill(30_000);
    for (const id of ["a", "b"]) {
      pipeline.addSource(id, 0);
      pipeline.pushFrame(id, { samples: loud, sampleRate: 16_000, channelCount: 1 });
    }
    pipeline.start();
    clock.advanceTo(250);
    expect(deinterleave(chunks[0]!.data, 1)[0]!.every((s) => s === 32_767)).toBe(true);
  });

  it("plays out a removed source's buffered audio, then forgets it", () => {
    const { clock, chunks, pipeline } = setup(1);
    pipeline.addSource("patient", 0);
    pipeline.start();
    pipeline.pushFrame("patient", { samples: new Int16Array(2000).fill(5), sampleRate: 16_000, channelCount: 1 });
    pipeline.removeSource("patient");
    pipeline.pushFrame("patient", { samples: new Int16Array(160).fill(9), sampleRate: 16_000, channelCount: 1 });
    clock.advanceTo(500);

    const first = deinterleave(chunks[0]!.data, 1)[0]!;
    expect(first.subarray(0, 2000).every((s) => s === 5)).toBe(true); // buffered audio kept
    expect(first.subarray(2000).every((s) => s === 0)).toBe(true); // frames after removal ignored
    expect(pipeline.stats().channels[0]!.sources).toBe(0);
    // The id can be registered again, e.g. when the participant comes back.
    expect(() => pipeline.addSource("patient", 0)).not.toThrow();
  });

  it("drops the oldest audio and warns when a buffer grows beyond 1 s", () => {
    const { clock, chunks, pipeline, logger } = setup();
    pipeline.start();
    clock.advanceTo(1000);
    // A burst: 2 s of audio for channel 0 arrives at once (e.g. after a network stall).
    const burst = Int16Array.from({ length: 32_000 }, (_, i) => (i < 28_000 ? 1 : 2));
    pipeline.addSource("doctor", 0);
    pipeline.pushFrame("doctor", { samples: burst, sampleRate: 16_000, channelCount: 1 });

    const stats = pipeline.stats().channels[0]!;
    expect(stats.droppedSamples).toBe(28_000);
    expect(stats.bufferedSamples).toBe(SAMPLES_PER_CHUNK);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("overflow"), fields: { sourceId: "doctor", channel: 0, droppedMs: 1750 } }),
    );

    // Only the newest audio survives, and it goes out in the very next chunk.
    clock.advanceTo(1250);
    const [channel0] = deinterleave(chunks.at(-1)!.data, 2);
    expect(channel0!.every((s) => s === 2)).toBe(true);
  });

  it("sends nothing before start and starts from recent audio", () => {
    const { clock, chunks, pipeline, logger } = setup();
    feed(clock, pipeline, toneSource(0, 440));
    clock.advanceTo(3000); // waiting for Corti to accept the config
    expect(chunks).toEqual([]);
    expect(logger.entries).toEqual([]); // overflow while waiting is expected, not a warning

    pipeline.start();
    expect(pipeline.stats().channels[0]!.bufferedSamples).toBeLessThanOrEqual(SAMPLES_PER_CHUNK);
    clock.advanceTo(3250);
    expect(chunks).toHaveLength(1);
  });

  it("downmixes multichannel frames to mono", () => {
    expect(Array.from(downmix(Int16Array.from([100, 300, -50, 50, 7, 8]), 2))).toEqual([200, 0, 8]);
    const { clock, chunks, pipeline } = setup(1);
    pipeline.start();
    const left = sine(440, 48_000, 480 * 25);
    const stereo = new Int16Array(left.length * 2);
    left.forEach((s, i) => {
      stereo[i * 2] = s;
      stereo[i * 2 + 1] = s;
    });
    pipeline.addSource("doctor", 0);
    pipeline.pushFrame("doctor", { samples: stereo, sampleRate: 48_000, channelCount: 2, bitsPerSample: 16 });
    clock.advanceTo(250);
    expect(toneAmplitude(deinterleave(chunks[0]!.data, 1)[0]!.subarray(200, 3800), 440, 16_000)).toBeGreaterThan(15_000);
  });

  it("ignores frames that aren't 16-bit and warns once", () => {
    const { pipeline, logger } = setup();
    pipeline.addSource("doctor", 0);
    for (let i = 0; i < 3; i++) {
      pipeline.pushFrame("doctor", { samples: new Int16Array(480), sampleRate: 48_000, channelCount: 1, bitsPerSample: 8 });
    }
    expect(pipeline.stats().channels[0]!.receivedSamples).toBe(0);
    expect(logger.entries.filter((e) => e.level === "warn")).toHaveLength(1);
  });

  it("keeps the clock running when the chunk consumer throws", () => {
    const clock = new FakeClock();
    const logger = recordingLogger();
    let calls = 0;
    const pipeline = new AudioPipeline({
      channelCount: 2,
      clock,
      logger,
      onChunk: () => {
        calls++;
        throw new Error("socket closed");
      },
    });
    pipeline.start();
    clock.advanceTo(1000);
    expect(calls).toBe(4);
    expect(logger.entries.filter((e) => e.level === "error")).toHaveLength(4);
  });

  it("validates channel numbers", () => {
    expect(() => new AudioPipeline({ channelCount: 0, onChunk: () => {} })).toThrow(RangeError);
    expect(() => new AudioPipeline({ channelCount: 9, onChunk: () => {} })).toThrow(RangeError);
    const { pipeline } = setup(2);
    expect(() => pipeline.addSource("third", 2)).toThrow(RangeError);
    pipeline.addSource("doctor", 0);
    expect(() => pipeline.addSource("doctor", 1)).toThrow(/already registered/);
    // Frames for unknown sources (e.g. a track that was just removed) are ignored.
    expect(() => pipeline.pushFrame("nobody", { samples: new Int16Array(160), sampleRate: 16_000, channelCount: 1 })).not.toThrow();
  });

  it("describes its output format for the Corti stream config", () => {
    expect(audioFormat(2)).toBe("audio/pcm; rate=16000; channels=2; bits=16; endian=little; encoding=sint");
  });
});
