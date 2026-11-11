/**
 * Elevation masking and above-mask tracking for observation QC.
 *
 * teqc and Anubis grade a file above an elevation cut-off (teqc: 10°) so
 * that noisy horizon arcs don't dominate multipath and slip statistics. They
 * also report how many of the observations the orbits say *should* exist
 * above the mask were actually tracked. Counting only the satellites the
 * receiver happened to record can't see a satellite it never tracked; this
 * can.
 */

import type { Ephemeris } from '../rinex/nav';
import { ecefToGeodetic } from '../coordinates/ecef';
import { computeSatPosition } from '../orbit';
import { nearestValidEphemeris } from '../orbit/validity';
import { SYSTEM_NAMES } from '../constants/gnss';

const RAD = 180 / Math.PI;
/**
 * Elevation is sampled every 5 min per satellite and linearly interpolated.
 * A MEO satellite moves ≤ ~0.5°/min in elevation and the curve is smooth,
 * so the interpolation error stays at the 0.01° level — far below what a
 * mask decision needs — while a daily 30 s file does ~25× fewer orbit
 * evaluations than one per observation.
 */
const SAMPLE_MS = 300_000;

/* ================================================================== */
/*  Elevation model                                                    */
/* ================================================================== */

/** Direction to a satellite, degrees. */
export interface AzEl {
  az: number;
  el: number;
}

/** Satellite elevations seen from one receiver, from broadcast orbits. */
export class ElevationModel {
  /** Every PRN with at least one ephemeris, sorted. */
  readonly prns: string[];
  private ephByPrn = new Map<string, Ephemeris[]>();
  private rx: [number, number, number];
  private sinLat: number;
  private cosLat: number;
  private sinLon: number;
  private cosLon: number;
  /** prn → sample index → az/el at that sample (null: no ephemeris). */
  private samples = new Map<string, Map<number, AzEl | null>>();
  /** prn → sample index → healthy flag at that sample. */
  private health = new Map<string, Map<number, boolean>>();

  private constructor(ephemerides: Ephemeris[], rx: [number, number, number]) {
    for (const eph of ephemerides) {
      let arr = this.ephByPrn.get(eph.prn);
      if (!arr) this.ephByPrn.set(eph.prn, (arr = []));
      arr.push(eph);
    }
    this.prns = [...this.ephByPrn.keys()].sort();
    this.rx = rx;
    const [lat, lon] = ecefToGeodetic(rx[0], rx[1], rx[2]);
    this.sinLat = Math.sin(lat);
    this.cosLat = Math.cos(lat);
    this.sinLon = Math.sin(lon);
    this.cosLon = Math.cos(lon);
  }

  /**
   * Null when there is nothing to work with: no ephemerides, or no usable
   * receiver position (missing or the all-zero APPROX POSITION XYZ).
   */
  static create(
    ephemerides: Ephemeris[],
    rxPos: [number, number, number] | null | undefined
  ): ElevationModel | null {
    if (ephemerides.length === 0 || !rxPos) return null;
    if (Math.hypot(rxPos[0], rxPos[1], rxPos[2]) < 6.0e6) return null;
    return new ElevationModel(ephemerides, rxPos);
  }

  /**
   * Elevation in degrees at a GPS-scale epoch, or null when no ephemeris is
   * valid then (unknown — callers keep such observations).
   */
  elevationDeg(prn: string, timeMs: number): number | null {
    return this.azElDeg(prn, timeMs)?.el ?? null;
  }

  /**
   * Azimuth (0–360°, clockwise from north) and elevation in degrees at a
   * GPS-scale epoch, or null without a valid ephemeris.
   */
  azElDeg(prn: string, timeMs: number): AzEl | null {
    const k = Math.floor(timeMs / SAMPLE_MS);
    const frac = timeMs / SAMPLE_MS - k;
    const a = this.sample(prn, k);
    if (frac === 0) return a;
    const b = this.sample(prn, k + 1);
    if (a !== null && b !== null) {
      // Azimuth wraps at north: interpolate along the short way round.
      let d = b.az - a.az;
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      return {
        az: (a.az + d * frac + 360) % 360,
        el: a.el + (b.el - a.el) * frac,
      };
    }
    // An ephemeris boundary inside the interval: evaluate exactly.
    return this.exact(prn, timeMs);
  }

  /**
   * True when the satellite's valid ephemeris (at the enclosing 5-min
   * sample) flags it healthy. Every system uses 0 = healthy (GPS/QZSS SV
   * health, Galileo SVhealth bits, BDS SatH1, GLONASS Bn).
   */
  isHealthy(prn: string, timeMs: number): boolean {
    const k = Math.round(timeMs / SAMPLE_MS);
    let m = this.health.get(prn);
    if (!m) this.health.set(prn, (m = new Map()));
    let h = m.get(k);
    if (h === undefined) {
      const ephs = this.ephByPrn.get(prn);
      const eph = ephs ? nearestValidEphemeris(ephs, k * SAMPLE_MS) : null;
      h = !!eph && ('svHealth' in eph ? eph.svHealth : eph.health) === 0;
      m.set(k, h);
    }
    return h;
  }

