import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfNav, parseSbfAlmanac } from '../src/sbf';
import type { SbfGlonassAlmanac, SbfKeplerAlmanac } from '../src/sbf';
import type { GlonassEphemeris, KeplerEphemeris } from '../src/rinex/nav';

const NAV_FILE = join(__dirname, '../test-fixtures/tudb_nav_slice.sbf');
const ALM_FILE = join(__dirname, '../test-fixtures/dlf2_alm_slice.sbf');

/** RINEX prints ~13 significant digits; require agreement to that. */
function relClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * 1e-11 + 1e-19
  );
}

/**
 * The nav slice holds the first 3 GPSNav + 3 GLONav + 4 GALNav +
 * 3 BDSNav frames of TU Delft's TUDB PolaRx log tudb202a00.26_
 * (2026-07-21, 00:00–00:15). Expected values are pinned from RTKLIB
 * demo5 convbin's RINEX nav conversion of the same log — the full-file
 * oracle matched all 83 RINEX records (1822 fields) with a worst
 * relative difference of 4.8e-12, and a spot-check against TU Delft's
 * own sbf2rin conversion agreed on every orbital field.
 */
describe.skipIf(!existsSync(NAV_FILE))('parseSbfNav (TUDB slice)', () => {
  const res = existsSync(NAV_FILE)
    ? parseSbfNav(new Uint8Array(readFileSync(NAV_FILE)))
    : null!;

  it('decodes every nav frame with clean CRCs', () => {
    expect(res.badCrc).toBe(0);
    expect(res.ephemerides.length).toBe(13);
    const bySys: Record<string, number> = {};
    for (const e of res.ephemerides)
      bySys[e.system] = (bySys[e.system] ?? 0) + 1;
    expect(bySys).toEqual({ G: 3, E: 4, R: 3, C: 3 });
  });

  it('decodes GPSNav — G06 vs convbin RINEX', () => {
    const e = res.ephemerides.find((x) => x.prn === 'G06') as KeplerEphemeris;
    expect(e.system).toBe('G');
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 21, 0, 0, 0));
    relClose(e.af0, -0.56959502399e-3);
    relClose(e.af1, 0.795807864051e-11);
    expect(e.af2).toBe(0);
    expect(e.iode).toBe(74);
    relClose(e.crs, -33.0625);
    relClose(e.deltaN, 0.379372945263e-8);
    relClose(e.m0, 0.222763377457e1);
    relClose(e.cuc, -0.160560011864e-5);
    relClose(e.e, 0.369414687157e-2);
    relClose(e.cus, 0.623427331448e-5);
    relClose(e.sqrtA, 0.515372248459e4);
    expect(e.toe).toBe(172800);
    relClose(e.cic, -0.279396772385e-7);
    relClose(e.omega0, 0.583948441008);
    relClose(e.cis, -0.428408384323e-7);
    relClose(e.i0, 0.985883677944);
    relClose(e.crc, 273.25);
    relClose(e.omega, -0.546276439635);
    relClose(e.omegaDot, -0.776496629916e-8);
    relClose(e.idot, -0.2067943281e-9);
    expect(e.week).toBe(2428);
    expect(e.svHealth).toBe(0);
    relClose(e.tgd, 0.372529029846e-8);
  });

  it('decodes GALNav — E02 vs convbin RINEX', () => {
    const e = res.ephemerides.find((x) => x.prn === 'E02') as KeplerEphemeris;
    expect(e.system).toBe('E');
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 20, 23, 40, 0));
    relClose(e.af0, 0.559961190447e-4);
    relClose(e.af1, 0.274269496003e-11);
    expect(e.iode).toBe(32); // IODnav
    relClose(e.crs, 89.65625);
    relClose(e.deltaN, 0.315013121561e-8);
    relClose(e.m0, 0.187757372684e1);
    relClose(e.e, 0.26685546618e-3);
    relClose(e.sqrtA, 0.544062464142e4);
    expect(e.toe).toBe(171600);
    relClose(e.omega0, -0.132565759025e1);
    relClose(e.i0, 0.961001986893);
    relClose(e.omega, -0.813613066479e-1);
    relClose(e.omegaDot, -0.555308845128e-8);
    relClose(e.idot, -0.607168148133e-11);
    expect(e.week).toBe(2428);
    expect(e.svHealth).toBe(0);
    relClose(e.tgd, -0.209547579288e-8); // BGD E5a/E1
  });

  it('decodes GLONav — R03 vs convbin RINEX', () => {
    const e = res.ephemerides.find((x) => x.prn === 'R03') as GlonassEphemeris;
    expect(e.system).toBe('R');
    // toe 2026-07-20 23:45:00 UTC (GPS − 18 leap seconds)
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 20, 23, 45, 0));
    relClose(e.tauN, 0.180983915925e-4); // RINEX sign: −τn
    expect(e.gammaN).toBe(0);
    expect(e.messageFrameTime).toBe(171008); // UTC sow of the block stamp
    relClose(e.x, 0.180827539062e5); // km
    relClose(e.xDot, -0.592041015625e-2);
    relClose(e.xAcc, -0.931322574615e-9);
    relClose(e.y, -0.178952954102e5);
    relClose(e.yDot, -0.273421287537);
    relClose(e.z, 0.137844824219e4);
    relClose(e.zDot, -0.358948898315e1);
    expect(e.health).toBe(0);
    expect(e.freqNum).toBe(5);
  });

  it('decodes BDSNav — C08 vs convbin RINEX (BDT scale)', () => {
    const e = res.ephemerides.find((x) => x.prn === 'C08') as KeplerEphemeris;
    expect(e.system).toBe('C');
    // RINEX BDS epochs are BDT calendar dates (GPS − 14 s)
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 20, 23, 0, 0));
    relClose(e.af0, -0.25097921025e-3);
    relClose(e.af1, -0.328004290395e-11);
    expect(e.iode).toBe(1); // AODE
    relClose(e.crs, 201.671875);
    relClose(e.deltaN, 0.131826919692e-8);
    relClose(e.m0, -0.125338981896e1);
    relClose(e.e, 0.460314238444e-2);
    relClose(e.sqrtA, 0.64932466526e4);
    expect(e.toe).toBe(169200); // BDT seconds of week
    relClose(e.omega0, -0.283508628838);
    relClose(e.i0, 0.955825928181);
    relClose(e.omega, -0.288761061676e1);
    relClose(e.omegaDot, -0.238295640256e-8);
    expect(e.week).toBe(1072); // BDT week
    expect(e.svHealth).toBe(0);
    relClose(e.tgd, 0.900000018955e-9); // TGD1 B1/B3
  });
});

