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
  /** Per channel, how many samples of this chunk no source had audio for. */
  paddedSamples: number[];
}

export interface ChannelStats {
  sources: number;
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
  /** A source holding more than this is overflowing (default 1000 ms). */
  maxBufferMs?: number;
  /** On overflow, keep only this much of the newest audio (default one chunk). */
  trimToMs?: number;
}

/** One participant's audio track, feeding one channel. */
interface Source {
  channel: number;
  buffer: ChannelBuffer;
  resampler: Resampler | undefined;
  /** Removed, but still playing out what it had buffered. */
  draining: boolean;
}

/**
 * Turns per-participant WebRTC audio into one multichannel stream at real-time speed.
 *
 * Each source (one participant's track) is downmixed to mono, resampled to 16 kHz and
 * buffered on its own. A clock that doesn't depend on incoming audio takes one chunk from
 * every source every 250 ms, adds up the sources that share a channel, pads what's
 * missing with silence, and interleaves the channels. Because every source is read at the
 * same instant, channels stay aligned: a source that stops (muted, left, packet loss)
 * becomes silence instead of shifting anything else.
 */
export class AudioPipeline {
  readonly channelCount: number;
  private readonly sources = new Map<string, Source>();
  private readonly ticker: Ticker;
  private readonly onChunk: (chunk: Chunk) => void;
  private readonly logger: Logger;
  private readonly maxBufferSamples: number;
  private readonly trimToSamples: number;
  private readonly channelStats: Omit<ChannelStats, "sources" | "bufferedSamples">[];
  private readonly scratch = new Int16Array(SAMPLES_PER_CHUNK);
  private readonly mix: Int32Array[];
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
    this.maxBufferSamples = msToSamples(maxBufferMs);
    this.trimToSamples = msToSamples(trimToMs);
    this.channelStats = Array.from({ length: channelCount }, () => ({
      receivedSamples: 0,
      paddedSamples: 0,
      droppedSamples: 0,
    }));
    this.mix = Array.from({ length: channelCount }, () => new Int32Array(SAMPLES_PER_CHUNK));
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

  /** Registers a source (e.g. a participant's audio track) on a channel. */
  addSource(sourceId: string, channel: number): void {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.channelCount) {
      throw new RangeError(`Channel ${channel} doesn't exist (pipeline has ${this.channelCount})`);
    }
    if (this.sources.has(sourceId)) throw new Error(`Source ${sourceId} is already registered`);
    this.sources.set(sourceId, {
      channel,
      buffer: new ChannelBuffer({ maxSamples: this.maxBufferSamples, trimToSamples: this.trimToSamples }),
      resampler: undefined,
      draining: false,
    });
  }

  /**
   * Unregisters a source. Audio it already buffered still plays out, so the last words
   * before someone leaves aren't cut off.
   */
  removeSource(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    if (this.isRunning && source.buffer.length > 0) source.draining = true;
    else this.sources.delete(sourceId);
  }

  /** Adds one frame of audio for a source. Safe to call before `start()`; ignored for unknown sources. */
  pushFrame(sourceId: string, frame: AudioFrame): void {
    const source = this.sources.get(sourceId);
    if (!source || source.draining) return;
    if (frame.bitsPerSample !== undefined && frame.bitsPerSample !== 16) {
      if (!this.rejectedFormatLogged) {
        this.logger.warn("Ignoring audio frames that aren't 16-bit", { sourceId, bitsPerSample: frame.bitsPerSample });
        this.rejectedFormatLogged = true;
      }
      return;
    }

    const mono = downmix(frame.samples, frame.channelCount);
    if (source.resampler?.inputRate !== frame.sampleRate) {
      source.resampler = new Resampler({ inputRate: frame.sampleRate, outputRate: OUTPUT_SAMPLE_RATE });
    }
    const resampled = source.resampler.process(mono);
    const stats = this.channelStats[source.channel]!;
    stats.receivedSamples += resampled.length;

    const dropped = source.buffer.write(resampled);
    if (dropped > 0) {
      stats.droppedSamples += dropped;
      // Before the clock starts, audio piling up is expected (we're waiting for Corti).
      if (this.isRunning) {
        this.logger.warn("Audio buffer overflow; dropped oldest audio", {
          sourceId,
          channel: source.channel,
          droppedMs: samplesToMs(dropped),
        });
      }
    }
  }

  /** Starts the clock. Call only once Corti has accepted the stream configuration. */
  start(): void {
    if (this.isRunning) return;
    // Drop audio that piled up while waiting, so the stream starts close to real time.
    for (const source of this.sources.values()) {
      this.channelStats[source.channel]!.droppedSamples += source.buffer.trimTo(this.trimToSamples);
    }
    this.ticker.start();
  }

  stop(): void {
    this.ticker.stop();
  }

  stats(): { chunksSent: number; channels: ChannelStats[] } {
    return {
      chunksSent: this.chunksSent,
      channels: this.channelStats.map((stats, channel) => {
        let sources = 0;
        let bufferedSamples = 0;
        for (const source of this.sources.values()) {
          if (source.channel !== channel) continue;
          sources++;
          bufferedSamples += source.buffer.length;
        }
        return { ...stats, sources, bufferedSamples };
      }),
    };
  }

  private emitChunk(tick: Tick): void {
    for (const mix of this.mix) mix.fill(0);
    const covered = new Array<number>(this.channelCount).fill(0);

    for (const [sourceId, source] of this.sources) {
      const real = source.buffer.read(this.scratch);
      const mix = this.mix[source.channel]!;
      for (let i = 0; i < real; i++) mix[i]! += this.scratch[i]!;
      covered[source.channel] = Math.max(covered[source.channel]!, real);
      if (source.draining && source.buffer.length === 0) this.sources.delete(sourceId);
    }

    const paddedSamples = covered.map((real, channel) => {
      const padded = SAMPLES_PER_CHUNK - real;
      this.channelStats[channel]!.paddedSamples += padded;
      return padded;
    });

    const data = Buffer.allocUnsafe(SAMPLES_PER_CHUNK * this.channelCount * 2);
    let offset = 0;
    for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
      for (const mix of this.mix) {
        const sample = mix[i]!;
        offset = data.writeInt16LE(sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample, offset);
      }
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
