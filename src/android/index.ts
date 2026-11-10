/**
 * Android raw GNSS measurements — the text logs written by Google's
 * GnssLogger app (and apps using its format): `Raw,…` rows of
 * `android.location.GnssMeasurement` + `GnssClock` fields, one row per
 * satellite signal, plus `Fix,…` rows with the phone's own position.
 *
 * Pseudoranges are reconstructed the way Google's gps-measurement-tools and
 * Rokubun's android_rinex (as used by RTKLIB-py) do: reception time from the
 * hardware clock `TimeNanos` minus the clock bias `FullBiasNanos + BiasNanos`,
 * transmission time from `ReceivedSvTimeNanos` in each constellation's
 * time scale, pseudorange = c·(tRx − tTx). The bias is held fixed within each
 * hardware-clock segment (re-read only when `HardwareClockDiscontinuityCount`
 * changes), so code and carrier phase (`AccumulatedDeltaRangeMeters`, which
 * the chip accumulates on the same hardware clock) stay consistent; the
 * receiver clock offset then drifts like a free-running receiver's, which
 * positioning estimates per epoch anyway. Epochs are rounded to 100 ns and
 * code/phase shifted by the rounding, as android_rinex does.
 *
 * Only measurements with code lock and a resolved time of week (time of day
 * for GLONASS) are kept — the rest have millisecond-ambiguous pseudoranges.
 */
import { C_LIGHT } from '../constants/gnss';

/** One satellite signal at an epoch, in the shape of the other receiver
 *  decoders (`ubx`, `sbf`…). */
export interface AndroidMeasurement {
  /** RINEX PRN, e.g. "G04", "R11", "J02". */
  prn: string;
  /** RINEX band + attribute, e.g. "1C", "5Q", "2I". */
  code: string;
  /** Pseudorange (m). */
  pr: number;
  /** Carrier phase (cycles), null when not tracked/valid. */
  cp: number | null;
  /** Doppler (Hz). */
  doppler: number | null;
  /** C/N0 (dB-Hz). */
  cn0: number | null;
  /** Carrier phase may be off by half a cycle (not half-cycle resolved). */
  halfCycleAmbiguous: boolean;
  /** Continuous carrier-lock time (ms): 0 at a slip/reset, then growing —
   *  the same loss-of-lock signal the other decoders give. */
  lockTimeMs: number;
  /** GLONASS frequency channel (−7…+6), from the carrier frequency. */
  gloChannel: number | null;
}

export interface AndroidEpoch {
  /** Receiver epoch (GPS-scale ms — the RINEX-parser convention). */
  timeMs: number;
  meas: AndroidMeasurement[];
}

/** The phone's own position fix (`Fix,` rows). */
export interface AndroidFix {
  /** UTC ms. */
  utcMs: number;
  /** 'GPS' (GNSS chip), 'FLP' (fused), 'NLP' (network)… */
  provider: string;
  latDeg: number;
  lonDeg: number;
  /** Altitude (m) as reported (WGS84 ellipsoidal on most devices). */
  altM: number | null;
  /** Horizontal accuracy (m, 68%). */
  accuracyM: number | null;
}

export interface AndroidLogResult {
  epochs: AndroidEpoch[];
  fixes: AndroidFix[];
  /** Device line (`# Version: … Manufacturer: … Model: …`), if present. */
  device: { manufacturer: string; model: string; version: string } | null;
  /** Rows per record type ('Raw', 'Fix', 'Status', 'Nav'…). */
  messageCounts: Record<string, number>;
  /** Observation codes per system letter, first-seen order. */
  obsCodes: Record<string, string[]>;
  /** Raw rows dropped (no code lock / ambiguous time / bad values). */
  rejected: number;
  /** GPS − UTC leap seconds from the log, if reported. */
  leapSeconds: number | null;
}

const NS_PER_WEEK = 604_800_000_000_000n;
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const BDT_MINUS_GPST_S = -14;
const GLO_RANGE = [1.59e9, 1.61e9] as const;
const GLO_G1 = 1602e6;
const GLO_G1_STEP = 0.5625e6;

// android.location.GnssMeasurement state / ADR-state bits.
const STATE_CODE_LOCK = 0x1;
const STATE_TOW_DECODED = 0x8;
const STATE_MSEC_AMBIGUOUS = 0x10;
const STATE_GLO_TOD_DECODED = 0x80;
const STATE_GAL_E1BC_CODE_LOCK = 0x400;
const STATE_GAL_E1C_2ND_CODE_LOCK = 0x800;
const STATE_GAL_E1B_PAGE_SYNC = 0x1000;
const STATE_TOW_KNOWN = 0x4000;
const STATE_GLO_TOD_KNOWN = 0x8000;
const ADR_VALID = 0x1;
const ADR_RESET = 0x2;
const ADR_CYCLE_SLIP = 0x4;
const ADR_HALF_CYCLE_RESOLVED = 0x8;

