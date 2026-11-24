import { describe, it, expect } from 'vitest';
import { RtkSlipDetector, type RawObservation } from '../src/positioning';

const L1 = 299_792_458 / 1575.42e6;
const L2 = 299_792_458 / 1227.6e6;

/** A GPS satellite at 30 s: range growing, ionosphere drifting slowly
 *  (so the geometry-free combination is not constant), optional slips. */
function epoch(
  i: number,
  opt: { n1?: number; n2?: number; lli?: number; noL2?: boolean } = {}
): RawObservation[] {
  const rho = 22e6 + 300 * i * 30;
  const iono = 3 + 0.002 * i + 0.00001 * i * i; // m on L1
  const iono2 = iono * (1575.42 / 1227.6) ** 2;
  const out: RawObservation[] = [
    {
      prn: 'G05',
      code: '1C',
      pr: rho + iono,
      cp: (rho - iono) / L1 + 1000 + (opt.n1 ?? 0),
      lli: opt.lli ?? null,
    },
  ];
  if (!opt.noL2)
    out.push({
      prn: 'G05',
      code: '2W',
      pr: rho + iono2,
      cp: (rho - iono2) / L2 + 2000 + (opt.n2 ?? 0),
    });
  return out;
}

const lockOf = (m: RawObservation[]) => m[0]!.lockTimeS!;

function run(
  n: number,
  at: (i: number) => Parameters<typeof epoch>[1]
): { locks: number[]; det: RtkSlipDetector } {
  const det = new RtkSlipDetector();
  const locks: number[] = [];
  for (let i = 0; i < n; i++)
    locks.push(lockOf(det.annotate(i * 30_000, epoch(i, at(i)))));
  return { locks, det };
}

/** Epochs whose lock time went backwards (what the engine resets on). */
const resets = (locks: number[]) =>
  locks.flatMap((l, i) => (i > 0 && l < locks[i - 1]! ? [i] : []));

describe('RtkSlipDetector', () => {
  it('lets a clean dual-frequency arc run, lock time growing', () => {
    const { locks, det } = run(120, () => ({}));
    expect(resets(locks)).toEqual([]);
    expect(locks[119]).toBe(119 * 30);
    expect(det.counts).toEqual({ receiver: 0, geometryFree: 0 });
  });

  it('finds an unflagged one-cycle slip on L1 or on L2', () => {
    expect(resets(run(60, (i) => ({ n1: i >= 20 ? 1 : 0 })).locks)).toEqual([
      20,
    ]);
    expect(resets(run(60, (i) => ({ n2: i >= 33 ? -1 : 0 })).locks)).toEqual([
      33,
    ]);
  });

  it('finds an equal slip on both carriers (5 cm in the combination)', () => {
    const { locks } = run(60, (i) => (i >= 40 ? { n1: 1, n2: 1 } : {}));
    expect(resets(locks)).toEqual([40]);
  });

  it('takes the loss-of-lock flag, also on a single frequency', () => {
    const { locks, det } = run(30, (i) => ({
      noL2: true,
      lli: i === 12 ? 1 : 0,
    }));
    expect(resets(locks)).toEqual([12]);
    expect(det.counts.receiver).toBe(1);
  });

  it('keeps the lock at zero while the flag stays set', () => {
    const { locks } = run(12, (i) => ({
      noL2: true,
      lli: i === 5 || i === 6 ? 1 : 0,
    }));
    expect(locks.slice(4, 9)).toEqual([120, 0, 0, 30, 60]);
  });

  it("follows the receiver's own lock time going backwards", () => {
    const det = new RtkSlipDetector();
    const locks: number[] = [];
    for (let i = 0; i < 20; i++) {
      const meas = epoch(i, { noL2: true }).map((m) => ({
        ...m,
        lockTimeS: i < 9 ? 100 + i : i - 9,
      }));
      locks.push(lockOf(det.annotate(i * 1000, meas)));
    }
    expect(resets(locks)).toEqual([9]);
  });

  it('restarts quietly after a gap: no flag, the engine resets on gaps', () => {
    const det = new RtkSlipDetector({ maxGapS: 120 });
    const locks: number[] = [];
    for (const i of [0, 1, 2, 3, 20, 21, 22])
      locks.push(
        lockOf(det.annotate(i * 30_000, epoch(i, { n1: i >= 20 ? 5 : 0 })))
      );
    expect(det.counts).toEqual({ receiver: 0, geometryFree: 0 });
    expect(locks.slice(4)).toEqual([0, 30, 60]);
  });

  it('gives every observation of a satellite the same lock time', () => {
    const det = new RtkSlipDetector();
    det.annotate(0, epoch(0));
    const out = det.annotate(30_000, epoch(1));
    expect(out.map((m) => m.lockTimeS)).toEqual([30, 30]);
  });
});