  private sample(prn: string, k: number): AzEl | null {
    let m = this.samples.get(prn);
    if (!m) this.samples.set(prn, (m = new Map()));
    let el = m.get(k);
    if (el === undefined) {
      el = this.exact(prn, k * SAMPLE_MS);
      m.set(k, el);
    }
    return el;
  }

  private exact(prn: string, timeMs: number): AzEl | null {
    const ephs = this.ephByPrn.get(prn);
    const eph = ephs ? nearestValidEphemeris(ephs, timeMs) : null;
    if (!eph) return null;
    const p = computeSatPosition(eph, timeMs);
    const dx = p.x - this.rx[0];
    const dy = p.y - this.rx[1];
    const dz = p.z - this.rx[2];
    const east = -this.sinLon * dx + this.cosLon * dy;
    const north =
      -this.sinLat * this.cosLon * dx -
      this.sinLat * this.sinLon * dy +
      this.cosLat * dz;
    const up =
      this.cosLat * this.cosLon * dx +
      this.cosLat * this.sinLon * dy +
      this.sinLat * dz;
    return {
      az: (Math.atan2(east, north) * RAD + 360) % 360,
      el: Math.atan2(up, Math.hypot(east, north)) * RAD,
    };
  }
}

/* ================================================================== */
/*  Above-mask tracking                                                */
/* ================================================================== */

export interface TrackingSystemStats {
  system: string;
  label: string;
  /** Satellite-epochs above the mask with a healthy, valid ephemeris. */
  expected: number;
  /** Of those, with carrier phase on at least one band. */
  tracked: number;
  /** Of those, with carrier phase on at least two bands. */
  dualFreq: number;
  /** tracked / expected × 100. */
  percent: number;
  /** dualFreq / expected × 100. */
  dualPercent: number;
}

/**
 * teqc-style tracking timeline: per satellite and time bin, how many grid
 * samples the orbits put above the mask, how many of those were tracked, and
 * how many were tracked below the mask. "Expected but not tracked" is the
 * teqc `-` symbol: it shows *when* tracking failed (obstruction,
 * interference, an outage), which a single percentage can't.
 */
export interface TrackingTimeline {
  /** First bin start (GPS-scale ms) and bin length (s). */
  start: number;
  binSec: number;
  bins: number;
  /**
   * Per bin: tracked share of the expected samples across all satellites
   * (%), null without expected samples. Satellites move, so a deep dip here
   * is lost *time* (an outage, interference) — unlike an obstruction, which
   * shows in the sky grid.
   */
  percent: (number | null)[];
  rows: {
    prn: string;
    /** Per bin: samples above the mask (healthy, valid ephemeris). */
    expected: number[];
    /** Per bin: of those, tracked on carrier phase. */
    tracked: number[];
    /** Per bin: tracked while below the mask (or with no ephemeris). */
    other: number[];
  }[];
}

/**
 * Where in the sky the receiver tracks: expected (healthy, above 0°) vs
 * tracked grid samples per 10° azimuth × 5° elevation cell, and the horizon
 * that follows from it — per azimuth, the elevation below which it mostly
 * doesn't track. A receiver's own cut-off is the same all round (`cutoffDeg`,
 * the median); sectors well above it are obstructions (trees, buildings,
 * the mast itself).
 */
export interface SkyGrid {
  azBinDeg: number;
  elBinDeg: number;
  /** [azBin][elBin] sample counts. */
  expected: number[][];
  tracked: number[][];
  /** Per azimuth bin: elevation (deg) tracking starts at. */
  horizon: number[];
  /** Median horizon: the receiver's own cut-off, as tracked. */
  cutoffDeg: number;
  /** Contiguous azimuth sectors whose horizon is ≥ 10° above the cut-off. */
  obstructions: { fromAz: number; toAz: number; maxEl: number }[];
}

export interface TrackingResult {
  maskDeg: number;
  /** Grid step the expected count was sampled on (s). */
  stepSec: number;
  expected: number;
  tracked: number;
  dualFreq: number;
  percent: number;
  dualPercent: number;
  perSystem: TrackingSystemStats[];
  timeline: TrackingTimeline;
  sky: SkyGrid;
  /** Satellites above the mask at some point that were never tracked. */
  neverTracked: string[];
  /** Satellites the receiver tracked without any valid ephemeris. */
  withoutNav: string[];
}

/** Systems whose satellites are only receivable in a region. */
const REGIONAL = new Set(['I', 'J', 'S']);

