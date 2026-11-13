/**
 * ORBEX (orbit exchange format, IGS/ACS draft 0.09) — the attitude records.
 *
 * Analysis centres publish the satellite attitude they used for their orbit
 * and clock solution as `..._ATT.OBX` files (CODE, GFZ, WHU, CNES bundles):
 * one unit quaternion per satellite and epoch. Using the same attitude as the
 * orbit/clock product is what a rigorous PPP does, since the antenna offsets
 * and phase wind-up the product was computed with depend on it.
 *
 * Only `ATT` records are read. The quaternion `q = (q0, q1, q2, q3)` (q0 the
 * scalar part) rotates a vector from the file's `FRAME_TYPE` frame (ECEF
 * for every product seen so far) into the satellite body frame (the IGS
 * body frame of the ANTEX satellite offsets):  r_body = q · r_ecef · q*.
 *
 * Epochs are read on the file's time scale (GPS) with Date.UTC, the
 * RINEX/SP3 parser convention of this library.
 */

export interface OrbexFile {
  /** `TIME_SYSTEM` (GPS for every product seen). */
  timeSystem: string;
  /** `FRAME_TYPE`: 'ECEF' or 'ECI'. */
  frameType: string;
  /** `COORD_SYSTEM`, e.g. IGS20. */
  coordSystem: string;
  /** Satellite descriptions from +SATELLITE/ID_AND_DESCRIPTION
   *  (e.g. G01 → 'GPS-IIF', E11 → 'GAL-1', C19 → 'BDS-3M-CA'). */
  satTypes: Map<string, string>;
  /** Attitude per satellite: epochs (ms, ascending) and quaternions packed
   *  [q0,q1,q2,q3] per epoch. */
  att: Map<string, { t: Float64Array; q: Float64Array }>;
}

/** Parse an ORBEX file's header and ATT records. */
export function parseOrbex(text: string): OrbexFile {
  const out: OrbexFile = {
    timeSystem: 'GPS',
    frameType: 'ECEF',
    coordSystem: '',
    satTypes: new Map(),
    att: new Map(),
  };
  const acc = new Map<string, { t: number[]; q: number[] }>();
  let block = '';
  let tMs = NaN;
  let i = 0;
  const n = text.length;
  while (i < n) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = n;
    const line =
      text.charCodeAt(j - 1) === 13 ? text.slice(i, j - 1) : text.slice(i, j);
    i = j + 1;
    const c0 = line.charCodeAt(0);
    if (c0 === 43 /* + */) {
      block = line.slice(1).trim();
      continue;
    }
    if (c0 === 45 /* - */) {
      block = '';
      continue;
    }
    if (block === 'EPHEMERIS/DATA') {
      if (line.startsWith('##')) {
        const p = line.slice(2).trim().split(/\s+/);
        const sec = Number(p[5]);
        tMs =
          Date.UTC(+p[0]!, +p[1]! - 1, +p[2]!, +p[3]!, +p[4]!) +
          Math.round(sec * 1000);
      } else if (line.startsWith(' ATT ')) {
        const p = line.trim().split(/\s+/);
        // ATT <id> [<sub-id>] <n> q0 q1 q2 q3 — the count is 4.
        const k = p.length - 5;
        if (k < 2 || Number(p[k]) !== 4) continue;
        const prn = p[1]!;
        const q0 = Number(p[k + 1]);
        const q1 = Number(p[k + 2]);
        const q2 = Number(p[k + 3]);
        const q3 = Number(p[k + 4]);
        if (![q0, q1, q2, q3].every(Number.isFinite) || !Number.isFinite(tMs))
          continue;
        let a = acc.get(prn);
        if (!a) acc.set(prn, (a = { t: [], q: [] }));
        a.t.push(tMs);
        a.q.push(q0, q1, q2, q3);
      }
      continue;
    }
    if (block === 'FILE/DESCRIPTION') {
      const key = line.slice(1, 21).trim();
      const val = line.slice(21).trim();
      if (key === 'TIME_SYSTEM') out.timeSystem = val;
      else if (key === 'FRAME_TYPE') out.frameType = val;
      else if (key === 'COORD_SYSTEM') out.coordSystem = val;
    } else if (block === 'SATELLITE/ID_AND_DESCRIPTION') {
      const p = line.trim().split(/\s+/);
      if (p[0] && p[1]) out.satTypes.set(p[0], p[1]);
    }
  }
  for (const [prn, a] of acc) {
    // Sort by time (files are, but be safe) and keep quaternion sign
    // continuity: q and −q are the same rotation, interpolation needs the
    // pair on the same hemisphere.
    const idx = a.t.map((_, k) => k).sort((x, y) => a.t[x]! - a.t[y]!);
    const t = new Float64Array(idx.length);
    const q = new Float64Array(idx.length * 4);
    idx.forEach((k, m) => {
      t[m] = a.t[k]!;
      let s = 1;
      if (m > 0) {
        const d =
          q[4 * m - 4]! * a.q[4 * k]! +
          q[4 * m - 3]! * a.q[4 * k + 1]! +
          q[4 * m - 2]! * a.q[4 * k + 2]! +
          q[4 * m - 1]! * a.q[4 * k + 3]!;
        if (d < 0) s = -1;
      }
      for (let c = 0; c < 4; c++) q[4 * m + c] = s * a.q[4 * k + c]!;
    });
    out.att.set(prn, { t, q });
  }
  return out;
}

