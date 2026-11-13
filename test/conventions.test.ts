/**
 * Convention locks: every place a parsed tuple or signed/united scalar
 * crosses from a format into a computation. Each test uses asymmetric values
 * (or real data) so that swapping two axes, flipping a sign or changing a
 * unit makes it fail. The PCO N/E swap (2.45.0) was in a consumer, not a
 * reader — a reader/writer round trip cannot see that kind of error, these
 * tests can. Spec references are given per block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { antDeltaToEnu, parseRinexHeaderText } from '../src/rinex/parser';
import { writeSinex, parseSinexEstimates } from '../src/rinex/sinex';
import {
  enuToEcef,
  interpPcv,
  satBodyFrame,
  type AntennaOffset,
} from '../src/positioning/ppp-antenna';
import { createPppCorrections } from '../src/positioning';
import { oceanLoadingEnu, parseBlq } from '../src/positioning/ocean-loading';
import { getAer, ecefToGeodetic, geodeticToEcef } from '../src/coordinates';
import { transformFrame, plateVelocity } from '../src/frames';
import { parseUbxRawx } from '../src/ubx';
import { parseSbfMeas } from '../src/sbf';
import { parseNovatelRange } from '../src/novatel';
import { parseAndroidGnssLog } from '../src/android';
import { Rtcm3Decoder } from '../src/rtcm3/decoder';
import { decodeMsmFull, resetGloFreqCache } from '../src/rtcm3/msm';

const FIX = join(__dirname, '..', 'test-fixtures');
type V3 = [number, number, number];
const D2R = Math.PI / 180;
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** Local [E, N, U] of `b − a` at a's position. */
function enuOf(a: V3, b: V3): V3 {
  const [lat, lon] = ecefToGeodetic(a[0], a[1], a[2]);
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return [
    dot(enuToEcef([1, 0, 0], lat, lon), d),
    dot(enuToEcef([0, 1, 0], lat, lon), d),
    dot(enuToEcef([0, 0, 1], lat, lon), d),
  ];
}

/* ------------------------------------------------------------------ */
/*  RINEX "ANTENNA: DELTA H/E/N" → positioning [E, N, U]               */
/* ------------------------------------------------------------------ */

describe('RINEX ANTENNA: DELTA H/E/N', () => {
  // RINEX 3.04 Table A2: F14.4 antenna height (ARP above marker), then
  // 2F14.4 horizontal eccentricity "east/north". Real IGS headers with a
  // non-zero horizontal component make the order visible.
  const head = (f: string) =>
    parseRinexHeaderText(readFileSync(join(FIX, f), 'latin1').slice(0, 60000))!;

  it('keeps the file order [H, E, N] (AREG: E = −0.6 mm; BRUX: N = 1.0 mm)', () => {
    expect(head('AREG.crx').antDelta).toEqual([0.4291, -0.0006, 0]);
    expect(head('BRUX.crx').antDelta).toEqual([0.4689, 0, 0.001]);
  });

  it('antDeltaToEnu maps [H, E, N] to [E, N, U]', () => {
    expect(antDeltaToEnu([0.4291, -0.0006, 0.0013])).toEqual([
      -0.0006, 0.0013, 0.4291,
    ]);
    expect(antDeltaToEnu(null)).toEqual([0, 0, 0]);
  });

  it('a header delta fed through antDeltaToEnu raises the antenna, not the east', () => {
    // An uncalibrated type isolates the delta (no PCO). Zenith satellite:
    // the range shortens by exactly H; a satellite due east by exactly E.
    const lat = 52 * D2R;
    const lon = 4.4 * D2R;
    const rcv = geodeticToEcef(lat, lon, 50) as V3;
    const range = (losEnu: V3, hen: V3) => {
      const los = enuToEcef(losEnu, lat, lon);
      return createPppCorrections({
        antenna: { satOffset: () => null, rcvOffset: () => null },
        rcvAntType: 'UNKNOWN',
        antDeltaEnu: antDeltaToEnu(hen),
        satPco: false,
        tides: false,
        windup: false,
      }).evaluate!(
        {
          prn: 'G01',
          satEcef: [
            rcv[0] + los[0] * 2e7,
            rcv[1] + los[1] * 2e7,
            rcv[2] + los[2] * 2e7,
          ],
          rcvEcef: rcv,
          los,
          elRad: Math.asin(losEnu[2]),
          azRad: Math.atan2(losEnu[0], losEnu[1]),
          f1: 1575.42e6,
          f2: 1227.6e6,
          band1: 'G01',
          band2: 'G02',
          g: 2.546,
        },
        null
      ).rangeM;
    };
    const hen: V3 = [1.5, 0.2, -0.07];
    expect(range([0, 0, 1], hen)).toBeCloseTo(-1.5, 9); // zenith: −H
    expect(range([1, 0, 0], hen)).toBeCloseTo(-0.2, 9); // east: −E
    expect(range([0, 1, 0], hen)).toBeCloseTo(0.07, 9); // north: −N
  });
});

