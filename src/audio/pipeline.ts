import { silentLogger, type Logger } from "../logger.js";
import { ChannelBuffer } from "./channel-buffer.js";
import { systemClock, Ticker, type Clock, type Tick } from "./clock.js";
import { Resampler } from "./resampler.js";

/** Corti's recommended stream format: 16 kHz, 16-bit little-endian, about 250 ms per chunk. */
export const OUTPUT_SAMPLE_RATE = 16_000;
export const CHUNK_MS = 250;
export const SAMPLES_PER_CHUNK = (OUTPUT_SAMPLE_RATE * CHUNK_MS) / 1000;
/** Corti accepts up to 8 channels. */
export const MAX_CHANNELS = 8;

/** MIME type for the stream config's `audioFormat`, matching what the pipeline emits. */
export function audioFormat(channelCount: number): string {
  return `audio/pcm; rate=${OUTPUT_SAMPLE_RATE}; channels=${channelCount}; bits=16; endian=little; encoding=sint`;
}

/** One frame as delivered by the Whereby SDK's `AudioSink`. */
export interface AudioFrame {
  samples: Int16Array;
  sampleRate: number;
  channelCount: number;
  bitsPerSample?: number;
  numberOfFrames?: number;
}

export interface Chunk {
  /** Interleaved 16-bit little-endian PCM, `SAMPLES_PER_CHUNK` frames of `channelCount` samples. */
  data: Buffer;
  index: number;
  /** Per channel, how many samples of this chunk are padding. */
  paddedSamples: number[];
}

export interface ChannelStats {
  receivedSamples: number;
  paddedSamples: number;
  droppedSamples: number;
  bufferedSamples: number;
}

export interface AudioPipelineOptions {
  channelCount: number;
  onChunk: (chunk: Chunk) => void;
  clock?: Clock;
  logger?: Logger;
  /** A channel holding more than this is overflowing (default 1000 ms). */
  maxBufferMs?: number;
  /** On overflow, keep only this much of the newest audio (default one chunk). */
  trimToMs?: number;
}

interface ChannelState {
  buffer: ChannelBuffer;
  resampler: Resampler | undefined;
  scratch: Int16Array;
  stats: Omit<ChannelStats, "bufferedSamples">;
}

/**
 * Turns per-participant WebRTC audio into one multichannel stream at real-time speed.
 *
 * Each channel is downmixed to mono, resampled to 16 kHz and buffered. A clock that
 * doesn't depend on incoming audio takes one chunk from every channel every 250 ms,
 * pads channels that are short with silence, and interleaves the result. Because all
 * channels are read at the same instant, they stay aligned: a channel that stops
 * (muted, left, packet loss) becomes silence instead of shifting the others.
 */
export class AudioPipeline {
  readonly channelCount: number;
  private readonly channels: ChannelState[];
  private readonly ticker: Ticker;
  private readonly onChunk: (chunk: Chunk) => void;
  private readonly logger: Logger;
  private readonly trimToSamples: number;
  private chunksSent = 0;
  private rejectedFormatLogged = false;