/**
 * The attitude quaternion of a satellite at `tMs` — spherical linear
 * interpolation between the bracketing records, normalised. Null outside
 * the file, or across a gap longer than `maxGapMs` (default 2 × the local
 * record spacing, at least 60 s): an attitude event in a data gap can't be
 * interpolated.
 */
export function orbexQuaternion(
  obx: OrbexFile,
  prn: string,
  tMs: number,
  maxGapMs?: number
): [number, number, number, number] | null {
  const a = obx.att.get(prn);
  if (!a || !a.t.length) return null;
  const { t, q } = a;
  const nE = t.length;
  if (tMs < t[0]! || tMs > t[nE - 1]!) return null;
  // Binary search for the bracketing pair.
  let lo = 0;
  let hi = nE - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= tMs) lo = mid;
    else hi = mid;
  }
  const at = (k: number): [number, number, number, number] => [
    q[4 * k]!,
    q[4 * k + 1]!,
    q[4 * k + 2]!,
    q[4 * k + 3]!,
  ];
  if (tMs === t[lo]! || nE === 1) return at(lo);
  if (tMs === t[hi]!) return at(hi);
  const dt = t[hi]! - t[lo]!;
  const step = Math.min(
    dt,
    lo > 0 ? t[lo]! - t[lo - 1]! : dt,
    hi < nE - 1 ? t[hi + 1]! - t[hi]! : dt
  );
  if (dt > (maxGapMs ?? Math.max(60_000, 2 * step))) return null;
  return slerp(at(lo), at(hi), (tMs - t[lo]!) / dt);
}

/** Spherical linear interpolation between two unit quaternions. */
function slerp(
  a: [number, number, number, number],
  b: [number, number, number, number],
  u: number
): [number, number, number, number] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let s = 1;
  if (d < 0) {
    d = -d;
    s = -1;
  }
  let wa: number;
  let wb: number;
  if (d > 0.9995) {
    wa = 1 - u;
    wb = u;
  } else {
    const th = Math.acos(d);
    const st = Math.sin(th);
    wa = Math.sin((1 - u) * th) / st;
    wb = Math.sin(u * th) / st;
  }
  const r: [number, number, number, number] = [
    wa * a[0] + s * wb * b[0],
    wa * a[1] + s * wb * b[1],
    wa * a[2] + s * wb * b[2],
    wa * a[3] + s * wb * b[3],
  ];
  const nr = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
  return [r[0] / nr, r[1] / nr, r[2] / nr, r[3] / nr];
}

/**
 * The body-frame axes in the ORBEX frame for a quaternion. ORBEX
 * quaternions rotate the frame vector into the body frame,
 * r_body = q · r_frame · q*, so the body axes are the rows of the rotation
 * matrix (checked: the +Z row points at the Earth's centre to 1e-5 for every
 * satellite of a GFZ file).
 */
export function quaternionAxes(q: readonly [number, number, number, number]): {
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
} {
  const [w, x, y, z] = q;
  return {
    x: [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    y: [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    z: [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  };
}
