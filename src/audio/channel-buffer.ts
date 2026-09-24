export interface ChannelBufferOptions {
  /** Buffer size that counts as overflow. */
  maxSamples: number;
  /** After an overflow, keep only this many of the newest samples. */
  trimToSamples: number;
}

/**
 * FIFO of 16-bit samples for one channel, backed by a ring buffer.
 *
 * Reads never block: a short buffer is padded with silence. Writes never grow the buffer
 * beyond `maxSamples`: when they would, the oldest audio is dropped down to
 * `trimToSamples`, which bounds the latency this channel can build up.
 */
export class ChannelBuffer {
  private readonly ring: Int16Array;
  private start = 0;
  private size = 0;
  private readonly maxSamples: number;
  private readonly trimToSamples: number;

  constructor({ maxSamples, trimToSamples }: ChannelBufferOptions) {
    if (trimToSamples < 0 || trimToSamples > maxSamples) {
      throw new RangeError(`trimToSamples must be between 0 and maxSamples (got ${trimToSamples})`);
    }
    this.maxSamples = maxSamples;
    this.trimToSamples = trimToSamples;
    this.ring = new Int16Array(maxSamples);
  }

  get length(): number {
    return this.size;
  }

  /** Appends samples. Returns how many samples were dropped to stay within bounds. */
  write(samples: Int16Array): number {
    let input = samples;
    let dropped = 0;
    if (this.size + input.length > this.maxSamples) {
      dropped = this.size + input.length - this.trimToSamples;
      const fromBuffer = Math.min(dropped, this.size);
      this.discard(fromBuffer);
      input = input.subarray(dropped - fromBuffer);
    }

    const capacity = this.ring.length;
    let writeAt = (this.start + this.size) % capacity;
    const firstPart = Math.min(input.length, capacity - writeAt);
    this.ring.set(input.subarray(0, firstPart), writeAt);
    this.ring.set(input.subarray(firstPart), 0);
    this.size += input.length;
    return dropped;
  }

  /** Fills `target` from the front of the buffer, padding with silence. Returns the number of real samples. */
  read(target: Int16Array): number {
    const count = Math.min(target.length, this.size);
    const capacity = this.ring.length;
    const firstPart = Math.min(count, capacity - this.start);
    target.set(this.ring.subarray(this.start, this.start + firstPart), 0);
    target.set(this.ring.subarray(0, count - firstPart), firstPart);
    target.fill(0, count);
    this.discard(count);
    return count;
  }

  /** Drops the oldest samples so at most `maxLength` remain. Returns how many were dropped. */
  trimTo(maxLength: number): number {
    const dropped = Math.max(0, this.size - maxLength);
    this.discard(dropped);
    return dropped;
  }

  private discard(count: number): void {
    this.start = (this.start + count) % this.ring.length;
    this.size -= count;
  }
}
