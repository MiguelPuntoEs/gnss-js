/**
 * Satellite attitude models against analysis-centre attitude (ORBEX).
 *
 * Fixtures: one eclipse/turn event per spacecraft family, sliced from
 * CODE's MGEX final attitude files COD0MGXFIN_2024{014,034,084,104}_..._ATT.OBX
 * and GFZ's GBM0MGXRAP_20240140000_..._ATT.OBX (from CNES's PPP-Wizard
 * bundle), 60 s steps; satellite position/velocity from the same centre's
 * SP3 (attitude_samples.json). IGS/MGEX products, freely distributed.
 * Built by an oracle script from the CODE/GFZ ORBEX and SP3 files.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseOrbex,
  orbexQuaternion,
  quaternionAxes,
  parseSp3,
  sp3Position,
} from '../src/rinex';
import {
  sunEcef,
  orbitGeometry,
  attitudeLaw,
  yawOfFrame,
  frameFromYaw,
  builtinBlockTable,
  blockFromTypeName,
  createSatAttitude,
  type SatBlock,
} from '../src/positioning';
import { satBodyFrame } from '../src/positioning/ppp-antenna';

const DIR = join(__dirname, '../test-fixtures');
const D = 180 / Math.PI;
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
type V3 = [number, number, number];

interface Sample {
  ac: string;
  prn: string;
  t: string;
  pos: V3;
  vel: V3;
}
const data = JSON.parse(
  readFileSync(join(DIR, 'attitude_samples.json'), 'utf8')
) as { samples: Sample[] };
const files: Record<string, string> = {
  COD_2024014: 'attitude_cod_2024014.obx',
  COD_2024034: 'attitude_cod_2024034.obx',
  COD_2024084: 'attitude_cod_2024084.obx',
  COD_2024104: 'attitude_cod_2024104.obx',
  GFZ_2024014: 'attitude_gfz_2024_014.obx',
};
const obx = Object.fromEntries(
  Object.entries(files).map(([k, f]) => [
    k,
    parseOrbex(readFileSync(join(DIR, f), 'utf8')),
  ])
);
const fileOf = (s: Sample) => {
  const d = new Date(s.t);
  const doy =
    Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  return obx[`${s.ac}_${d.getUTCFullYear()}${String(doy).padStart(3, '0')}`]!;
};
const blocks = builtinBlockTable();

/** RMS (deg) of model and nominal yaw against the ORBEX yaw for one PRN. */
function rmsFor(prn: string) {
  let n = 0;
  let sm = 0;
  let sn = 0;
  for (const s of data.samples) {
    if (s.prn !== prn) continue;
    const t = Date.parse(s.t);
    const q = orbexQuaternion(fileOf(s), prn, t);
    if (!q) continue;
    const g = orbitGeometry(s.pos, s.vel, sunEcef(t));
    const yObx = yawOfFrame(g, quaternionAxes(q));
    const st = attitudeLaw(blocks.block(prn, t), g);
    sm += (wrap(st.yawRad - yObx) * D) ** 2;
    sn += (wrap(g.nominalYawRad - yObx) * D) ** 2;
    n++;
  }
  return { n, model: Math.sqrt(sm / n), nominal: Math.sqrt(sn / n) };
}

describe('ORBEX reader', () => {
  it('reads header, types and quaternions; +Z points at the geocentre', () => {
    const f = obx.GFZ_2024014!;
    expect(f.frameType).toBe('ECEF');
    expect(f.timeSystem).toBe('GPS');
    expect(f.satTypes.get('C01')).toBe('BDS-2G');
    const s = data.samples.find((x) => x.prn === 'C01')!;
    const ax = quaternionAxes(orbexQuaternion(f, 'C01', Date.parse(s.t))!);
    const r = Math.hypot(...s.pos);
    const zDotDown = -(
      (ax.z[0] * s.pos[0] + ax.z[1] * s.pos[1] + ax.z[2] * s.pos[2]) /
      r
    );
    expect(zDotDown).toBeGreaterThan(0.9999);
  });

  it('interpolates between records and refuses gaps', () => {
    const f = obx.COD_2024084!;
    const a = f.att.get('E10')!;
    const t0 = a.t[0]!;
    const mid = orbexQuaternion(f, 'E10', t0 + 30_000)!;
    expect(Math.hypot(...mid)).toBeCloseTo(1, 12);
    expect(orbexQuaternion(f, 'E10', t0 - 1)).toBeNull();
    expect(orbexQuaternion(f, 'X99', t0)).toBeNull();
  });
});

describe('block types', () => {
  it('maps ANTEX and ORBEX type names', () => {
    const cases: [string, SatBlock][] = [
      ['BLOCK IIR-M', 'GPS-IIR-M'],
      ['BLOCK IIIA', 'GPS-III'],
      ['GPS-IIR-A', 'GPS-IIR'],
      ['GPS-IIF', 'GPS-IIF'],
      ['GALILEO-1', 'GAL-IOV'],
      ['GAL-2', 'GAL-FOC'],
      ['GLONASS-M', 'GLO-M'],
      ['GLO-K1B', 'GLO-K'],
      ['BEIDOU-3M-CAST', 'BDS-3-CAST'],
      ['BDS-3M-SE', 'BDS-3-SECM'],
      ['BEIDOU-3I', 'BDS-3-CAST'],
      ['BDS-2G', 'BDS-2G'],
      ['QZS-2I', 'QZS-2I'],
    ];
    for (const [name, b] of cases) expect(blockFromTypeName(name)).toBe(b);
  });
  it('built-in table follows PRN reassignments', () => {
    // G01: IIF (SVN63) until 2024-04, IIR-M (SVN49) mid-2024, IIIA (SVN80).
    expect(blocks.block('G01', Date.UTC(2024, 0, 14))).toBe('GPS-IIF');
    expect(blocks.block('G01', Date.UTC(2024, 5, 1))).toBe('GPS-IIR-M');
    expect(blocks.block('G01', Date.UTC(2025, 5, 1))).toBe('GPS-III');
    expect(blocks.block('E11', Date.UTC(2024, 0, 1))).toBe('GAL-IOV');
  });
});

