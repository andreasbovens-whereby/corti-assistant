/** Sine wave as 16-bit PCM. `phaseSamples` continues a wave across frames. */
export function sine(frequency: number, sampleRate: number, length: number, amplitude = 16000, phaseSamples = 0): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * (i + phaseSamples)) / sampleRate));
  }
  return out;
}

/** Amplitude of one frequency component (Goertzel algorithm), in the same units as the samples. */
export function toneAmplitude(samples: ArrayLike<number>, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i]! + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / samples.length;
}

export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / samples.length);
}

export function db(ratio: number): number {
  return 20 * Math.log10(ratio);
}

/** Splits an interleaved 16-bit little-endian buffer into one array per channel. */
export function deinterleave(data: Buffer, channelCount: number): Int16Array[] {
  const frames = data.length / 2 / channelCount;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const channels = Array.from({ length: channelCount }, () => new Int16Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channelCount; c++) channels[c]![f] = view.getInt16((f * channelCount + c) * 2, true);
  }
  return channels;
}

/** Deterministic PRNG (mulberry32), so jitter simulations are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