  constructor({
    channelCount,
    onChunk,
    clock = systemClock,
    logger = silentLogger,
    maxBufferMs = 1000,
    trimToMs = CHUNK_MS,
  }: AudioPipelineOptions) {
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_CHANNELS) {
      throw new RangeError(`channelCount must be between 1 and ${MAX_CHANNELS} (got ${channelCount})`);
    }
    this.channelCount = channelCount;
    this.onChunk = onChunk;
    this.logger = logger;
    this.trimToSamples = msToSamples(trimToMs);
    this.channels = Array.from({ length: channelCount }, () => ({
      buffer: new ChannelBuffer({ maxSamples: msToSamples(maxBufferMs), trimToSamples: this.trimToSamples }),
      resampler: undefined,
      scratch: new Int16Array(SAMPLES_PER_CHUNK),
      stats: { receivedSamples: 0, paddedSamples: 0, droppedSamples: 0 },
    }));
    this.ticker = new Ticker({
      clock,
      periodMs: CHUNK_MS,
      onTick: (tick) => this.emitChunk(tick),
      onSkip: (skippedTicks, lagMs) =>
        this.logger.warn("Audio clock fell behind; skipping ticks", { skippedTicks, lagMs: Math.round(lagMs) }),
    });
  }

  get isRunning(): boolean {
    return this.ticker.isRunning;
  }

  /** Adds one frame of audio for a channel. Safe to call before `start()`. */
  pushFrame(channel: number, frame: AudioFrame): void {
    const state = this.channel(channel);
    if (frame.bitsPerSample !== undefined && frame.bitsPerSample !== 16) {
      if (!this.rejectedFormatLogged) {
        this.logger.warn("Ignoring audio frames that aren't 16-bit", { channel, bitsPerSample: frame.bitsPerSample });
        this.rejectedFormatLogged = true;
      }
      return;
    }

    const mono = downmix(frame.samples, frame.channelCount);
    if (state.resampler?.inputRate !== frame.sampleRate) {
      state.resampler = new Resampler({ inputRate: frame.sampleRate, outputRate: OUTPUT_SAMPLE_RATE });
    }
    const resampled = state.resampler.process(mono);
    state.stats.receivedSamples += resampled.length;

    const dropped = state.buffer.write(resampled);
    if (dropped > 0) {
      state.stats.droppedSamples += dropped;
      // Before the clock starts, audio piling up is expected (we're waiting for Corti).
      if (this.isRunning) {
        this.logger.warn("Audio buffer overflow; dropped oldest audio", { channel, droppedMs: samplesToMs(dropped) });
      }
    }
  }

  /** Call when a channel gets a new track, so filter state from the old track doesn't leak in. */
  resetChannel(channel: number): void {
    this.channel(channel).resampler?.reset();
  }

  /** Starts the clock. Call only once Corti has accepted the stream configuration. */
  start(): void {
    if (this.isRunning) return;
    // Drop audio that piled up while waiting, so the stream starts close to real time.
    for (const state of this.channels) state.stats.droppedSamples += state.buffer.trimTo(this.trimToSamples);
    this.ticker.start();
  }

  stop(): void {
    this.ticker.stop();
  }

  stats(): { chunksSent: number; channels: ChannelStats[] } {
    return {
      chunksSent: this.chunksSent,
      channels: this.channels.map((c) => ({ ...c.stats, bufferedSamples: c.buffer.length })),
    };
  }

  private channel(channel: number): ChannelState {
    const state = this.channels[channel];
    if (!state) throw new RangeError(`Channel ${channel} doesn't exist (pipeline has ${this.channelCount})`);
    return state;
  }

  private emitChunk(tick: Tick): void {
    const paddedSamples = this.channels.map((state) => {
      const padded = SAMPLES_PER_CHUNK - state.buffer.read(state.scratch);
      state.stats.paddedSamples += padded;
      return padded;
    });

    const data = Buffer.allocUnsafe(SAMPLES_PER_CHUNK * this.channelCount * 2);
    let offset = 0;
    for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
      for (const state of this.channels) offset = data.writeInt16LE(state.scratch[i]!, offset);
    }

    this.chunksSent++;
    try {
      this.onChunk({ data, index: tick.index, paddedSamples });
    } catch (error) {
      // A failing consumer (e.g. a closed socket) must not stop the clock.
      this.logger.error("Audio chunk consumer failed", { error: String(error), chunk: tick.index });
    }
  }
}

/** Averages interleaved channels into mono. */
export function downmix(samples: Int16Array, channelCount: number): Int16Array {
  if (channelCount <= 1) return samples;
  const frames = Math.floor(samples.length / channelCount);
  const mono = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channelCount; c++) sum += samples[f * channelCount + c]!;
    mono[f] = Math.round(sum / channelCount);
  }
  return mono;
}

function msToSamples(ms: number): number {
  return Math.round((OUTPUT_SAMPLE_RATE * ms) / 1000);
}

function samplesToMs(samples: number): number {
  return Math.round((samples * 1000) / OUTPUT_SAMPLE_RATE);
}
