import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseTrimble, parseTrimbleNav } from '../src/trimble';

const FILE = join(__dirname, '../test-fixtures/dlf100_rt27_slice.t02');

const C_LIGHT = 299792458.0;

/**
 * The slice is one complete RT27 measurement epoch cut from a 60 s
 * capture of the TU Delft ALLOY mount DLF100NLD1 (2026-07-24, 1 Hz,
 * multi-constellation) — the 15-page main RAWDATA message plus its
 * 3-page reply-matched continuation (the epoch's 51 satellites do not
 * fit in one 15-page message) — followed by one RETSVDATA frame for
 * framing coverage. RTKLIB does not decode record type 27; expected
 * values are internal-consistency checks: carrier phase reconstructs
 * the pseudorange (|L|·λ ≈ P), the satellite count and per-constellation
 * breakdown match the sibling RTCM mount, and SNR/Doppler are physical.
 */
describe.skipIf(!existsSync(FILE))('parseTrimble (DLF100 RT27 slice)', () => {
  const raw = existsSync(FILE) ? new Uint8Array(readFileSync(FILE)) : null!;
  const res = raw ? parseTrimble(raw) : null!;

  it('frames the stream: one epoch, clean checksums', () => {
    expect(res.epochs.length).toBe(1);
    expect(res.badChecksum).toBe(0);
    expect(res.recordCounts[6]).toBe(18); // 15-page main + 3-page companion
    expect(res.retsvCounts[27]).toBe(1); // appended RETSVDATA frame
  });

  it('decodes receiver time in the RINEX parser convention', () => {
    // GPS week 2428, tow 473407.000 s → 2026-07-24 11:30:07 (GPS scale)
    expect(res.epochs[0]!.timeMs).toBe(Date.UTC(2026, 6, 24, 11, 30, 7));
  });

  it('decodes all 51 satellites across five constellations', () => {
    const meas = res.epochs[0]!.meas;
    expect(meas.length).toBe(199);
    const sats = new Set(meas.map((m) => m.prn));
    const bySys = (s: string) =>
      new Set([...sats].filter((p) => p[0] === s)).size;
    expect(bySys('G')).toBe(12);
    expect(bySys('R')).toBe(10);
    expect(bySys('E')).toBe(12);
    expect(bySys('C')).toBe(14);
    expect(bySys('S')).toBe(3);
  });

  it('maps signals to RINEX observation codes', () => {
    expect(res.obsCodes['G']!.sort()).toEqual(['1C', '1L', '2L', '2W', '5X']);
    expect(res.obsCodes['R']!.sort()).toEqual(['1C', '1P', '2C', '2P']);
    expect(res.obsCodes['E']!.sort()).toEqual(['1C', '5Q', '6C', '7Q', '8Q']);
    expect(res.obsCodes['C']!.sort()).toEqual(['1P', '2I', '5P', '6I', '7D']);
    expect(res.obsCodes['S']!.sort()).toEqual(['1C', '5I']);
  });

  const at = (prn: string, code: string) =>
    res.epochs[0]!.meas.find((m) => m.prn === prn && m.code === code);

  it('decodes physically plausible pseudorange, phase, Doppler and SNR', () => {
    const g01 = at('G01', '1C')!;
    expect(g01.pr!).toBeCloseTo(23564591.086, 2);
    expect(g01.cp!).toBeCloseTo(123832732.862, 2);
    expect(g01.doppler!).toBeCloseTo(-3546.715, 2);
    expect(g01.cn0).toBeCloseTo(45.9, 5);
    expect(g01.gloChannel).toBeNull();

    const r09 = at('R09', '1C')!;
    expect(r09.pr!).toBeCloseTo(23126320.852, 2);
    expect(r09.gloChannel).not.toBeNull();

    // Geostationary SBAS: Doppler is near zero, range is a GEO range.
    const s27 = at('S27', '1C')!;
    expect(s27.pr!).toBeGreaterThan(3.7e7);
    expect(Math.abs(s27.doppler!)).toBeLessThan(50);
  });

  it('carrier phase reconstructs the pseudorange (|L|·λ ≈ P)', () => {
    const freq: Record<string, number> = {
      '1': 1575.42e6,
      '2': 1227.6e6,
      '5': 1176.45e6,
    };
    let checked = 0;
    for (const m of res.epochs[0]!.meas) {
      if (m.prn[0] !== 'G' || m.pr === null || m.cp === null) continue;
      const f = freq[m.code[0]!];
      if (!f) continue;
      const lambda = C_LIGHT / f;
      // |L|·λ agrees with P to ~1 ppm (a wrong band digit would be off
      // by whole percent), proving the frequency assignment per signal.
      expect(Math.abs(Math.abs(m.cp) * lambda - m.pr) / m.pr).toBeLessThan(
        2e-6
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('reports the RETSVDATA subtype but decodes no GPS ephemeris', () => {
    const nav = parseTrimbleNav(raw);
    expect(nav.badChecksum).toBe(0);
    expect(nav.retsvCounts[27]).toBe(1);
    expect(nav.ephemerides.length).toBe(0); // no subtype-1 frames present
  });
});

/**
 * Real GPS ephemeris from a longer DLF100NLD1 capture (RETSVDATA
 * subtype 1). These records are 176 data bytes — the previous `f.len >=
 * 178` gate was off by two and silently dropped every real GPS
 * ephemeris (only the 180-byte synthetic record below ever passed).
 */
const GPSNAV_FILE = join(
  __dirname,
  '../test-fixtures/dlf100_rt27_gpsnav_slice.t02'
);
describe.skipIf(!existsSync(GPSNAV_FILE))(
  'parseTrimbleNav (DLF100 real GPS ephemeris)',
  () => {
    const raw = new Uint8Array(readFileSync(GPSNAV_FILE));

    const gpsOnly = () =>
      parseTrimbleNav(raw).ephemerides.filter((e) => e.prn[0] === 'G');

    it('decodes the 176-byte subtype-1 records into GPS ephemerides', () => {
      expect(gpsOnly().length).toBeGreaterThanOrEqual(5);
    });

    it('produces physically plausible GPS orbits', () => {
      for (const e of gpsOnly()) {
        if (!('sqrtA' in e)) continue;
        expect(e.sqrtA).toBeGreaterThan(5153);
        expect(e.sqrtA).toBeLessThan(5154); // GPS MEO √a ≈ 5153.6 m^½
        expect(e.e).toBeLessThan(0.03);
        expect(e.i0).toBeGreaterThan(0.9); // ≈ 55°
        expect(e.i0).toBeLessThan(1.05);
        expect(e.week).toBeGreaterThan(2000);
      }
    });

    it('decodes the 123-byte ION/UTC record (Klobuchar + leap seconds)', () => {
      const nav = parseTrimbleNav(raw);
      expect(nav.leapSeconds).toBe(18);
      expect(nav.ionoCorrections['GPSA']).toHaveLength(4);
      expect(nav.ionoCorrections['GPSB']).toHaveLength(4);
      expect(Math.abs(nav.ionoCorrections['GPSA']![0]!)).toBeLessThan(1e-7);
    });

    it('decodes GLONASS ephemerides (RETSVDATA subtype 9) as a state vector', () => {
      const glo = parseTrimbleNav(raw).ephemerides.filter(
        (e) => e.prn[0] === 'R'
      );
      expect(glo.length).toBeGreaterThanOrEqual(5);
      for (const e of glo) {
        if (!('x' in e)) continue;
        // PZ-90 orbit radius ≈ 25,510 km (GLONASS MEO), speed ≈ 3.4 km/s.
        const r = Math.hypot(e.x, e.y, e.z);
        expect(r).toBeGreaterThan(25000);
        expect(r).toBeLessThan(26000);
        expect(Math.hypot(e.xDot, e.yDot, e.zDot)).toBeGreaterThan(2.5);
        expect(Math.hypot(e.xDot, e.yDot, e.zDot)).toBeLessThan(4.5);
        expect(e.freqNum).toBeGreaterThanOrEqual(-7);
        expect(e.freqNum).toBeLessThanOrEqual(6);
        expect(Math.abs(e.tauN)).toBeLessThan(1e-3);
        expect(e.tocDate.getUTCMinutes() % 15).toBe(0); // GLONASS 15-min tb
      }
    });

    it('decodes BeiDou ephemerides (RETSVDATA subtype 21) on the BDT scale', () => {
      const bds = parseTrimbleNav(raw).ephemerides.filter(
        (e) => e.prn[0] === 'C'
      );
      expect(bds.length).toBeGreaterThanOrEqual(5);
      for (const e of bds) {
        if (!('sqrtA' in e)) continue;
        expect(e.sqrtA).toBeGreaterThan(5282); // BeiDou MEO √a ≈ 5282.6 m^½
        expect(e.sqrtA).toBeLessThan(5284);
        expect(e.e).toBeLessThan(0.02);
        // BDT week = GPS week − 1356 (≈ 1073 for 2026); tocDate on the BDT
        // calendar lands on a clean broadcast boundary (GPST − 14 s).
        expect(e.week).toBeGreaterThan(1000);
        expect(e.week).toBeLessThan(1356);
        expect(e.tocDate.getUTCSeconds()).toBe(0);
      }
    });
  }
);

/**
 * The original DLF100 slice carried no GPS ephemeris (RETSVDATA subtype
 * 1), so the ported RTKLIB GPS-ephemeris path is also exercised with a
 * synthetic record built to the ICD layout: it checks the big-endian
 * field offsets, the semicircle→radian (×π) scaling and the PRN/week
 * mapping.
 */
describe('parseTrimbleNav (synthetic GPS ephemeris)', () => {
  function buildEphFrame(): Uint8Array {
    const len = 180;
    const buf = new Uint8Array(4 + len + 2);
    const dv = new DataView(buf.buffer);
    buf[0] = 0x02; // STX
    buf[1] = 0x00; // status
    buf[2] = 0x55; // RETSVDATA
    buf[3] = len;
    // Fields at STX-relative offsets (ICD record).
    buf[4] = 1; // subtype: GPS ephemeris
    buf[5] = 5; // PRN
    dv.setUint16(6, 2300, false); // week
    dv.setUint16(8, 42, false); // IODC
    buf[11] = 77; // IODE
    dv.setInt32(12, 400000, false); // TOW
    dv.setInt32(16, 403200, false); // TOC (s)
    dv.setUint32(20, 403200, false); // TOE (s)
    dv.setFloat64(24, -5e-9, false); // TGD
    dv.setFloat64(32, 0, false); // AF2
    dv.setFloat64(40, 1e-12, false); // AF1
    dv.setFloat64(48, 1.5e-4, false); // AF0
    dv.setFloat64(56, 30.5, false); // CRS
    dv.setFloat64(64, 1.3e-9, false); // DELTA N (semicircles/s)
    dv.setFloat64(72, 0.25, false); // M0 (semicircles)
    dv.setFloat64(80, 1e-6, false); // CUC
    dv.setFloat64(88, 0.004, false); // e
    dv.setFloat64(96, 2e-6, false); // CUS
    dv.setFloat64(104, 5153.65, false); // sqrt(A)
    dv.setFloat64(112, 5e-8, false); // CIC
    dv.setFloat64(120, -0.5, false); // OMEGA0 (semicircles)
    dv.setFloat64(128, -1e-8, false); // CIS
    dv.setFloat64(136, 0.3, false); // i0 (semicircles)
    dv.setFloat64(144, 250.0, false); // CRC
    dv.setFloat64(152, -0.6, false); // omega (semicircles)
    dv.setFloat64(160, -8e-9, false); // OMEGA DOT (semicircles/s)
    dv.setFloat64(168, 1e-10, false); // IDOT (semicircles/s)
    dv.setUint32(176, 0b1010 << 4, false); // FLAGS: SV health = 0b1010
    // Checksum over status..last data byte.
    let cs = 0;
    for (let k = 1; k <= 3 + len; k++) cs = (cs + buf[k]!) & 0xff;
    buf[4 + len] = cs;
    buf[4 + len + 1] = 0x03; // ETX
    return buf;
  }

  const nav = parseTrimbleNav(buildEphFrame());

  it('decodes one GPS ephemeris with π-scaled angles', () => {
    expect(nav.retsvCounts[1]).toBe(1);
    expect(nav.ephemerides.length).toBe(1);
    const e = nav.ephemerides[0]!;
    expect(e.system).toBe('G');
    expect(e.prn).toBe('G05');
    if (e.system !== 'R') {
      expect(e.week).toBe(2300);
      expect(e.iode).toBe(77);
      expect(e.e).toBeCloseTo(0.004, 12);
      expect(e.sqrtA).toBeCloseTo(5153.65, 6);
      expect(e.af0).toBeCloseTo(1.5e-4, 12);
      expect(e.m0).toBeCloseTo(0.25 * Math.PI, 9); // semicircle → radian
      expect(e.i0).toBeCloseTo(0.3 * Math.PI, 9);
      expect(e.svHealth).toBe(0b1010);
      expect(e.toe).toBe(403200);
    }
  });

  it('suppresses an unchanged repeat (same IODE)', () => {
    const f = buildEphFrame();
    const two = new Uint8Array(f.length * 2);
    two.set(f, 0);
    two.set(f, f.length);
    expect(parseTrimbleNav(two).ephemerides.length).toBe(1);
  });
});
