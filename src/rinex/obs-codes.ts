/**
 * RINEX 2.11 two-character ↔ RINEX 3/4 three-character observation codes.
 *
 * RINEX 2.11 (section 10.1.1 and Table A1) names an observable by type and
 * band only: C1 is the C/A code (GPS, GLONASS, SBAS) or any E1 code
 * (Galileo), P1/P2 the P code (GPS P(Y), GLONASS P), C2 the GPS L2C code,
 * L/D/S the carrier phase, Doppler and signal strength "for the respective
 * phase observations". RINEX 3 adds the tracking attribute.
 *
 * v2 → v3 follows RINEX 2.11 semantics as RTKLIB's convcode does: P = W
 * (GPS, Z-tracking P(Y)) or P (GLONASS), L2C = X, the GPS/GLONASS L2
 * carrier = the P-code carrier, Galileo and band 5 = X (combined).
 *
 * v3 → v2 keeps, per system and v2 code, ONE v3 signal — the first present
 * in a fixed priority list — so every satellite of a system reports the
 * same signal under a v2 code. Signals RINEX 2.11 cannot name (GPS L1C,
 * BeiDou, QZSS, NavIC) are not written.
 */

/** v2 code → v3 code for a satellite of system `sys`; null if undefined. */
export function v2ToV3ObsCode(sys: string, code: string): string | null {
  if (code.length !== 2) return null;
  const t = code[0]!;
  const band = code[1]!;
  if (!'CPLDS'.includes(t)) return null;
  const type = t === 'P' ? 'C' : t;
  let attr: string | undefined;
  switch (sys) {
    case 'G':
      if (band === '1') attr = t === 'P' ? 'W' : 'C';
      else if (band === '2') attr = t === 'P' ? 'W' : t === 'C' ? 'X' : 'W';
      else if (band === '5' && t !== 'P') attr = 'X';
      break;
    case 'R':
      if (band === '1' || band === '2')
        attr = t === 'P' ? 'P' : t === 'C' ? 'C' : band === '1' ? 'C' : 'P';
      break;
    case 'E':
      if ('15678'.includes(band) && t !== 'P') attr = 'X';
      break;
    case 'S':
      if (band === '1' && t !== 'P') attr = 'C';
      else if (band === '5' && t !== 'P') attr = 'X';
      break;
  }
  return attr ? `${type}${band}${attr}` : null;
}

/** Systems RINEX 2.11 defines (Table A1: G, R, E, S; T = Transit retired). */
export const RINEX2_SYSTEMS = ['G', 'R', 'E', 'S'] as const;

/**
 * Per system, v2 code → the v3 attributes it may take, best first. The
 * L/D/S of a band follow the code the band's v2 phase belongs to: C/A for
 * L1 (P(Y) as fallback), P(Y) for GPS/GLONASS L2 (L2C as fallback).
 */
const V2_PRIORITY: Record<string, Record<string, string>> = {
  G: {
    C1: 'C',
    P1: 'WPY',
    L1: 'CWPY',
    C2: 'LSXC',
    P2: 'WPYD',
    L2: 'WPYDLSXC',
    C5: 'IQX',
    L5: 'IQX',
  },
  R: { C1: 'C', P1: 'P', L1: 'CP', C2: 'C', P2: 'P', L2: 'PC' },
  E: {
    C1: 'CABXZ',
    L1: 'CABXZ',
    C5: 'IQX',
    L5: 'IQX',
    C7: 'IQX',
    L7: 'IQX',
    C8: 'IQX',
    L8: 'IQX',
    C6: 'ABCXZ',
    L6: 'ABCXZ',
  },
  S: { C1: 'C', L1: 'C', C5: 'IQX', L5: 'IQX' },
};

/** Canonical RINEX 2 code order for the shared `# / TYPES OF OBSERV`. */
export const RINEX2_CODE_ORDER = [
  'C1', 'P1', 'L1', 'D1', 'S1',
  'C2', 'P2', 'L2', 'D2', 'S2',
  'C5', 'L5', 'D5', 'S5',
  'C6', 'L6', 'D6', 'S6',
  'C7', 'L7', 'D7', 'S7',
  'C8', 'L8', 'D8', 'S8',
]; // prettier-ignore

/**
 * For one system's code list, the v2 code → index of the code that fills it.
 * A list already in v2 (two-character) form maps onto itself.
 */
export function v2CodeColumns(
  sys: string,
  codes: readonly string[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (codes.length > 0 && codes.every((c) => c.length === 2)) {
    codes.forEach((c, i) => {
      if (!out.has(c)) out.set(c, i);
    });
    return out;
  }
  const prio = V2_PRIORITY[sys];
  if (!prio) return out;
  for (const v2 of RINEX2_CODE_ORDER) {
    // D and S ride with the band's phase (L) priority
    const key = v2[0] === 'D' || v2[0] === 'S' ? `L${v2[1]}` : v2;
    const attrs = prio[key];
    if (!attrs) continue;
    const type = v2[0] === 'P' ? 'C' : v2[0]!;
    for (const a of attrs) {
      const i = codes.indexOf(`${type}${v2[1]}${a}`);
      if (i >= 0) {
        out.set(v2, i);
        break;
      }
    }
  }
  return out;
}