/* ------------------------------------------------------------------ */
/*  ANTEX PCV azimuth and the satellite body frame                     */
/* ------------------------------------------------------------------ */

describe('ANTEX angular conventions', () => {
  // ANTEX 1.4 §3: receiver PCV azimuth "counts clockwise from the North
  // toward the East"; satellite body frame z → geocentre, y = z × (sun −
  // sat), x completes the right-handed system.
  it('receiver PCV row 0 is north and rows step clockwise (east = 90°)', () => {
    // Row j carries the constant value j mm: the azimuth that is read back
    // identifies the row.
    const off: AntennaOffset = {
      pco: [0, 0, 0],
      pcvZen1Deg: 0,
      pcvDzenDeg: 5,
      pcvNoazi: [0, 0, 0],
      pcvDaziDeg: 30,
      pcvAzi: Array.from({ length: 13 }, (_, j) =>
        [j, j, j].map((v) => v / 1000)
      ),
    };
    expect(interpPcv(off, 10, 0)).toBeCloseTo(0.0, 12); // north
    expect(interpPcv(off, 10, 90)).toBeCloseTo(0.003, 12); // east = row 3
    expect(interpPcv(off, 10, 270)).toBeCloseTo(0.009, 12); // west = row 9
    expect(interpPcv(off, 10, -90)).toBeCloseTo(0.009, 12); // wraps
    expect(interpPcv(off, 10, 45)).toBeCloseTo(0.0015, 12); // between rows
  });

  it('satellite body frame: z to Earth, y = z × sun, x toward the sun side', () => {
    const sat: V3 = [26_000e3, 0, 0];
    const sun: V3 = [0, 1.5e11, 0];
    const f = satBodyFrame(sat, sun);
    expect(f.z[0]).toBeCloseTo(-1, 9); // toward the geocentre
    expect(f.y[2]).toBeCloseTo(-1, 6); // (−x̂) × ŷ = −ẑ
    expect(f.x[1]).toBeCloseTo(1, 6); // y × z = +ŷ: sun side
  });
});

/* ------------------------------------------------------------------ */
/*  Azimuth / elevation                                                */
/* ------------------------------------------------------------------ */

describe('getAer', () => {
  it('returns [elevation, azimuth, range] (not az first) with azimuth clockwise from north', () => {
    const lat = 40 * D2R;
    const lon = -3.7 * D2R;
    const rx = geodeticToEcef(lat, lon, 600) as V3;
    // A target 1 km east and 0.5 km up: el = atan(0.5), az = +90°.
    const d = enuToEcef([1000, 0, 500], lat, lon);
    const [el, az, r] = getAer(
      rx[0] + d[0],
      rx[1] + d[1],
      rx[2] + d[2],
      rx[0],
      rx[1],
      rx[2]
    );
    expect(el).toBeCloseTo(Math.atan2(500, 1000), 9);
    expect(az).toBeCloseTo(Math.PI / 2, 9);
    expect(r).toBeCloseTo(Math.hypot(1000, 500), 6);
    // North-west target: az = −45° (atan2 range), i.e. 315°.
    const nw = enuToEcef([-300, 300, 0], lat, lon);
    const [, az2] = getAer(
      rx[0] + nw[0],
      rx[1] + nw[1],
      rx[2] + nw[2],
      rx[0],
      rx[1],
      rx[2]
    );
    expect(az2).toBeCloseTo(-Math.PI / 4, 9);
  });
});

/* ------------------------------------------------------------------ */
/*  BLQ (Onsala): rows radial, tangential EW (west), tangential NS     */
/*  (south); "positive in upwards, South and West direction"           */
/* ------------------------------------------------------------------ */