/** Max pseudorange uncertainty kept (ns ≈ 150 m). */
const MAX_PR_UNC_NS = 500;
/** Max carrier-phase uncertainty kept (m). */
const MAX_ADR_UNC_M = 0.1;

/** ConstellationType → RINEX system letter. */
const SYSTEM: Record<number, string> = {
  1: 'G',
  2: 'S',
  3: 'R',
  4: 'J',
  5: 'C',
  6: 'E',
  7: 'I',
};

/** Nominal carrier (Hz) per RINEX band, by system — the frequency a band
 *  number stands for (GLONASS FDMA handled separately). */
const BANDS: Record<string, [number, number][]> = {
  G: [
    [1, 1575.42e6],
    [2, 1227.6e6],
    [5, 1176.45e6],
  ],
  S: [
    [1, 1575.42e6],
    [5, 1176.45e6],
  ],
  J: [
    [1, 1575.42e6],
    [2, 1227.6e6],
    [5, 1176.45e6],
    [6, 1278.75e6],
  ],
  E: [
    [1, 1575.42e6],
    [5, 1176.45e6],
    [7, 1207.14e6],
    [6, 1278.75e6],
  ],
  C: [
    [2, 1561.098e6],
    [1, 1575.42e6],
    [5, 1176.45e6],
    [7, 1207.14e6],
    [6, 1268.52e6],
  ],
  I: [[5, 1176.45e6]],
};

/** Default tracking attribute when the log has no CodeType column. */
const DEFAULT_ATTR: Record<string, string> = {
  G1: 'C',
  G2: 'L',
  G5: 'Q',
  S1: 'C',
  S5: 'I',
  J1: 'C',
  J2: 'L',
  J5: 'Q',
  E1: 'C',
  E5: 'Q',
  E7: 'Q',
  E6: 'C',
  C2: 'I',
  C1: 'P',
  C5: 'P',
  C7: 'I',
  C6: 'I',
  I5: 'A',
  R1: 'C',
  R2: 'C',
};

/** RINEX PRN for an Android (constellation, svid); null when unusable
 *  (e.g. GLONASS reported by frequency channel, not slot). */
function prnOf(sys: string, svid: number): string | null {
  let n = svid;
  if (sys === 'S')
    n = svid - 100; // 120–158 → S20–S58
  else if (sys === 'J')
    n = svid - 192; // 193–202 → J01–J10
  else if (sys === 'R' && svid > 24) return null; // FCN+100: slot unknown
  if (n < 1 || n > 99) return null;
  return sys + String(n).padStart(2, '0');
}

/** Band number + nominal frequency for a reported carrier frequency. */
function bandOf(
  sys: string,
  freqHz: number
): { band: number; freq: number; gloChannel: number | null } | null {
  if (sys === 'R') {
    if (freqHz >= GLO_RANGE[0] && freqHz <= GLO_RANGE[1]) {
      const k = Math.round((freqHz - GLO_G1) / GLO_G1_STEP);
      return { band: 1, freq: GLO_G1 + k * GLO_G1_STEP, gloChannel: k };
    }
    return null;
  }
  for (const [band, f] of BANDS[sys] ?? [])
    if (Math.abs(freqHz - f) < 1e6) return { band, freq: f, gloChannel: null };
  return null;
}

/** Split a CSV row (no quoting in GnssLogger output). */
const cells = (line: string) => line.split(',');

/**
 * Parse a GnssLogger text log. Missing `CarrierFrequencyHz` (very old logs)
 * means GPS/Galileo/QZSS L1.
 */
