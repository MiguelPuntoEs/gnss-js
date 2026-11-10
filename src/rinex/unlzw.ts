/**
 * Unix `compress` (.Z, LZW) decoding — how GNSS archives stored daily
 * files until about 2020 (`wtzr0010.20d.Z`: Hatanaka, then compress).
 * A port of ncompress's decompress(): codes of 9…maxbits bits, LSB first;
 * in block mode code 256 clears the table. The compressor writes codes in
 * groups of eight, so whenever the code width changes (or the table is
 * cleared) the input skips to the end of the current group, counted from
 * where that code width began.
 */

/** Whether the bytes start with the .Z magic (1F 9D). */
export function isUnixCompress(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x9d;
}

export function uncompressLzw(input: Uint8Array): Uint8Array {
  if (!isUnixCompress(input)) throw new Error('Not a Unix compress (.Z) file.');
  const flags = input[2]!;
  const maxBits = flags & 0x1f;
  const blockMode = (flags & 0x80) !== 0;
  if (maxBits < 9 || maxBits > 16)
    throw new Error(`Unsupported .Z code size: ${maxBits} bits.`);
  const maxMaxCode = 1 << maxBits;
  const CLEAR = 256;
  const FIRST = blockMode ? 257 : 256;

  const prefix = new Uint16Array(maxMaxCode);
  const suffix = new Uint8Array(maxMaxCode);
  for (let i = 0; i < 256; i++) suffix[i] = i;
  const stack = new Uint8Array(maxMaxCode);

  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let outLen = 0;
  const emit = (from: number) => {
    const n = maxMaxCode - from;
    if (outLen + n > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, outLen + n));
      grown.set(out.subarray(0, outLen));
      out = grown;
    }
    out.set(stack.subarray(from, maxMaxCode), outLen);
    outLen += n;
  };

  const totalBits = input.length * 8;
  let posBits = 3 * 8;
  let nBits = 9;
  let maxCode = (1 << nBits) - 1;
  let mask = (1 << nBits) - 1;
  let freeEnt = FIRST;
  let oldCode = -1;
  let finChar = 0;

  // Groups are counted from where the current code width began: the first
  // code (after the 3-byte header), then each width change or clear (BSD
  // zopen.c reads one group of nBits bytes at a time from there).
  let base = posBits;
  /** Skip to the end of the current group of eight nBits-bit codes. */
  const align = () => {
    const g = nBits << 3;
    const rel = posBits - base;
    posBits = base + rel - 1 + (g - ((rel - 1 + g) % g));
    base = posBits;
  };

  for (;;) {
    if (freeEnt > maxCode && oldCode !== -1) {
      align();
      nBits++;
      maxCode = nBits === maxBits ? maxMaxCode : (1 << nBits) - 1;
      mask = (1 << nBits) - 1;
    }
    if (posBits + nBits > totalBits) break;
    // Read nBits LSB-first from posBits (spans at most 3 bytes).
    const byte = posBits >> 3;
    const word =
      input[byte]! |
      ((input[byte + 1] ?? 0) << 8) |
      ((input[byte + 2] ?? 0) << 16);
    let code = (word >> (posBits & 7)) & mask;
    posBits += nBits;

    if (oldCode === -1) {
      if (code >= 256) throw new Error('Corrupt .Z data (first code).');
      finChar = oldCode = code;
      stack[maxMaxCode - 1] = code;
      emit(maxMaxCode - 1);
      continue;
    }
    if (code === CLEAR && blockMode) {
      prefix.fill(0);
      freeEnt = FIRST - 1;
      align();
      nBits = 9;
      maxCode = (1 << nBits) - 1;
      mask = (1 << nBits) - 1;
      continue;
    }
    const inCode = code;
    let sp = maxMaxCode;
    if (code >= freeEnt) {
      // KwKwK: the code being defined right now.
      if (code > freeEnt) throw new Error('Corrupt .Z data.');
      stack[--sp] = finChar;
      code = oldCode;
    }
    while (code >= 256) {
      stack[--sp] = suffix[code]!;
      code = prefix[code]!;
    }
    finChar = suffix[code]!;
    stack[--sp] = finChar;
    emit(sp);
    if (freeEnt < maxMaxCode) {
      prefix[freeEnt] = oldCode;
      suffix[freeEnt] = finChar;
      freeEnt++;
    }
    oldCode = inCode;
  }
  return out.subarray(0, outLen);
}
