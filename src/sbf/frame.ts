/**
 * Septentrio SBF framing shared by the measurement and navigation
 * decoders: 0x24 0x40 sync, CRC16-CCITT (poly 0x1021, init 0) as U2,
 * block ID U2 (number in bits 0..12, revision in 13..15), total length
 * U2 (multiple of 4, includes the 8-byte header). The CRC covers block
 * ID through payload end.
 */

/* ── CRC16-CCITT (poly 0x1021, init 0) ─────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 8;
    for (let k = 0; k < 8; k++)
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[n] = c;
  }
  return t;
})();

export function crc16(data: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++)
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ data[i]!) & 0xff]!) & 0xffff;
  return crc;
}

/**
 * Scan a byte stream for valid SBF frames and invoke `onBlock` for each
 * one, passing the block number (revision bits stripped), the frame
 * start offset and the total frame length. Frames with bad CRC are
 * counted and a resync continues at the next byte; the count of bad
 * frames is returned.
 */
export function scanSbfFrames(
  data: Uint8Array,
  view: DataView,
  onBlock: (id: number, offset: number, len: number) => void
): number {
  let badCrc = 0;
  let i = 0;
  while (i + 8 <= data.length) {
    if (data[i] !== 0x24 || data[i + 1] !== 0x40) {
      i++;
      continue;
    }
    const len = view.getUint16(i + 6, true);
    if (len < 8 || len % 4 !== 0) {
      i++;
      continue;
    }
    if (i + len > data.length) break;
    if (crc16(data, i + 4, i + len) !== view.getUint16(i + 2, true)) {
      badCrc++;
      i++;
      continue;
    }
    onBlock(view.getUint16(i + 4, true) & 0x1fff, i, len);
    i += len;
  }
  return badCrc;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Classic SBF SVID → PRN string ([1] 4.1.9, incl. GLONASS slot split). */
export function svidToPrn(svid: number): string | null {
  if (svid >= 1 && svid <= 37) return svid <= 32 ? `G${two(svid)}` : null;
  if (svid <= 61) return svid - 37 <= 27 ? `R${two(svid - 37)}` : null;
  if (svid <= 62) return null; // GLONASS with unknown slot number
  if (svid <= 68) return svid - 38 <= 27 ? `R${two(svid - 38)}` : null;
  if (svid <= 70) return null;
  if (svid <= 106) return svid - 70 <= 36 ? `E${two(svid - 70)}` : null;
  if (svid <= 119) return null; // L-band (MSS) satellites
  if (svid <= 140) return `S${two(svid - 100)}`;
  if (svid <= 180) return svid - 140 <= 50 ? `C${two(svid - 140)}` : null;
  if (svid <= 190) return `J${two(svid - 180)}`;
  if (svid <= 197) return svid - 190 <= 14 ? `I${two(svid - 190)}` : null;
  if (svid <= 215) return `S${two(svid - 157)}`;
  if (svid <= 222) return svid - 208 <= 14 ? `I${two(svid - 208)}` : null;
  if (svid <= 245) return svid - 182 <= 50 ? `C${two(svid - 182)}` : null;
  return null;
}