describe('BLQ ocean loading', () => {
  // Six distinct rows: amplitude radial/west/south then phase radial/west/
  // south. A row swap moves a value to the wrong axis.
  const row = (base: number) =>
    Array.from({ length: 11 }, (_, k) => (base + k * 0.0001).toFixed(5)).join(
      ' '
    );
  const prow = (base: number) =>
    Array.from({ length: 11 }, (_, k) => (base + k).toFixed(1)).join(' ');
  const blq = [
    '$$ Ocean loading displacement',
    '  ONSA',
    '$$ Onsala',
    row(0.01),
    row(0.002),
    row(0.0003),
    prow(-10),
    prow(20),
    prow(-150),
  ].join('\n');

  it('parses amplitude rows as [radial, west, south] and phases likewise', () => {
    const c = parseBlq(blq).get('ONSA')!;
    expect(c.amplitude[0]).toEqual([0.01, 0.002, 0.0003]); // M2
    expect(c.amplitude[10]![1]).toBeCloseTo(0.003, 9); // Ssa west
    expect(c.phase[0]).toEqual([-10, 20, -150]);
    expect(c.phase[4]).toEqual([-6, 24, -146]); // K1
  });

  it('turns [radial, west, south] into [E, N, U] = [−west, −south, radial]', () => {
    const c = parseBlq(blq).get('ONSA')!;
    const flip = (k: 0 | 1 | 2) =>
      ({
        amplitude: c.amplitude.map((a) => a.map((v, i) => (i === k ? v : 0))),
        phase: c.phase,
      }) as typeof c;
    const t = Date.UTC(2025, 6, 1, 3, 17);
    const enu = oceanLoadingEnu(c, t);
    const r = oceanLoadingEnu(flip(0), t);
    const w = oceanLoadingEnu(flip(1), t);
    const s = oceanLoadingEnu(flip(2), t);
    expect(enu[2]).toBeCloseTo(r[2], 15);
    expect(enu[0]).toBeCloseTo(w[0], 15);
    expect(enu[1]).toBeCloseTo(s[1], 15);
    expect(r[0]).toBe(-0);
    expect(w[1]).toBe(-0);
    expect(s[0]).toBe(-0);
  });

  it('the PPP corrections rotate the OTL ENU into ECEF at the station', () => {
    const c = parseBlq(blq).get('ONSA')!;
    const lat = 57.395 * D2R;
    const lon = 11.926 * D2R;
    const rcv = geodeticToEcef(lat, lon, 45) as V3;
    const t = Date.UTC(2025, 6, 1, 3, 17);
    const ctx = createPppCorrections({
      antenna: { satOffset: () => null, rcvOffset: () => null },
      rcvAntType: '',
      tides: false,
      oceanLoading: c,
    }).epochContext!(t, rcv) as { tideDisp: V3 };
    const want = oceanLoadingEnu(c, t);
    const e = enuToEcef([1, 0, 0], lat, lon);
    const n = enuToEcef([0, 1, 0], lat, lon);
    const u = enuToEcef([0, 0, 1], lat, lon);
    expect(dot(e, ctx.tideDisp)).toBeCloseTo(want[0], 12);
    expect(dot(n, ctx.tideDisp)).toBeCloseTo(want[1], 12);
    expect(dot(u, ctx.tideDisp)).toBeCloseTo(want[2], 12);
  });
});

/* ------------------------------------------------------------------ */
/*  SINEX: STAX/STAY/STAZ in m, VELX/VELY/VELZ in m/y                  */
/* ------------------------------------------------------------------ */

