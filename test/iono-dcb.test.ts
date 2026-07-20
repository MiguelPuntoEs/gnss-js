/**
 * Synthetic ground-truth test for the ionosphere DCB correction chain.
 *
 * Observations are fabricated from a known TEC(t), known satellite and
 * receiver code biases, and arbitrary ambiguities. This pins the sign
 * conventions end-to-end: the raw levelled series must be offset by
 * exactly −(B_i−B_j) worth of TECU, and applying a product DCB of
 * (Bs_i − Bs_j) ns must restore TEC(t) up to the receiver bias, which
 * the night-floor estimate then removes.
 */
import { describe, expect, it } from 'vitest';
import type { RinexHeader } from '../src/rinex/parser';
import { IonoAccumulator } from '../src/analysis/ionosphere';
import { parseSinexBiasDcb, applyIonoDcb } from '../src/analysis/dcb';
import { C_LIGHT } from '../src/constants/gnss';

const F1 = 1575.42e6;
const F2 = 1227.6e6;
const GAMMA = (F1 / F2) ** 2;
const K_TECU_PER_M = (F1 * F1) / 40.3e16; // TECU per metre of L1 iono delay
const M_PER_TECU = 1 / K_TECU_PER_M;

const HEADER = {
  obsTypes: { G: ['C1C', 'L1C', 'C2W', 'L2W'] },
  interval: 30,
  glonassSlots: {},
} as unknown as RinexHeader;

const N_EPOCHS = 200;
const T0 = Date.UTC(2026, 0, 1);
/** TEC profile: 0.3 TECU night floor to ~12 at "noon". */
const tec = (k: number) => 0.3 + 11.7 * Math.sin((Math.PI * k) / N_EPOCHS) ** 2;

function synthesize(biasC1: number, biasC2: number): IonoAccumulator {
  const acc = new IonoAccumulator(HEADER);
  const λ1 = C_LIGHT / F1;
  const λ2 = C_LIGHT / F2;
  const rho = 2.2e7;
  const n1 = 12345;
  const n2 = -6789;
  for (let k = 0; k < N_EPOCHS; k++) {
    const i1 = tec(k) * M_PER_TECU; // iono delay on L1, metres
    acc.onObservation(
      T0 + k * 30_000,
      'G07',
      ['C1C', 'L1C', 'C2W', 'L2W'],
      [
        rho + i1 + biasC1,
        (rho - i1) / λ1 + n1,
        rho + GAMMA * i1 + biasC2,
        (rho - GAMMA * i1) / λ2 + n2,
      ]
    );
  }
  return acc;
}

describe('parseSinexBiasDcb', () => {
  it('parses satellite DSB entries and skips station entries', () => {
    const text = [
      '%=BIA 1.00 CAS 2026:002:00000',
      '+BIAS/SOLUTION',
      ' DSB  G063 G01      C1C  C1W  2026:001:00000 2026:002:00000 ns   -1.2340  0.0120',
      ' DSB  G063 G01      C1C  C2W  2026:001:00000 2026:002:00000 ns    5.0035  0.0150',
      ' DSB       G01 ABMF C1C  C2W  2026:001:00000 2026:002:00000 ns    2.0000  0.1000',
      ' DSB  E210 E03      C1C  C5Q  2026:001:00000 2026:002:00000 ns   -0.8000  0.0200',
      '-BIAS/SOLUTION',
    ].join('\n');
    const dcb = parseSinexBiasDcb(text);
    expect(dcb.get('G01')?.get('C1C-C2W')).toBeCloseTo(5.0035, 6);
    expect(dcb.get('G01')?.get('C1C-C1W')).toBeCloseTo(-1.234, 6);
    expect(dcb.get('E03')?.get('C1C-C5Q')).toBeCloseTo(-0.8, 6);
    // The station line must not have polluted the satellite map
    expect(dcb.get('G01')?.size).toBe(2);
  });
});

