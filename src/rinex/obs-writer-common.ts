/**
 * Shared plumbing for the RINEX 2/3/4 observation writers.
 */

import type { RinexHeader } from './parser';
import { padL, fmtF, hdrLine } from './format';

/**
 * Batched line sink that streams text through gzip compression so the
 * full uncompressed output is never held in memory.
 *
 * Callers decide when to `flush()` (the writers flush every N epochs);
 * `finish()` flushes, closes the stream, and returns the Blob.
 */
export function createGzipLineSink() {
  const encoder = new TextEncoder();
  const compressor = new CompressionStream('gzip');
  const writer = compressor.writable.getWriter();

  const compressedChunks: Uint8Array[] = [];
  const readerDone = (async () => {
    const reader = compressor.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedChunks.push(value);
    }
  })();

  let batch: string[] = [];

  async function flush() {
    if (batch.length === 0) return;
    await writer.write(encoder.encode(batch.join('\n') + '\n'));
    batch = [];
  }

  return {
    push(line: string) {
      batch.push(line);
    },
    flush,
    async finish(): Promise<Blob> {
      await flush();
      await writer.close();
      await readerDone;
      return new Blob(compressedChunks as BlobPart[], {
        type: 'application/gzip',
      });
    },
  };
}

/**
 * Station / receiver / antenna header block — byte-identical across
 * RINEX 2.11, 3.04, and 4.01.
 */
export function stationHeaderLines(header: RinexHeader): string[] {
  const pos = header.approxPosition ?? [0, 0, 0];
  const delta = header.antDelta ?? [0, 0, 0];
  return [
    hdrLine(header.markerName || 'UNKNOWN', 'MARKER NAME'),
    hdrLine('', 'MARKER NUMBER'),
    hdrLine(
      `${padL(header.observer || '', 20)}${padL(header.agency || '', 40)}`,
      'OBSERVER / AGENCY'
    ),
    hdrLine(
      `${padL(header.receiverNumber || '', 20)}${padL(header.receiverType || '', 20)}${padL(header.receiverVersion || '', 20)}`,
      'REC # / TYPE / VERS'
    ),
    hdrLine(
      `${padL(header.antNumber || '', 20)}${padL(header.antType || '', 20)}`,
      'ANT # / TYPE'
    ),
    hdrLine(
      `${fmtF(pos[0], 14, 4)}${fmtF(pos[1], 14, 4)}${fmtF(pos[2], 14, 4)}`,
      'APPROX POSITION XYZ'
    ),
    hdrLine(
      `${fmtF(delta[0], 14, 4)}${fmtF(delta[1], 14, 4)}${fmtF(delta[2], 14, 4)}`,
      'ANTENNA: DELTA H/E/N'
    ),
  ];
}