export function parseAndroidGnssLog(text: string): AndroidLogResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const messageCounts: Record<string, number> = {};
  const fixes: AndroidFix[] = [];
  let device: AndroidLogResult['device'] = null;
  let rawCols: Map<string, number> | null = null;
  let fixCols: Map<string, number> | null = null;
  let leapSeconds: number | null = null;
  let rejected = 0;

  // Rows of one GnssMeasurementsEvent share TimeNanos.
  type Row = string[];
  const groups: Row[][] = [];
  let curKey = '';
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) {
      const body = line.replace(/^#\s*/, '');
      if (body.startsWith('Raw,'))
        rawCols = new Map(cells(body).map((c, i) => [c.trim(), i]));
      else if (body.startsWith('Fix,'))
        fixCols = new Map(cells(body).map((c, i) => [c.trim(), i]));
      else if (/Manufacturer/.test(body)) {
        const m = (k: string) =>
          new RegExp(`${k}:\\s*([^:]*?)(?:\\s+\\w+:|$)`)
            .exec(body)?.[1]
            ?.trim() ?? '';
        device = {
          manufacturer: m('Manufacturer'),
          model: m('Model'),
          version: m('Version').replace(/,$/, ''),
        };
      }
      continue;
    }
    const type = line.slice(0, line.indexOf(','));
    if (!type) continue;
    messageCounts[type] = (messageCounts[type] ?? 0) + 1;
    if (type === 'Raw' && rawCols) {
      const r = cells(line);
      const key = r[rawCols.get('TimeNanos')!] ?? '';
      if (key !== curKey) {
        groups.push([]);
        curKey = key;
      }
      groups[groups.length - 1]!.push(r);
    } else if (type === 'Fix' && fixCols) {
      const r = cells(line);
      const g = (k: string) => {
        const i = fixCols!.get(k);
        const v = i === undefined ? '' : (r[i] ?? '').trim();
        return v === '' ? null : Number(v);
      };
      const lat = g('LatitudeDegrees');
      const lon = g('LongitudeDegrees');
      const t = g('UnixTimeMillis');
      if (lat != null && lon != null && t != null)
        fixes.push({
          utcMs: t,
          provider: (r[fixCols.get('Provider') ?? 1] ?? '').trim(),
          latDeg: lat,
          lonDeg: lon,
          altM: g('AltitudeMeters'),
          accuracyM: g('AccuracyMeters'),
        });
    }
  }

  const epochs: AndroidEpoch[] = [];
  const obsCodes: Record<string, string[]> = {};
  if (!rawCols) {
    return {
      epochs,
      fixes,
      device,
      messageCounts,
      obsCodes,
      rejected,
      leapSeconds,
    };
  }
  const col = rawCols;
  const str = (r: Row, k: string) => {
    const i = col.get(k);
    return i === undefined ? '' : (r[i] ?? '').trim();
  };
  const num = (r: Row, k: string) => {
    const v = str(r, k);
    return v === '' ? null : Number(v);
  };

  // Clock bias held per hardware-clock segment.
  let segment: string | null = null;
  let fullBias = 0n;
  let bias = 0;
  /** Carrier-lock start (ms) per PRN+code, for lockTimeMs. */
  const lockStart = new Map<string, number>();

  for (const rows of groups) {
    const r0 = rows[0]!;
    const timeNanosStr = str(r0, 'TimeNanos');
    const fullBiasStr = str(r0, 'FullBiasNanos');
    if (!timeNanosStr || !fullBiasStr) {
      rejected += rows.length;
      continue;
    }
    const disc = str(r0, 'HardwareClockDiscontinuityCount');
    if (disc !== segment) {
      segment = disc;
      fullBias = BigInt(fullBiasStr.split('.')[0]!);
      bias = num(r0, 'BiasNanos') ?? 0;
    }
    const leap = num(r0, 'LeapSecond');
    if (leap != null && !Number.isNaN(leap)) leapSeconds = leap;

    // Receiver GPS time = TimeNanos − (FullBiasNanos + BiasNanos), split into
    // week + ns-of-week with BigInt (the products exceed 2^53). Everything
    // after stays in integer nanoseconds as long as possible and only then
    // subtracts the sub-ns BiasNanos: seconds-of-week as a double carry
    // ~0.06 ns (2 cm) of rounding, which would show up as code noise.
    const rxNs = BigInt(timeNanosStr.split('.')[0]!) - fullBias;
    const week = Number(rxNs / NS_PER_WEEK);
    const rxWeekNs = Number(rxNs % NS_PER_WEEK); // exact integer < 2^53
    // Round the epoch to 100 ns; code and phase shift by the same amount.
    const epochWeekNs = Math.round((rxWeekNs - bias) / 100) * 100;
    const toffNs = rxWeekNs - epochWeekNs - bias;
    const timeMs = GPS_EPOCH_MS + week * 604_800_000 + epochWeekNs / 1e6;
    const leapNow = leapSeconds ?? 18;

    const meas: AndroidMeasurement[] = [];
    for (const r of rows) {
      const sys = SYSTEM[num(r, 'ConstellationType') ?? 1];
      const svid = num(r, 'Svid');
      if (!sys || svid == null) {
        rejected++;
        continue;
      }
      const prn = prnOf(sys, svid);
      const freqHz = num(r, 'CarrierFrequencyHz') ?? 1575.42e6;
      const b = prn ? bandOf(sys, freqHz) : null;
      const state = num(r, 'State') ?? 0;
      const towOk =
        sys === 'R'
          ? (state & (STATE_GLO_TOD_DECODED | STATE_GLO_TOD_KNOWN)) !== 0
          : (state & (STATE_TOW_DECODED | STATE_TOW_KNOWN)) !== 0;
      const codeLock =
        (state & (STATE_CODE_LOCK | STATE_GAL_E1BC_CODE_LOCK)) !== 0;
      const prUnc = num(r, 'ReceivedSvTimeUncertaintyNanos');
      const svTimeNs = num(r, 'ReceivedSvTimeNanos');
      if (
        !prn ||
        !b ||
        !towOk ||
        !codeLock ||
        (state & STATE_MSEC_AMBIGUOUS) !== 0 ||
        svTimeNs == null ||
        (prUnc != null && prUnc > MAX_PR_UNC_NS)
      ) {
        rejected++;
        continue;
      }

      // Travel time (ns): reception − transmission, the integer parts first.
      // GLONASS transmits time of day in UTC+3 h; BeiDou BDT = GPS − 14 s.
      const subNs = bias + (num(r, 'TimeOffsetNanos') ?? 0);
      let tauNs: number;
      if (sys === 'R') {
        const DAY = 86_400e9;
        const tTxNs = svTimeNs - 10_800e9 + leapNow * 1e9;
        tauNs = ((((rxWeekNs % DAY) - tTxNs) % DAY) + DAY) % DAY;
        if (tauNs > DAY / 2) tauNs -= DAY;
      } else {
        const tTxNs = svTimeNs - (sys === 'C' ? BDT_MINUS_GPST_S * 1e9 : 0);
        tauNs = rxWeekNs - tTxNs;
        if (tauNs > 302_400e9) tauNs -= 604_800e9;
        else if (tauNs < -302_400e9) tauNs += 604_800e9;
      }
      tauNs -= subNs;
      // A real signal travels 64–150 ms (MEO … GEO): anything else is a
      // time-of-week ambiguity the state flags didn't catch.
      if (!(tauNs > 0.06e9 && tauNs < 0.16e9)) {
        rejected++;
        continue;
      }
      const pr = (tauNs - toffNs) * 1e-9 * C_LIGHT;

      const attrCell = str(r, 'CodeType');
      let attr = attrCell || DEFAULT_ATTR[sys + b.band] || 'C';
      if (
        !attrCell &&
        sys === 'E' &&
        b.band === 1 &&
        (state & STATE_GAL_E1C_2ND_CODE_LOCK) === 0 &&
        (state & STATE_GAL_E1B_PAGE_SYNC) !== 0
      )
        attr = 'B';
      const code = `${b.band}${attr}`;
      const lambda = C_LIGHT / b.freq;

      // Carrier phase: valid, not reset, and tight enough.
      const adrState = num(r, 'AccumulatedDeltaRangeState') ?? 0;
      const adr = num(r, 'AccumulatedDeltaRangeMeters');
      const adrUnc = num(r, 'AccumulatedDeltaRangeUncertaintyMeters');
      const lockKey = prn + code;
      let cp: number | null = null;
      if (
        (adrState & ADR_VALID) !== 0 &&
        adr != null &&
        adr !== 0 &&
        (adrUnc == null || adrUnc < MAX_ADR_UNC_M)
      ) {
        cp = adr / lambda - toffNs * 1e-9 * b.freq;
        if (
          (adrState & (ADR_RESET | ADR_CYCLE_SLIP)) !== 0 ||
          !lockStart.has(lockKey)
        )
          lockStart.set(lockKey, timeMs);
      } else lockStart.delete(lockKey);

      const prr = num(r, 'PseudorangeRateMetersPerSecond');
      meas.push({
        prn,
        code,
        pr,
        cp,
        doppler: prr == null ? null : -prr / lambda,
        cn0: num(r, 'Cn0DbHz'),
        halfCycleAmbiguous:
          cp != null && (adrState & ADR_HALF_CYCLE_RESOLVED) === 0,
        lockTimeMs: cp != null ? timeMs - lockStart.get(lockKey)! : 0,
        gloChannel: b.gloChannel,
      });
      const list = (obsCodes[sys] ??= []);
      if (!list.includes(code)) list.push(code);
    }
    if (meas.length > 0) epochs.push({ timeMs, meas });
  }

  return {
    epochs,
    fixes,
    device,
    messageCounts,
    obsCodes,
    rejected,
    leapSeconds,
  };
}

/** Whether `text` looks like a GnssLogger log (first few KB). */
export function isAndroidGnssLog(text: string): boolean {
  const head = text.slice(0, 16_384);
  return /^#\s*Raw,/m.test(head) || /^Raw,\d+,\d+,/m.test(head);
}