describe('ionosphere DCB correction (synthetic ground truth)', () => {
  // Satellite biases (product-known) and receiver biases (unknown)
  const BS1 = 1.8; // m, satellite C1C bias
  const BS2 = 0.3; // m, satellite C2W bias
  const BR1 = 0.5; // m, receiver C1C bias
  const BR2 = 0.7; // m, receiver C2W bias

  const raw = synthesize(BS1 + BR1, BS2 + BR2).finalize();
  const g07 = raw.series.find((s) => s.prn === 'G07')!;

  it('raw series is offset by exactly −(B1−B2) worth of TECU', () => {
    const totalBias = BS1 + BR1 - (BS2 + BR2); // m
    const expectedOffset = (totalBias / (GAMMA - 1)) * K_TECU_PER_M;
    const mid = Math.floor(g07.points.length / 2);
    expect(g07.points[mid]!.stec).toBeCloseTo(tec(mid) - expectedOffset, 3);
    expect(g07.codes).toEqual(['C1C', 'C2W']);
  });

  it('product DCB restores TEC up to the receiver bias; floor removes it', () => {
    const dcbNs = ((BS1 - BS2) / C_LIGHT) * 1e9;
    const satDcb = new Map([['G07', new Map([['C1C-C2W', dcbNs]])]]);
    const { result, satellitesCorrected, satellitesMissing, receiverDcbTecu } =
      applyIonoDcb(raw, satDcb);

    expect(satellitesCorrected).toBe(1);
    expect(satellitesMissing).toEqual([]);

    // The series is offset by −(BR1−BR2) worth of TECU, so the floor
    // estimate equals that offset plus the 0.3 TECU true night floor
    // (the method's known bias).
    const rxOffsetTecu = (-(BR1 - BR2) / (GAMMA - 1)) * K_TECU_PER_M;
    const est = receiverDcbTecu['G L1-L2']!;
    expect(est).toBeDefined();
    expect(est).toBeCloseTo(rxOffsetTecu + 0.3, 0);

    const out = result.series[0]!;
    const mid = Math.floor(out.points.length / 2);
    // Corrected mid-arc TEC within the night-floor tolerance
    expect(Math.abs(out.points[mid]!.stec - tec(mid))).toBeLessThan(0.5);
    // No negative values beyond noise
    for (const p of out.points) expect(p.stec).toBeGreaterThan(-0.1);
  });

  it('reversed product key is negated', () => {
    const dcbNs = ((BS1 - BS2) / C_LIGHT) * 1e9;
    const fwd = applyIonoDcb(
      raw,
      new Map([['G07', new Map([['C1C-C2W', dcbNs]])]])
    );
    const rev = applyIonoDcb(
      raw,
      new Map([['G07', new Map([['C2W-C1C', -dcbNs]])]])
    );
    expect(fwd.result.series[0]!.points[50]!.stec).toBeCloseTo(
      rev.result.series[0]!.points[50]!.stec,
      6
    );
  });
});

/* Real-product validation (fixture fetched by scripts/fetch-test-data.sh) */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ESA_BIA = join(__dirname, '../test-fixtures/ESA0OPSFIN_DCB.BIA');

describe.skipIf(!existsSync(ESA_BIA))('parseSinexBiasDcb on ESA0OPSFIN', () => {
  const text = readFileSync(ESA_BIA, 'utf-8');

  it('selects the validity window covering the requested epoch', () => {
    const at2019 = parseSinexBiasDcb(text, Date.UTC(2019, 5, 1));
    const at2026 = parseSinexBiasDcb(text, Date.UTC(2026, 6, 1));
    const v2019 = at2019.get('G01')?.get('C1C-C2W');
    const v2026 = at2026.get('G01')?.get('C1C-C2W');
    expect(v2019).toBeDefined();
    expect(v2026).toBeDefined();
    // G01's SVN changed between these epochs; the DCB moved by ~11 ns.
    expect(Math.abs(v2026! - v2019!)).toBeGreaterThan(5);
  });

  it('covers the pairs the iono series actually use', () => {
    const dcb = parseSinexBiasDcb(text, Date.UTC(2026, 6, 1));
    const withPair = (sys: string, pair: string) =>
      [...dcb.keys()].filter((p) => p[0] === sys && dcb.get(p)!.has(pair))
        .length;
    expect(withPair('G', 'C1C-C2W')).toBeGreaterThan(25);
    expect(withPair('E', 'C1C-C5Q')).toBeGreaterThan(20);
    expect(withPair('C', 'C2I-C6I')).toBeGreaterThan(20);
    // Sanity: DCBs are ns-scale, never wildly large
    for (const sat of dcb.values())
      for (const v of sat.values()) expect(Math.abs(v)).toBeLessThan(150);
  });
});