/** At most this many timeline bins, whatever the file length. */
const MAX_BINS = 96;
const AZ_BIN = 10;
const EL_BIN = 5;
/** A sky cell needs this many expected samples to say anything. */
const SKY_MIN_SAMPLES = 4;
/** Below this tracked share a cell counts as not tracked. */
const SKY_TRACKED_SHARE = 0.5;

/**
 * Compares the satellite-epochs the orbits put above the mask with the ones
 * the receiver recorded. Sampled on a grid of max(interval, 30 s) from the
 * first observed epoch, so a 1 Hz day costs no more than a 30 s one, and
 * the grid runs to the last epoch: an outage in the middle counts as missing.
 * Only systems the receiver recorded at least once are expected — a GPS-only
 * receiver isn't penalised for Galileo.
 */
export class TrackingAccumulator {
  private model: ElevationModel;
  private maskDeg: number;
  private stepMs: number;
  private systems = new Set<string>();
  private first: number | null = null;
  private last = -Infinity;
  /** grid index → prn → number of distinct phase bands. */
  private seen = new Map<number, Map<string, number>>();
  private observed = new Set<string>();

  constructor(
    model: ElevationModel,
    maskDeg: number,
    intervalSec: number | null | undefined
  ) {
    this.model = model;
    this.maskDeg = maskDeg;
    this.stepMs = Math.max(intervalSec ?? 30, 30) * 1000;
  }

  onObservation = (
    time: number,
    prn: string,
    codes: string[],
    values: (number | null)[]
  ) => {
    if (this.first === null) this.first = time;
    if (time > this.last) this.last = time;
    this.systems.add(prn[0]!);
    this.observed.add(prn);
    const off = time - this.first;
    const k = Math.round(off / this.stepMs);
    if (Math.abs(off - k * this.stepMs) > 1) return; // off-grid epoch
    const bands = new Set<string>();
    for (let i = 0; i < codes.length; i++) {
      const v = values[i];
      if (codes[i]![0] === 'L' && v != null && v !== 0)
        bands.add(codes[i]![1]!);
    }
    if (bands.size === 0) return;
    let row = this.seen.get(k);
    if (!row) this.seen.set(k, (row = new Map()));
    row.set(prn, Math.max(row.get(prn) ?? 0, bands.size));
  };

