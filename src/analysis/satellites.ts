/**
 * Per-satellite QC table (Leica SpiderQC "by satellite", teqc's per-SV
 * lines): where each satellite was seen, how much of its time above the
 * mask was tracked, its slips and lost locks, and its code multipath and
 * C/N0 per band — the first place to look when one satellite or signal
 * misbehaves.
 */
export interface SatelliteRow {
  prn: string;
  /** Elevation range over its observations (deg); null without orbits. */
  minEl: number | null;
  maxEl: number | null;
  /** Grid samples above the mask (orbits) and of those tracked. */
  expected: number | null;
  tracked: number | null;
  /** Slipped epochs (each slip once) above the mask. */
  slips: number;
  /** Phase observations with LLI bit 0 (lock lost) above the mask. */
  lossOfLock: number;
  /** Code multipath RMS per band (m), from its MP series. */
  multipath: Record<string, number>;
  /** Mean C/N0 per band (dB-Hz) above the mask. */
  cn0: Record<string, number>;
}

/** Collects what only the observations know: elevation range, C/N0. */
export class SatelliteAccumulator {
  private el = new Map<string, [number, number]>();
  private cn0 = new Map<string, Map<string, [number, number]>>();

  onObservation(prn: string, elevationDeg: number | null) {
    if (elevationDeg === null) return;
    const r = this.el.get(prn);
    if (!r) this.el.set(prn, [elevationDeg, elevationDeg]);
    else {
      if (elevationDeg < r[0]) r[0] = elevationDeg;
      if (elevationDeg > r[1]) r[1] = elevationDeg;
    }
  }

  onGradedObservation(prn: string, codes: string[], values: (number | null)[]) {
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code[0] !== 'S') continue;
      const v = values[i];
      if (v == null || v <= 0) continue;
      let m = this.cn0.get(prn);
      if (!m) this.cn0.set(prn, (m = new Map()));
      const band = code[1]!;
      const a = m.get(band) ?? [0, 0];
      a[0] += v;
      a[1]++;
      m.set(band, a);
    }
  }

  /** Rows for every satellite seen, merged with the other accumulators. */
  finalize(merge: {
    prns: Iterable<string>;
    timeline?: { prn: string; expected: number[]; tracked: number[] }[];
    slips: Record<string, number>;
    lossOfLock: Record<string, number>;
    /** MP arcs (one series per arc): pooled per satellite and band. */
    multipath: { prn: string; band: string; points: { mp: number }[] }[];
  }): SatelliteRow[] {
    const tl = new Map((merge.timeline ?? []).map((r) => [r.prn, r]));
    const acc = new Map<string, Map<string, [number, number]>>();
    for (const s of merge.multipath) {
      let m = acc.get(s.prn);
      if (!m) acc.set(s.prn, (m = new Map()));
      const a = m.get(s.band) ?? [0, 0];
      for (const p of s.points) {
        a[0] += p.mp * p.mp;
        a[1]++;
      }
      m.set(s.band, a);
    }
    const mp = new Map<string, Record<string, number>>();
    for (const [prn, m] of acc) {
      const r: Record<string, number> = {};
      for (const [band, [ss, n]] of m) if (n > 0) r[band] = Math.sqrt(ss / n);
      mp.set(prn, r);
    }
    const order = 'GRECJIS';
    const rank = (p: string) =>
      (order.includes(p[0]!) ? order.indexOf(p[0]!) : order.length) * 1000 +
      parseInt(p.slice(1), 10);
    return [...new Set(merge.prns)]
      .sort((a, b) => rank(a) - rank(b))
      .map((prn) => {
        const r = tl.get(prn);
        const el = this.el.get(prn);
        const cn0: Record<string, number> = {};
        for (const [band, [sum, n]] of this.cn0.get(prn) ?? [])
          cn0[band] = sum / n;
        return {
          prn,
          minEl: el ? el[0] : null,
          maxEl: el ? el[1] : null,
          expected: r ? r.expected.reduce((s, x) => s + x, 0) : null,
          tracked: r ? r.tracked.reduce((s, x) => s + x, 0) : null,
          slips: merge.slips[prn] ?? 0,
          lossOfLock: merge.lossOfLock[prn] ?? 0,
          multipath: mp.get(prn) ?? {},
          cn0,
        };
      });
  }
}