describe('nominal yaw', () => {
  it('frameFromYaw(nominal) is the existing yaw-steering body frame', () => {
    for (const s of data.samples.filter((_, i) => i % 50 === 0)) {
      const t = Date.parse(s.t);
      const sun = sunEcef(t);
      const g = orbitGeometry(s.pos, s.vel, sun);
      const a = frameFromYaw(g, g.nominalYawRad);
      const b = satBodyFrame(s.pos, sun);
      for (const k of ['x', 'y', 'z'] as const)
        for (let i = 0; i < 3; i++) expect(a[k][i]).toBeCloseTo(b[k][i], 9);
    }
  });
});

// Model vs ORBEX over one event per family (deg RMS). Bounds ≈ 2× the
// values measured on these slices; the nominal bound shows each event is a
// real departure from yaw steering.
const EVENTS: [string, string, number, number][] = [
  // prn, what, max model RMS, min nominal RMS
  ['G19', 'GPS IIR midnight turn, β 0.3° (CODE)', 1, 15],
  ['G08', 'GPS IIF shadow crossing, β −6° (CODE)', 1, 5],
  ['G18', 'GPS III turn, β 0.7° (CODE)', 0.5, 10],
  ['R04', 'GLONASS-M shadow + noon turn, β 1.1° (CODE)', 3, 50],
  ['E10', 'Galileo FOC smoothed turn, β 0.9° (CODE)', 0.5, 10],
  ['E11', 'Galileo IOV smoothed turn, β 1.1° (CODE)', 0.5, 5],
  ['C23', 'BDS-3 CAST turn, β −0.6° (CODE; law fitted)', 2.5, 10],
  ['C29', 'BDS-3 SECM turn, β 1.2° (CODE; law fitted)', 1, 5],
  ['C01', 'BDS-2 GEO orbit-normal (GFZ)', 0.1, 30],
];

const measured: string[] = [];
describe('yaw laws vs analysis-centre attitude', () => {
  afterAll(() => {
    if (process.env.ATT_PRINT) console.log(measured.join('\n'));
  });
  for (const [prn, what, maxModel, minNominal] of EVENTS)
    it(`${prn}: ${what}`, () => {
      const r = rmsFor(prn);
      expect(r.n).toBeGreaterThan(20);
      expect(r.model).toBeLessThan(maxModel);
      expect(r.nominal).toBeGreaterThan(minNominal);
      measured.push(`${prn} ${r.model.toFixed(2)} ${r.nominal.toFixed(2)}`);
    });
});

describe('attitude provider', () => {
  it("'orbex' returns the file's frame, the model outside it", () => {
    const f = obx.COD_2024084!;
    const att = createSatAttitude({ mode: 'orbex', orbex: f });
    const s = data.samples.find((x) => x.prn === 'E10')!;
    const t = Date.parse(s.t);
    const sun = sunEcef(t);
    const fr = att.frame('E10', t, s.pos, s.vel, sun);
    const ax = quaternionAxes(orbexQuaternion(f, 'E10', t)!);
    expect(fr.x[0]).toBeCloseTo(ax.x[0], 12);
    // A PRN not in the file → model frame (unit, orthogonal).
    const m = att.frame('G05', t, s.pos, s.vel, sun);
    expect(Math.hypot(...m.y)).toBeCloseTo(1, 9);
    expect(att.exclude('E10', t, s.pos, s.vel, sun)).toBe(false);
  });
  it('excludes GPS IIA in shadow and for 30 min after', () => {
    const att = createSatAttitude({ mode: 'model' });
    // G08 (2024-01-14) placed in the IIA era: SVN38 flew as G08 until 2015.
    const ss = data.samples.filter((x) => x.prn === 'G08');
    const year = (iso: string) => Date.parse(iso.replace('2024', '2012'));
    const flags = ss.map((s) =>
      att.exclude('G08', year(s.t), s.pos, s.vel, sunEcef(Date.parse(s.t)))
    );
    expect(flags.some(Boolean)).toBe(true);
    expect(flags.every(Boolean)).toBe(false);
  });
});

describe('SP3 fixed columns', () => {
  it('reads z when a large negative clock touches it', () => {
    const sp3 = parseSp3(
      [
        '#dP2025  8 20  0  0  0.00000000       3 ORBIT IGS20 FIT  AIUB',
        '## 2378 259200.00000000   300.00000000 60907 0.0000000000000',
        '*  2025  8 20 14 50  0.00000000',
        'PG04  -1863.435611  26034.465427  -4400.999416 999999.999999',
        '*  2025  8 20 14 55  0.00000000',
        'PG04  -1953.001640  25852.119123  -5337.893301-431772.931600',
        'EOF',
      ].join('\n')
    );
    const s = sp3.satellites['G04']![1]!;
    expect(s.z).toBeCloseTo(-5337893.301, 3);
    expect(s.clk).toBeCloseTo(-0.4317729316, 9);
    expect(sp3Position(sp3, 'G04', sp3.epochs[1]!, 2)).not.toBeNull();
  });
});
