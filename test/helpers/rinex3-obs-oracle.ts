/**
 * Minimal, deliberately independent RINEX 3 observation reader for oracle
 * tests: it reads RTKLIB convbin output column by column (RINEX 3.04
 * §5.1 / Table A3: per observation F14.3 + LLI digit + SSI digit, 16 columns)
 * and shares no code with the library's own RINEX parser, so a misreading in
 * one cannot hide behind the other.
 */

export interface OracleValue {
  value: number;
  /** Loss-of-lock indicator (0 when blank). */
  lli: number;
}

export interface OracleEpoch {
  /** Epoch on the GPS-scale ms axis (the RINEX epoch is in GPS time). */
  timeMs: number;
  flag: number;
  /** prn → obs type (e.g. "C1C") → value. Blank fields are absent. */
  sats: Map<string, Map<string, OracleValue>>;
  /** Satellite rows in file order (convbin may repeat a PRN). */
  rows: { prn: string; obs: Map<string, OracleValue> }[];
}

export interface OracleObsFile {
  types: Record<string, string[]>;
  epochs: OracleEpoch[];
}

export function readRinex3Obs(text: string): OracleObsFile {
  const lines = text.split(/\r?\n/);
  const types: Record<string, string[]> = {};
  let i = 0;
  let sys = '';
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    const label = l.slice(60).trim();
    if (label === 'END OF HEADER') {
      i++;
      break;
    }
    if (label === 'SYS / # / OBS TYPES') {
      if (l[0] !== ' ') sys = l[0]!;
      const list = (types[sys] ??= []);
      for (let c = 7; c + 3 <= 58; c += 4) {
        const t = l.slice(c, c + 3).trim();
        if (t) list.push(t);
      }
    }
  }
  const epochs: OracleEpoch[] = [];
  while (i < lines.length) {
    const l = lines[i++]!;
    if (!l.startsWith('>')) continue;
    const y = +l.slice(2, 6);
    const mo = +l.slice(7, 9);
    const d = +l.slice(10, 12);
    const h = +l.slice(13, 15);
    const mi = +l.slice(16, 18);
    const sec = +l.slice(18, 29);
    const flag = +l.slice(31, 32);
    const n = +l.slice(32, 35);
    const timeMs = Date.UTC(y, mo - 1, d, h, mi) + Math.round(sec * 1000);
    const ep: OracleEpoch = { timeMs, flag, sats: new Map(), rows: [] };
    for (let k = 0; k < n; k++) {
      // convbin 2.4.2 sometimes writes an epoch line twice (RTCM 2): a
      // header inside the satellite block restarts the epoch.
      if (lines[i]?.startsWith('>')) break;
      const row = lines[i++]!;
      const prn = row.slice(0, 3).replace(' ', '0');
      const obs = new Map<string, OracleValue>();
      const list = types[prn[0]!] ?? [];
      list.forEach((t, j) => {
        const f = row.slice(3 + 16 * j, 3 + 16 * j + 16);
        const v = f.slice(0, 14).trim();
        if (!v) return;
        const lli = f.slice(14, 15).trim();
        obs.set(t, { value: +v, lli: lli ? +lli : 0 });
      });
      ep.rows.push({ prn, obs });
      if (!ep.sats.has(prn)) ep.sats.set(prn, obs);
    }
    epochs.push(ep);
  }
  return { types, epochs };
}

/** The receiver-decoder measurement shape (UBX, NovAtel, BINEX, SBF, …). */
export interface RawLike {
  prn: string;
  code: string;
  pr: number | null;
  cp: number | null;
  doppler: number | null;
  cn0: number | null;
}

export interface FieldStats {
  /** Values compared. */
  n: number;
  /** Largest |ours − oracle|. */
  maxDiff: number;
  /** Oracle values we have no measurement for. */
  missing: string[];
}

const FIELD = { C: 'pr', L: 'cp', D: 'doppler', S: 'cn0' } as const;

/**
 * Compare every oracle value with our decode of the same file, keyed by
 * (epoch, PRN, RINEX band+attribute). `mapCode` translates the oracle's
 * obs code to ours where RTKLIB 2.4.2 uses an older RINEX naming.
 */
export function compareWithOracle(
  oracle: OracleObsFile,
  epochs: { timeMs: number; meas: readonly RawLike[] }[],
  mapCode: (prn: string, code: string) => string | null = (_p, c) => c
): Record<'C' | 'L' | 'D' | 'S', FieldStats> {
  const ours = new Map<string, RawLike>();
  for (const e of epochs) {
    for (const m of e.meas) ours.set(`${e.timeMs}|${m.prn}|${m.code}`, m);
  }
  const out = {} as Record<'C' | 'L' | 'D' | 'S', FieldStats>;
  for (const k of ['C', 'L', 'D', 'S'] as const) {
    out[k] = { n: 0, maxDiff: 0, missing: [] };
  }
  for (const ep of oracle.epochs) {
    for (const [prn, obs] of ep.sats) {
      for (const [type, v] of obs) {
        const kind = type[0] as 'C' | 'L' | 'D' | 'S';
        const code = mapCode(prn, type.slice(1));
        if (code === null) continue;
        const st = out[kind];
        const m = ours.get(`${ep.timeMs}|${prn}|${code}`);
        const mine = m?.[FIELD[kind]];
        if (mine === null || mine === undefined) {
          st.missing.push(
            `${new Date(ep.timeMs).toISOString()} ${prn} ${type}`
          );
          continue;
        }
        st.n++;
        st.maxDiff = Math.max(st.maxDiff, Math.abs(mine - v.value));
      }
    }
  }
  return out;
}
