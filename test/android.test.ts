import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAndroidGnssLog, isAndroidGnssLog } from '../src/android';
import { C_LIGHT } from '../src/constants/gnss';

const FIX = join(__dirname, '..', 'test-fixtures');

/* ------------------------------------------------------------------ */
/*  Real log: Google gps-measurement-tools demo (Apache-2.0)           */
/* ------------------------------------------------------------------ */

// Google's own reception/transmission times for the first epoch of
// pseudoranges_log_2016_06_30_21_26_07.txt, from the companion spreadsheet
// prsWithPrInMeters.csv in the same repository: svid → [tRxNanos, tTxNanos].
// Its FullBiasNanos was rounded by the spreadsheet, so its tRx carries a
// common clock offset; satellite-to-satellite differences are exact.
const GOOGLE_EPOCH_1: Record<number, [number, number]> = {
  2: [422785397177856, 422785326362991],
  3: [422785397177856, 422785311363053],
  6: [422785397177856, 422785328163761],
  12: [422785397177856, 422785324936930],
  17: [422785397177856, 422785318856058],
  19: [422785397177856, 422785325657035],
  24: [422785397177856, 422785327049795],
  25: [422785397177856, 422785314216671],
  28: [422785397177856, 422785314964982],
};

describe('parseAndroidGnssLog — Google demo log', () => {
  const text = readFileSync(
    join(FIX, 'android_gnsslogger_google_slice.txt'),
    'utf8'
  );
  const log = parseAndroidGnssLog(text);

  it('reads the epochs, signals and record census', () => {
    expect(isAndroidGnssLog(text)).toBe(true);
    expect(log.epochs.length).toBe(40);
    expect(log.messageCounts.Raw).toBe(265);
    expect(log.obsCodes).toEqual({ G: ['1C'] });
  });

  it('reproduces Google’s pseudoranges between satellites to the millimetre', () => {
    const e = log.epochs[0]!;
    const ours = new Map(e.meas.map((m) => [m.prn, m.pr]));
    const diffs: number[] = [];
    for (const [svid, [tRx, tTx]] of Object.entries(GOOGLE_EPOCH_1)) {
      const pr = ours.get(`G${svid.padStart(2, '0')}`);
      if (pr == null) continue;
      diffs.push(pr - (tRx - tTx) * 1e-9 * C_LIGHT);
    }
    expect(diffs.length).toBeGreaterThanOrEqual(8);
    // One common clock offset (the spreadsheet's rounded bias), nothing else.
    expect(Math.max(...diffs) - Math.min(...diffs)).toBeLessThan(0.001);
  });

  it('time-tags epochs in GPS time from the hardware clock', () => {
    const t = new Date(log.epochs[0]!.timeMs);
    // 2016-06-30, ~21:26 local in the log name; GPS week 1903.
    expect(t.toISOString().slice(0, 10)).toBe('2016-06-30');
    const dt = log.epochs[1]!.timeMs - log.epochs[0]!.timeMs;
    expect(dt).toBeCloseTo(1000, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  Synthetic rows: the per-constellation rules                         */
/* ------------------------------------------------------------------ */

const COLS = [
  'Raw',
  'utcTimeMillis',
  'TimeNanos',
  'LeapSecond',
  'TimeUncertaintyNanos',
  'FullBiasNanos',
  'BiasNanos',
  'BiasUncertaintyNanos',
  'DriftNanosPerSecond',
  'DriftUncertaintyNanosPerSecond',
  'HardwareClockDiscontinuityCount',
  'Svid',
  'TimeOffsetNanos',
  'State',
  'ReceivedSvTimeNanos',
  'ReceivedSvTimeUncertaintyNanos',
  'Cn0DbHz',
  'PseudorangeRateMetersPerSecond',
  'PseudorangeRateUncertaintyMetersPerSecond',
  'AccumulatedDeltaRangeState',
  'AccumulatedDeltaRangeMeters',
  'AccumulatedDeltaRangeUncertaintyMeters',
  'CarrierFrequencyHz',
  'CarrierCycles',
  'CarrierPhase',
  'CarrierPhaseUncertainty',
  'MultipathIndicator',
  'SnrInDb',
  'ConstellationType',
  'AgcDb',
  'BasebandCn0DbHz',
  'FullInterSignalBiasNanos',
  'FullInterSignalBiasUncertaintyNanos',
  'SatelliteInterSignalBiasNanos',
  'SatelliteInterSignalBiasUncertaintyNanos',
  'CodeType',
  'ChipsetElapsedRealtimeNanos',
];

// Receiver at GPS week 2300, 100000.000000000 s of week, exactly: TimeNanos
// minus FullBiasNanos is that instant (BiasNanos 0).
const WEEK_NS = 604_800_000_000_000n;
const RX_WEEK_NS = 100_000_000_000_000n;
const TIME_NANOS = 5_000_000_000n;
const FULL_BIAS = -(2300n * WEEK_NS + RX_WEEK_NS - TIME_NANOS);
const TAU_NS = 70_000_000; // 70 ms travel → 20 985 km

function row(
  o: Partial<Record<(typeof COLS)[number], string | number>>,
  timeNanos = TIME_NANOS
): string {
  const v: Record<string, string | number> = {
    Raw: 'Raw',
    utcTimeMillis: 0,
    TimeNanos: timeNanos.toString(),
    LeapSecond: 18,
    FullBiasNanos: FULL_BIAS.toString(),
    BiasNanos: 0,
    HardwareClockDiscontinuityCount: 1,
    TimeOffsetNanos: 0,
    State: 0x4009, // code lock + TOW decoded/known
    ReceivedSvTimeUncertaintyNanos: 10,
    Cn0DbHz: 40,
    PseudorangeRateMetersPerSecond: -100,
    AccumulatedDeltaRangeState: 0x9, // valid + half-cycle resolved
    AccumulatedDeltaRangeMeters: 1000,
    AccumulatedDeltaRangeUncertaintyMeters: 0.005,
    CarrierFrequencyHz: 1575.42e6,
    ConstellationType: 1,
    ...o,
  };
  return COLS.map((c) => v[c] ?? '').join(',');
}
const header = `\uFEFF# \n# Version: v3.1.0.0 Platform: 14 Manufacturer: acme Model: X1\n# ${COLS.join(',')}\n`;
/** ReceivedSvTimeNanos for a signal that left TAU_NS before reception. */
const svTime = (rxWeekNs: bigint, extraNs = 0n) =>
  (rxWeekNs - BigInt(TAU_NS) + extraNs).toString();

describe('parseAndroidGnssLog — constellation rules', () => {
  it('rebuilds pseudoranges for GPS, Galileo, BeiDou (BDT) and GLONASS (TOD)', () => {
    const gloTodNs =
      (RX_WEEK_NS % 86_400_000_000_000n) +
      10_800_000_000_000n -
      18_000_000_000n -
      BigInt(TAU_NS);
    const text =
      header +
      [
        row({ Svid: 5, ReceivedSvTimeNanos: svTime(RX_WEEK_NS) }),
        row({
          Svid: 11,
          ConstellationType: 6,
          CarrierFrequencyHz: 1176.45e6,
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS),
        }),
        row({
          Svid: 30,
          ConstellationType: 5,
          CarrierFrequencyHz: 1561.098e6,
          // BDT = GPS − 14 s
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS, -14_000_000_000n),
        }),
        row({
          Svid: 7,
          ConstellationType: 3,
          State: 0x8081, // code lock + GLONASS TOD decoded/known
          CarrierFrequencyHz: 1602e6 + 5 * 0.5625e6,
          ReceivedSvTimeNanos: gloTodNs.toString(),
        }),
      ].join('\n');
    const log = parseAndroidGnssLog(text);
    expect(log.device).toEqual({
      manufacturer: 'acme',
      model: 'X1',
      version: 'v3.1.0.0',
    });
    const e = log.epochs[0]!;
    const by = new Map(e.meas.map((m) => [`${m.prn} ${m.code}`, m]));
    const want = TAU_NS * 1e-9 * C_LIGHT;
    for (const k of ['G05 1C', 'E11 5Q', 'C30 2I', 'R07 1C'])
      expect(by.get(k)?.pr, k).toBeCloseTo(want, 3);
    expect(by.get('R07 1C')!.gloChannel).toBe(5);
    expect(e.timeMs).toBe(
      Date.UTC(1980, 0, 6) + 2300 * 604_800_000 + 100_000_000
    );
    expect(log.obsCodes).toEqual({
      G: ['1C'],
      E: ['5Q'],
      C: ['2I'],
      R: ['1C'],
    });
  });

  it('converts carrier phase, Doppler and the CodeType attribute', () => {
    const text =
      header +
      row({
        Svid: 5,
        CarrierFrequencyHz: 1176.45e6,
        CodeType: 'I',
        ReceivedSvTimeNanos: svTime(RX_WEEK_NS),
      });
    const m = parseAndroidGnssLog(text).epochs[0]!.meas[0]!;
    const lambda = C_LIGHT / 1176.45e6;
    expect(m.code).toBe('5I');
    expect(m.cp).toBeCloseTo(1000 / lambda, 6);
    expect(m.doppler).toBeCloseTo(100 / lambda, 6);
    expect(m.halfCycleAmbiguous).toBe(false);
  });

  it('maps SBAS and QZSS svids to RINEX PRNs and drops slot-less GLONASS', () => {
    const text =
      header +
      [
        row({
          Svid: 123,
          ConstellationType: 2,
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS),
        }),
        row({
          Svid: 194,
          ConstellationType: 4,
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS),
        }),
        row({
          Svid: 98, // FCN+100: no orbital slot
          ConstellationType: 3,
          State: 0x8081,
          CarrierFrequencyHz: 1602e6,
          ReceivedSvTimeNanos: '0',
        }),
      ].join('\n');
    const log = parseAndroidGnssLog(text);
    expect(log.epochs[0]!.meas.map((m) => m.prn).sort()).toEqual([
      'J02',
      'S23',
    ]);
    expect(log.rejected).toBe(1);
  });

  it('drops measurements without code lock or a resolved time of week', () => {
    const text =
      header +
      [
        row({ Svid: 1, State: 0x1, ReceivedSvTimeNanos: svTime(RX_WEEK_NS) }),
        row({
          Svid: 2,
          State: 0x4008,
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS),
        }),
        row({
          Svid: 3,
          State: 0x4019, // millisecond-ambiguous
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS),
        }),
        // 100 ms Galileo ambiguity: travel time far outside 60–160 ms
        row({
          Svid: 4,
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS, -200_000_000n),
        }),
      ].join('\n');
    const log = parseAndroidGnssLog(text);
    expect(log.epochs.length).toBe(0);
    expect(log.rejected).toBe(4);
  });

  it('restarts the lock time at a cycle slip and keeps one clock bias per segment', () => {
    const at = (s: number, adrState: number, biasNs = 0, disc = 1) => {
      const tn = TIME_NANOS + BigInt(s) * 1_000_000_000n;
      return row(
        {
          Svid: 5,
          AccumulatedDeltaRangeState: adrState,
          BiasNanos: biasNs,
          HardwareClockDiscontinuityCount: disc,
          ReceivedSvTimeNanos: svTime(RX_WEEK_NS + BigInt(s) * 1_000_000_000n),
        },
        tn
      );
    };
    const text =
      header +
      [
        at(0, 0x9),
        at(1, 0x9),
        at(2, 0x9 | 0x4), // cycle slip
        at(3, 0x9),
        // The phone re-estimates BiasNanos each epoch; within a segment the
        // first value is kept, so code and phase stay on one clock.
        at(4, 0x9, 50),
      ].join('\n');
    const ms = parseAndroidGnssLog(text).epochs.map((e) => e.meas[0]!);
    expect(ms.map((m) => m.lockTimeMs)).toEqual([0, 1000, 0, 1000, 2000]);
    const want = TAU_NS * 1e-9 * C_LIGHT;
    expect(ms[4]!.pr).toBeCloseTo(want, 3);
  });
});

describe('parseAndroidGnssLog — phone fixes', () => {
  it('reads Fix rows by their header', () => {
    const text = [
      '# Fix,Provider,LatitudeDegrees,LongitudeDegrees,AltitudeMeters,SpeedMetersPerSecond,AccuracyMeters,BearingDegrees,UnixTimeMillis',
      'Fix,GPS,52.0116,4.3571,45.2,0.0,3.8,0.0,1713027213426',
      'Fix,FLP,52.0117,4.3572,,0.0,5.1,0.0,1713027214426',
    ].join('\n');
    const log = parseAndroidGnssLog(text);
    expect(log.fixes).toEqual([
      {
        utcMs: 1713027213426,
        provider: 'GPS',
        latDeg: 52.0116,
        lonDeg: 4.3571,
        altM: 45.2,
        accuracyM: 3.8,
      },
      {
        utcMs: 1713027214426,
        provider: 'FLP',
        latDeg: 52.0117,
        lonDeg: 4.3572,
        altM: null,
        accuracyM: 5.1,
      },
    ]);
    expect(log.messageCounts.Fix).toBe(2);
    expect(isAndroidGnssLog(text)).toBe(false); // no Raw measurements
  });
});
