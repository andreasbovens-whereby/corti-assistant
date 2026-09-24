/**
 * Streaming sample-rate converter for 16-bit mono PCM.
 *
 * A rational polyphase FIR resampler: conceptually it upsamples by L (zero stuffing),
 * low-pass filters, and keeps every M-th sample, but only computes the outputs it keeps.
 * The low-pass is a Kaiser-windowed sinc whose stopband starts at the lower of the two
 * Nyquist frequencies, so content that can't be represented at the output rate is
 * removed instead of aliasing. For 48 kHz -> 16 kHz (L=1, M=3) that means a passband up
 * to about 7 kHz and at least 80 dB attenuation from 8 kHz.
 *
 * State is carried across calls, so feeding 10 ms frames gives the same output as
 * feeding one long buffer.
 */

export interface ResamplerOptions {
  inputRate: number;
  outputRate: number;
  /** Minimum attenuation in the stopband. */
  stopbandAttenuationDb?: number;
  /** Width of the transition band below the output Nyquist frequency. */
  transitionHz?: number;
}

export class Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  private readonly up: number;
  private readonly down: number;
  private readonly passthrough: boolean;
  /** phases[p][k] = prototype[p + k * up]. */
  private readonly phases: Float32Array[] = [];
  private readonly tapsPerPhase: number = 0;
  /** The last (tapsPerPhase - 1) input samples. */
  private history: Float32Array = new Float32Array(0);
  /** Position of the next output in upsampled samples, relative to history[0]. */
  private position = 0;

  constructor({ inputRate, outputRate, stopbandAttenuationDb = 80, transitionHz = 1000 }: ResamplerOptions) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) {
      throw new RangeError(`Sample rates must be positive integers (got ${inputRate} -> ${outputRate})`);
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    const divisor = gcd(inputRate, outputRate);
    this.up = outputRate / divisor;
    this.down = inputRate / divisor;
    this.passthrough = this.up === 1 && this.down === 1;
    if (this.passthrough) return;

    const nyquist = Math.min(inputRate, outputRate) / 2;
    const transition = Math.min(transitionHz, nyquist / 4);
    const prototypeRate = inputRate * this.up;
    const cutoff = (nyquist - transition / 2) / prototypeRate;
    const length = kaiserLength(stopbandAttenuationDb, transition / prototypeRate);

    this.tapsPerPhase = Math.ceil(length / this.up);
    const prototype = windowedSinc(this.tapsPerPhase * this.up, cutoff, kaiserBeta(stopbandAttenuationDb));
    for (let p = 0; p < this.up; p++) {
      const phase = new Float32Array(this.tapsPerPhase);
      for (let k = 0; k < this.tapsPerPhase; k++) phase[k] = prototype[p + k * this.up]! * this.up;
      this.phases.push(phase);
    }
    this.reset();
  }

  /** Clears the filter state, for example when a new track starts on the same channel. */
  reset(): void {
    if (this.passthrough) return;
    this.history = new Float32Array(this.tapsPerPhase - 1);
    this.position = (this.tapsPerPhase - 1) * this.up;
  }

  process(input: Int16Array): Int16Array {
    if (this.passthrough) return input.slice();

    const { up, down, tapsPerPhase, phases } = this;
    const historyLength = tapsPerPhase - 1;
    const buffer = new Float32Array(historyLength + input.length);
    buffer.set(this.history);
    for (let i = 0; i < input.length; i++) buffer[historyLength + i] = input[i]!;

    // Every output whose newest input sample is inside the buffer can be computed now.
    const end = buffer.length * up;
    const count = this.position < end ? Math.ceil((end - this.position) / down) : 0;
    const output = new Int16Array(count);
    let position = this.position;
    for (let n = 0; n < count; n++, position += down) {
      const newest = Math.floor(position / up);
      const coefficients = phases[position - newest * up]!;
      let sum = 0;
      for (let k = 0; k < tapsPerPhase; k++) sum += coefficients[k]! * buffer[newest - k]!;
      output[n] = sum >= 32767 ? 32767 : sum <= -32768 ? -32768 : Math.round(sum);
    }

    const consumed = buffer.length - historyLength;
    this.history = buffer.slice(consumed);
    this.position = position - consumed * up;
    return output;
  }
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Kaiser's estimate of the filter length for a given attenuation and normalized transition width. */
function kaiserLength(attenuationDb: number, transitionWidth: number): number {
  return Math.ceil((attenuationDb - 7.95) / (14.36 * transitionWidth)) + 1;
}

function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7);
  if (attenuationDb >= 21) return 0.5842 * (attenuationDb - 21) ** 0.4 + 0.07886 * (attenuationDb - 21);
  return 0;
}

/** Low-pass prototype with unity DC gain. `cutoff` is a fraction of the sample rate (0 to 0.5). */
function windowedSinc(length: number, cutoff: number, beta: number): Float64Array {
  const taps = new Float64Array(length);
  const center = (length - 1) / 2;
  const i0Beta = besselI0(beta);
  let sum = 0;
  for (let n = 0; n < length; n++) {
    const x = n - center;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const ratio = center === 0 ? 0 : x / center;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0Beta;
    taps[n] = sinc * window;
    sum += taps[n]!;
  }
  for (let n = 0; n < length; n++) taps[n]! /= sum;
  return taps;
}

/** Zeroth-order modified Bessel function of the first kind (power series). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; term > sum * 1e-12; k++) {
    term *= (halfX / k) ** 2;
    sum += term;
  }
  return sum;
}