  finalize(): TrackingResult | null {
    if (this.first === null) return null;
    const agg = new Map<
      string,
      { expected: number; tracked: number; dual: number }
    >();
    // Tracking (and the sky grid) count only satellites the receiver
    // tracked at some point: a satellite it never locks all day is beyond
    // it — firmware without the newest BeiDou-3 PRNs (PULK, a Trimble BD990:
    // 53 % "tracking" and phantom obstructions), a regional system out of
    // range (NavIC from Europe). Those are listed in `neverTracked`, not
    // counted; obstructions, outages and interference still show, because
    // satellites move through them. Regional systems' untracked satellites
    // aren't even listed.
    const prns = this.model.prns.filter(
      (p) =>
        this.systems.has(p[0]!) &&
        (!REGIONAL.has(p[0]!) || this.observed.has(p))
    );
    const withoutNav = [...this.observed]
      .filter((p) => !this.model.prns.includes(p))
      .sort();
    const n = Math.round((this.last - this.first) / this.stepMs);
    const binSteps = Math.max(1, Math.ceil((n + 1) / MAX_BINS));
    const nBins = Math.ceil((n + 1) / binSteps);
    const nAz = 360 / AZ_BIN;
    const nEl = 90 / EL_BIN;
    const grid = () =>
      Array.from({ length: nAz }, () => new Array<number>(nEl).fill(0));
    const skyExp = grid();
    const skyTrk = grid();
    const rows = new Map<string, TrackingTimeline['rows'][number]>();
    const rowFor = (prn: string) => {
      let r = rows.get(prn);
      if (!r)
        rows.set(
          prn,
          (r = {
            prn,
            expected: new Array<number>(nBins).fill(0),
            tracked: new Array<number>(nBins).fill(0),
            other: new Array<number>(nBins).fill(0),
          })
        );
      return r;
    };
    for (let k = 0; k <= n; k++) {
      const t = this.first + k * this.stepMs;
      const row = this.seen.get(k);
      const b = Math.floor(k / binSteps);
      for (const prn of withoutNav) if (row?.has(prn)) rowFor(prn).other[b]!++;
      for (const prn of prns) {
        const ae = this.model.azElDeg(prn, t);
        const el = ae?.el ?? null;
        const nb = row?.get(prn) ?? 0;
        const counted = this.observed.has(prn);
        if (counted && ae && ae.el >= 0 && this.model.isHealthy(prn, t)) {
          const ia = Math.min(nAz - 1, Math.floor(ae.az / AZ_BIN));
          const ie = Math.min(nEl - 1, Math.floor(ae.el / EL_BIN));
          skyExp[ia]![ie]!++;
          if (nb >= 1) skyTrk[ia]![ie]!++;
        }
        if (el === null || el < this.maskDeg || !this.model.isHealthy(prn, t)) {
          if (nb >= 1) rowFor(prn).other[b]!++;
          continue;
        }
        const r = rowFor(prn);
        r.expected[b]!++;
        if (nb >= 1) r.tracked[b]!++;
        if (!counted) continue;
        const sys = prn[0]!;
        let a = agg.get(sys);
        if (!a) agg.set(sys, (a = { expected: 0, tracked: 0, dual: 0 }));
        a.expected++;
        if (nb >= 1) a.tracked++;
        if (nb >= 2) a.dual++;
      }
    }
    const order = 'GRECIJS';
    const rank = (s: string) =>
      order.includes(s) ? order.indexOf(s) : order.length;
    const pct = (x: number, of: number) => (of > 0 ? (x / of) * 100 : 0);
    const perSystem = [...agg]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([system, a]) => ({
        system,
        label: SYSTEM_NAMES[system] ?? system,
        expected: a.expected,
        tracked: a.tracked,
        dualFreq: a.dual,
        percent: pct(a.tracked, a.expected),
        dualPercent: pct(a.dual, a.expected),
      }));
    const expected = perSystem.reduce((s, x) => s + x.expected, 0);
    const tracked = perSystem.reduce((s, x) => s + x.tracked, 0);
    const dualFreq = perSystem.reduce((s, x) => s + x.dualFreq, 0);
    return {
      maskDeg: this.maskDeg,
      stepSec: this.stepMs / 1000,
      expected,
      tracked,
      dualFreq,
      percent: pct(tracked, expected),
      dualPercent: pct(dualFreq, expected),
      perSystem,
      timeline: {
        start: this.first,
        binSec: (binSteps * this.stepMs) / 1000,
        bins: nBins,
        percent: Array.from({ length: nBins }, (_, b) => {
          let e = 0;
          let t = 0;
          for (const r of rows.values()) {
            if (!this.observed.has(r.prn)) continue;
            e += r.expected[b]!;
            t += r.tracked[b]!;
          }
          return e > 0 ? (t / e) * 100 : null;
        }),
        rows: [...rows.values()].sort(
          (a, b) =>
            rank(a.prn[0]!) - rank(b.prn[0]!) || a.prn.localeCompare(b.prn)
        ),
      },
      sky: skyGrid(skyExp, skyTrk),
      neverTracked: [...rows.values()]
        .filter(
          (r) =>
            r.expected.some((x) => x > 0) &&
            r.tracked.every((x) => x === 0) &&
            r.other.every((x) => x === 0)
        )
        .map((r) => r.prn),
      withoutNav,
    };
  }
}

/** Horizon and obstructions from the expected/tracked sky grid. */
function skyGrid(expected: number[][], tracked: number[][]): SkyGrid {
  // Per azimuth: the horizon is the top of the highest cell below 60° that
  // was mostly not tracked (cells without enough samples don't count).
  const horizon = expected.map((col, ia) => {
    let h = 0;
    for (let ie = 0; ie < col.length && ie * EL_BIN < 60; ie++) {
      const e = col[ie]!;
      if (e < SKY_MIN_SAMPLES) continue;
      if (tracked[ia]![ie]! / e < SKY_TRACKED_SHARE) h = (ie + 1) * EL_BIN;
    }
    return h;
  });
  const sorted = [...horizon].sort((a, b) => a - b);
  const cutoffDeg = sorted[Math.floor(sorted.length / 2)]!;
  const obstructions: SkyGrid['obstructions'] = [];
  const n = horizon.length;
  // +10°: low-elevation tracking is ragged everywhere; one 5° bin isn't a wall.
  const high = horizon.map((h) => h >= cutoffDeg + 10);
  // Walk sectors, joining across north (bin n-1 → 0).
  const start = high.every(Boolean)
    ? 0
    : high.findIndex((x, i) => x && !high[(i - 1 + n) % n]);
  if (start >= 0)
    for (let k = 0, i = start; k < n;) {
      if (!high[i]) {
        i = (i + 1) % n;
        k++;
        continue;
      }
      const from = i;
      let maxEl = 0;
      let len = 0;
      while (high[i] && len < n) {
        maxEl = Math.max(maxEl, horizon[i]!);
        i = (i + 1) % n;
        len++;
      }
      k += len;
      obstructions.push({
        fromAz: from * AZ_BIN,
        toAz: ((from + len) * AZ_BIN) % 360 || 360,
        maxEl,
      });
    }
  return {
    azBinDeg: AZ_BIN,
    elBinDeg: EL_BIN,
    expected,
    tracked,
    horizon,
    cutoffDeg,
    obstructions,
  };
}
