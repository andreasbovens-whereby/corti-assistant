import { closeSync, openSync, writeSync } from "node:fs";
import { OUTPUT_SAMPLE_RATE } from "./pipeline.js";

/**
 * Writes the exact PCM stream sent to Corti to a WAV file, for debugging audio quality.
 * Local troubleshooting only: the file contains the call's audio.
 */
export class WavWriter {
  private readonly fd: number;
  private bytes = 0;

  constructor(
    path: string,
    private readonly channelCount: number,
    private readonly sampleRate = OUTPUT_SAMPLE_RATE,
  ) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, this.header(0)); // placeholder, rewritten with the real size on close
  }

  write(interleavedPcm: Buffer): void {
    writeSync(this.fd, interleavedPcm);
    this.bytes += interleavedPcm.length;
  }

  close(): void {
    writeSync(this.fd, this.header(this.bytes), 0, 44, 0);
    closeSync(this.fd);
  }

  private header(dataBytes: number): Buffer {
    const header = Buffer.alloc(44);
    const blockAlign = this.channelCount * 2;
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(this.channelCount, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(dataBytes, 40);
    return header;
  }
}