describe('SINEX estimate order and units', () => {
  it('writes and reads X/Y/Z and VX/VY/VZ in place, metres and m/y', () => {
    const xyz: V3 = [3_924_687.7039, 301_132.7618, 5_001_910.7712];
    const vel: V3 = [-0.0142, 0.0171, 0.0093];
    const t = Date.UTC(2025, 0, 15, 12);
    const text = writeSinex({
      agency: 'TST',
      stations: [
        {
          code: 'DELF',
          refEpochMs: t,
          dataStartMs: t - 43_200_000,
          dataEndMs: t + 43_199_000,
          xyz,
          vel,
          cov: Array.from({ length: 6 }, (_, i) =>
            Array.from({ length: 6 }, (_, j) => (i === j ? (i + 1) * 1e-6 : 0))
          ),
        },
      ],
      createdMs: t,
    });
    expect(text).toMatch(/ VELX {3}DELF .* m\/y {2}2 -1\.4200/);
    const e = parseSinexEstimates(text).get('DELF 1')!;
    for (let k = 0; k < 3; k++) {
      expect(e.xyz![k]).toBeCloseTo(xyz[k]!, 6);
      expect(e.vel![k]).toBeCloseTo(vel[k]!, 9);
      expect(e.sigmaXyz![k]).toBeCloseTo(Math.sqrt((k + 1) * 1e-6), 8);
      expect(e.sigmaVel![k]).toBeCloseTo(Math.sqrt((k + 4) * 1e-6), 8);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Frames vs plate motion: two independent sources must agree         */
/* ------------------------------------------------------------------ */

describe('Helmert rotation rates agree with the ITRF2020 plate motion model', () => {
  // The frame parameters (EUREF/EPSG, Position Vector convention after
  // negating the Coordinate-Frame NAD83/GDA sets) and the PMM poles
  // (Altamimi et al. 2023) are separate publications. A plate-fixed frame
  // must remove its plate's motion: d(frame coords)/dt of a fixed ITRF point
  // = −(plate velocity). A PV/CF sign error doubles it instead of cancelling.
  const cases: {
    name: string;
    from: Parameters<typeof transformFrame>[1];
    to: Parameters<typeof transformFrame>[2];
    plate: Parameters<typeof plateVelocity>[1];
    lat: number;
    lon: number;
    tolM: number;
  }[] = [
    {
      name: 'ETRF2020 / Eurasia (Delft)',
      from: 'ITRF2020',
      to: 'ETRF2020',
      plate: 'EURA',
      lat: 52,
      lon: 4.4,
      tolM: 0.005,
    },
    {
      name: 'GDA2020 / Australia (Canberra)',
      from: 'ITRF2014',
      to: 'GDA2020',
      plate: 'AUST',
      lat: -35.3,
      lon: 149.0,
      tolM: 0.01,
    },
    {
      name: 'NAD83(2011) / North America (Boulder)',
      from: 'ITRF2014',
      to: 'NAD83(2011)',
      plate: 'NOAM',
      lat: 40.0,
      lon: -105.3,
      tolM: 0.03,
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      const x = geodeticToEcef(c.lat * D2R, c.lon * D2R, 100) as V3;
      const a = transformFrame(x, c.from, c.to, 2020);
      const b = transformFrame(x, c.from, c.to, 2030);
      const frameDrift = enuOf(a, b); // 10 years
      const v = plateVelocity(x, c.plate);
      const plate10 = enuOf(x, [
        x[0] + 10 * v[0],
        x[1] + 10 * v[1],
        x[2] + 10 * v[2],
      ]);
      expect(Math.hypot(plate10[0], plate10[1])).toBeGreaterThan(0.15);
      expect(frameDrift[0]).toBeCloseTo(-plate10[0], 1);
      expect(Math.abs(frameDrift[0] + plate10[0])).toBeLessThan(c.tolM);
      expect(Math.abs(frameDrift[1] + plate10[1])).toBeLessThan(c.tolM);
    });

  it('GDA2020 sits ~1.5–1.8 m north-east of GDA94 (ICSM)', () => {
    // GDA2020 Technical Manual: Australia moved ~1.8 m NNE from 1994 to
    // 2020; GDA2020 coordinates are that far from the GDA94 ones.
    const x = geodeticToEcef(-35.3 * D2R, 149.0 * D2R, 600) as V3;
    const g20 = transformFrame(x, 'GDA94', 'GDA2020', 2020);
    const [e, n] = enuOf(x, g20);
    expect(n).toBeGreaterThan(1.2);
    expect(n).toBeLessThan(1.9);
    expect(e).toBeGreaterThan(0);
    expect(Math.hypot(e, n)).toBeLessThan(2.0);
  });
});

/* ------------------------------------------------------------------ */
/*  Doppler sign: RINEX 3.04 §3.4 "positive for approaching satellites" */
/*  ⇒ D ≈ −dΦ/dt (phase grows with range). Real receiver data.           */
/* ------------------------------------------------------------------ */

type MeasEpoch = {
  timeMs: number;
  meas: {
    prn: string;
    code: string;
    cp: number | null;
    doppler: number | null;
  }[];
};

/** Median of (dΦ/dt) / D over pairs of consecutive epochs, |D| > 200 Hz. */
function phaseRateOverDoppler(epochs: MeasEpoch[]): {
  n: number;
  median: number;
} {
  const r: number[] = [];
  for (let i = 1; i < epochs.length; i++) {
    const a = epochs[i - 1]!;
    const b = epochs[i]!;
    const dt = (b.timeMs - a.timeMs) / 1000;
    if (dt <= 0 || dt > 2) continue;
    for (const m of b.meas) {
      const p = a.meas.find((x) => x.prn === m.prn && x.code === m.code);
      if (
        m.cp == null ||
        p?.cp == null ||
        m.doppler == null ||
        p.doppler == null
      )
        continue;
      const d = (m.doppler + p.doppler) / 2;
      if (Math.abs(d) > 200) r.push((m.cp - p.cp) / dt / d);
    }
  }
  r.sort((x, y) => x - y);
  return { n: r.length, median: r[r.length >> 1] ?? NaN };
}

describe('Doppler sign per decoder (D = −dΦ/dt)', () => {
  const bytes = (f: string) => new Uint8Array(readFileSync(join(FIX, f)));
  const cases: [string, () => MeasEpoch[]][] = [
    ['u-blox RXM-RAWX', () => parseUbxRawx(bytes('f9p_rawx_slice.ubx')).epochs],
    [
      'Septentrio MeasEpoch',
      () => parseSbfMeas(bytes('dlf500_sbf_nav_slice.sbf')).epochs,
    ],
    [
      'NovAtel RANGE',
      () => parseNovatelRange(bytes('oem719_rtk_base.gps')).epochs,
    ],
    [
      'NovAtel RANGECMP',
      () => parseNovatelRange(bytes('oemv_rangecmp.gps')).epochs,
    ],
    [
      'RTCM3 MSM7',
      () => {
        resetGloFreqCache();
        // DLF100 splits each GPS epoch over two MSM7 messages (DF393):
        // merge them by epoch time.
        const out: MeasEpoch[] = [];
        for (const f of new Rtcm3Decoder().decode(
          bytes('dlf100_rtcm_rtk_base.rtcm')
        )) {
          const e = decodeMsmFull(f);
          if (!e || e.system !== 'G') continue;
          let ep = out[out.length - 1];
          if (ep?.timeMs !== e.epochMs)
            out.push((ep = { timeMs: e.epochMs, meas: [] }));
          for (const o of e.observations)
            for (const s of o.signals)
              ep.meas.push({
                prn: o.prn,
                code: s.rinexCode,
                cp: s.phase ?? null,
                doppler: s.doppler ?? null,
              });
        }
        return out;
      },
    ],
  ];
  for (const [name, load] of cases)
    it(name, () => {
      const { n, median } = phaseRateOverDoppler(load());
      expect(n).toBeGreaterThan(50);
      expect(median).toBeCloseTo(-1, 3);
    });

  it('Android: D = −(pseudorange rate)/λ, same sign as −dP/dt', () => {
    // The Google log has no accumulated delta range; the pseudorange
    // itself (1 Hz, |D| > 200 Hz ⇒ > 38 m/s) shows the sign.
    const { epochs } = parseAndroidGnssLog(
      readFileSync(join(FIX, 'android_gnsslogger_google_slice.txt'), 'utf8')
    );
    let agree = 0;
    let total = 0;
    for (let i = 1; i < epochs.length; i++) {
      const a = epochs[i - 1]!;
      const b = epochs[i]!;
      const dt = (b.timeMs - a.timeMs) / 1000;
      for (const m of b.meas) {
        const p = a.meas.find((x) => x.prn === m.prn && x.code === m.code);
        if (m.pr == null || p?.pr == null || m.doppler == null) continue;
        if (Math.abs(m.doppler) < 200 || m.prn[0] !== 'G') continue;
        const prRate = (m.pr - p.pr) / dt;
        total++;
        if (Math.sign(prRate) === -Math.sign(m.doppler)) agree++;
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(agree / total).toBeGreaterThan(0.95);
  });
});