/**
 * The almanac slice holds the first 4 GALAlm + 3 GLOAlm + 3 BDSAlm
 * frames of TU Delft's DLF2 PolaRx5S log DLF2204g.26_.A (2026-07-23).
 * Values were validated by propagating the almanacs with a reduced
 * Kepler model and comparing against broadcast-ephemeris positions
 * from an independent receiver log: 16 BDS satellites agreed to
 * 0.5–2.3 km and 16 Galileo satellites to 14–21 km (typical almanac
 * accuracy); GLONASS channel numbers matched the GLONav blocks 9/9.
 */
describe.skipIf(!existsSync(ALM_FILE))('parseSbfAlmanac (DLF2 slice)', () => {
  const res = existsSync(ALM_FILE)
    ? parseSbfAlmanac(new Uint8Array(readFileSync(ALM_FILE)))
    : null!;

  it('decodes every almanac frame with clean CRCs', () => {
    expect(res.badCrc).toBe(0);
    expect(res.almanacs.length).toBe(13);
    const bySys: Record<string, number> = {};
    for (const a of res.almanacs) bySys[a.system] = (bySys[a.system] ?? 0) + 1;
    expect(bySys).toEqual({ E: 4, R: 3, C: 6 });
  });

  it('decodes GALAlm — E04, normalized to absolute elements', () => {
    const a = res.almanacs.find((x) => x.prn === 'E04') as SbfKeplerAlmanac;
    expect(a.system).toBe('E');
    expect(a.weekAlm).toBe(2428); // full GPS-aligned week from 2-bit SIS week
    expect(a.toaSec).toBe(363000);
    // ΔsqrtA (+0.0275 here) folded into the nominal √29600000
    expect(a.sqrtA).toBeCloseTo(5440.615547244177, 8);
    // δi folded into the 56° nominal
    expect(a.i0OrDeltaI).toBeCloseTo(0.969330981980425, 12);
    expect(a.e).toBeCloseTo(0.0002899169921875, 15);
    expect(a.omega0).toBeCloseTo(2.8514785370809212, 12);
    expect(a.omega).toBeCloseTo(-0.07746602978822488, 12);
    expect(a.m0).toBeCloseTo(-1.3495195981423929, 12);
    expect(a.omegaDot).toBeCloseTo(-5.485942797251848e-9, 20);
    expect(a.af0).toBeCloseTo(-0.0001163482666015625, 15);
    expect(a.af1).toBeCloseTo(3.2741809263825417e-11, 20);
    expect(a.health).toBe(64); // E5a HS valid (bit 6), E5a healthy
  });

  it('decodes GLOAlm — R01 ICD fields', () => {
    const a = res.almanacs.find((x) => x.prn === 'R01') as SbfGlonassAlmanac;
    expect(a.system).toBe('R');
    expect(a.freqNr).toBe(1);
    expect(a.weekAlm).toBe(2428);
    expect(a.toaSec).toBe(345600);
    expect(a.epsilon).toBeCloseTo(0.0003948211669921875, 15);
    expect(a.lambda).toBeCloseTo(2.3401206485380355, 12);
    expect(a.tLambda).toBeCloseTo(9588.53125, 8);
    expect(a.deltaI).toBeCloseTo(0.035554199237966606, 12);
    expect(a.omega).toBeCloseTo(0.4908738521234052, 12);
    expect(a.deltaT).toBeCloseTo(-2656.064453125, 8); // ≈ −2655.5 nominal
    expect(a.deltaTDot).toBeCloseTo(-0.001953125, 12);
    expect(a.tau).toBeCloseTo(-0.000179290771484375, 15);
    expect(a.health).toBe(1); // Cn: healthy
    expect(a.nDay).toBe(935);
    expect(a.n4).toBe(8); // 4-year interval: 2024–2028
  });

  it('decodes BDSAlm — C01 GEO with zero reference inclination', () => {
    const a = res.almanacs.find((x) => x.prn === 'C01') as SbfKeplerAlmanac;
    expect(a.system).toBe('C');
    expect(a.weekAlm).toBe(1072); // BDS week (GPS week − 1356)
    expect(a.toaSec).toBe(106496); // BDT seconds of week
    expect(a.sqrtA).toBeCloseTo(6493.4892578125, 8);
    // GEO: δi is relative to 0, not 0.3π — near-zero inclination
    expect(a.i0OrDeltaI).toBeCloseTo(0.008071375473757652, 12);
    expect(a.e).toBeCloseTo(0.0005211830139160156, 15);
    expect(a.omega0).toBeCloseTo(0.8167024568783529, 12);
    expect(a.m0).toBeCloseTo(-0.019901303483457755, 12);
    expect(a.af0).toBeCloseTo(-9.5367431640625e-7, 15);
    expect(a.health).toBe(88);
  });

  it('decodes BDSAlm — C06 IGSO with the 0.3π reference folded in', () => {
    const a = res.almanacs.find((x) => x.prn === 'C06') as SbfKeplerAlmanac;
    // 0.3π + δi·π ≈ 58.7° — a wrong reference would miss by ~54°
    expect(a.i0OrDeltaI).toBeCloseTo(1.0248154132891902, 12);
    expect(a.sqrtA).toBeCloseTo(6493.2412109375, 8);
    expect(a.omegaDot).toBeCloseTo(-1.8857928365553228e-9, 20);
    expect(a.af0).toBeCloseTo(0.0002994537353515625, 15);
  });
});
