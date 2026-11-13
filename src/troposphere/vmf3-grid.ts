/**
 * Operational VMF3 from numerical weather models: TU Wien's gridded and
 * site-wise products (Landskron & Böhm 2018, J Geod 92:349–360), the
 * troposphere a-priori geodetic software (the EPN analysis) uses.
 *
 * Gridded files (`trop_products/GRID/1x1|5x5/VMF3/VMF3_OP/<yyyy>/VMF3_<yyyymmdd>.H<hh>`,
 * 6-hourly) give per grid point the hydrostatic and wet `a` coefficients of
 * the mapping functions and the zenith hydrostatic (ZHD) and wet (ZWD)
 * delays, at the grid point's ellipsoidal height (`orography_ell_1x1`,
 * `orography_ell_5x5`). At a station the delays are reduced from each of
 * the four surrounding points' heights to the station's (Kouba 2008,
 * "Implementation and testing of the gridded Vienna Mapping Function 1",
 * J Geod 82:193–205: the ZHD through the pressure, the ZWD with a 2000 m
 * scale height), then interpolated bilinearly in space and linearly in
 * time. The b and c coefficients are VMF3's empirical ones.
 *
 * Site-wise files (`trop_products/GNSS/VMF3/VMF3_OP/daily/<yyyy>/<yyyyddd>.vmf3_g`)
 * give the same quantities ray-traced at IGS/EPN stations directly.
 *
 * Data: VMF Data Server, TU Wien (doi:10.17616/R3RD2H), based on ECMWF
 * operational analyses; products older than 24 h are CC BY 4.0 — acknowledge
 * TU Wien and the ECMWF. Forecast products (VMF3_FC) have a non-commercial
 * licence and are not supported here.
 */
import {
  gpt3,
  saastamoinenZhd,
  vmf3,
  type Gpt3Grid,
  type TroposphereModel,
} from './index';

/** One 6-hourly VMF3 grid file. Points are row-major: latitude from north
 *  to south, longitude eastwards from `lon0`. */
export interface Vmf3GridEpoch {
  /** Epoch (ms, UTC). */
  timeMs: number;
  /** Latitude of the first (northernmost) row and longitude of the first
   *  column (deg), spacing (deg), and dimensions. */
  lat0: number;
  lon0: number;
  dLat: number;
  dLon: number;
  nLat: number;
  nLon: number;
  ah: Float64Array;
  aw: Float64Array;
  /** Zenith hydrostatic / wet delay at the grid point's height (m). */
  zhd: Float64Array;
  zwd: Float64Array;
}

/** Parse a VMF3 grid file (`! Epoch:` header, then `lat lon ah aw zhd zwd`). */
export function parseVmf3Grid(text: string): Vmf3GridEpoch {
  let timeMs = NaN;
  let range: number[] | null = null;
  const rows: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('!')) {
      const ep = /^!\s*Epoch:\s*(.+)$/.exec(line);
      if (ep) {
        const [y, mo, d, h, mi, s] = ep[1]!.trim().split(/\s+/).map(Number);
        timeMs = Date.UTC(y!, mo! - 1, d!, h!, mi!, s ?? 0);
      }
      const rg = /^!\s*Range\/resolution:\s*(.+)$/.exec(line);
      if (rg) range = rg[1]!.trim().split(/\s+/).map(Number);
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    const v = t.split(/\s+/).map(Number);
    if (v.length >= 6 && v.every(Number.isFinite)) rows.push(v);
  }
  if (!Number.isFinite(timeMs)) throw new Error('VMF3 grid: no epoch.');
  if (!range || range.length < 6)
    throw new Error('VMF3 grid: no Range/resolution header.');
  const [latMin, latMax, lonMin, lonMax, dLat, dLon] = range as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const nLat = Math.round((latMax - latMin) / dLat) + 1;
  const nLon = Math.round((lonMax - lonMin) / dLon) + 1;
  const n = nLat * nLon;
  const g: Vmf3GridEpoch = {
    timeMs,
    lat0: latMax,
    lon0: lonMin,
    dLat,
    dLon,
    nLat,
    nLon,
    ah: new Float64Array(n).fill(NaN),
    aw: new Float64Array(n).fill(NaN),
    zhd: new Float64Array(n).fill(NaN),
    zwd: new Float64Array(n).fill(NaN),
  };
  for (const [lat, lon, ah, aw, zhd, zwd] of rows) {
    const i = Math.round((latMax - lat!) / dLat);
    const j = Math.round((lon! - lonMin) / dLon);
    if (i < 0 || i >= nLat || j < 0 || j >= nLon) continue;
    const k = i * nLon + j;
    g.ah[k] = ah!;
    g.aw[k] = aw!;
    g.zhd[k] = zhd!;
    g.zwd[k] = zwd!;
  }
  if (g.zhd.some((x) => Number.isNaN(x)))
    throw new Error(`VMF3 grid: expected ${n} points, the file is incomplete.`);
  return g;
}

/** Parse an orography file (`orography_ell_1x1` / `_5x5`: one ellipsoidal
 *  height per line, in the grid's point order). */
export function parseVmf3Orography(text: string): Float64Array {
  const v = text
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  return Float64Array.from(v);
}

/** Pressure (hPa) whose Saastamoinen ZHD is `zhd` (m) — the inverse. */
const zhdToPressure = (zhd: number, latRad: number, h: number) =>
  (zhd / 0.0022768) * (1 - 0.00266 * Math.cos(2 * latRad) - 0.28e-6 * h);

/** Reduce a grid point's ZHD/ZWD from its height `h0` to `h` (m): the
 *  pressure with the standard-atmosphere lapse (Kouba 2008, eq. 3–5), the
 *  wet delay with a 2000 m scale height. */
export function reduceVmf3Delays(
  zhd: number,
  zwd: number,
  latRad: number,
  h0: number,
  h: number
): { zhd: number; zwd: number } {
  const p0 = zhdToPressure(zhd, latRad, h0);
  const p = p0 * (1 - 0.0000226 * (h - h0)) ** 5.225;
  return {
    zhd: saastamoinenZhd(p, latRad, h),
    zwd: zwd * Math.exp(-(h - h0) / 2000),
  };
}

export interface Vmf3Values {
  ah: number;
  aw: number;
  /** Zenith hydrostatic / wet delay at the station height (m). */
  zhd: number;
  zwd: number;
}

/** One epoch's values at a station: the four surrounding points reduced to
 *  the station height, then bilinear. */
function atEpoch(
  g: Vmf3GridEpoch,
  oro: Float64Array,
  latRad: number,
  lonRad: number,
  hEll: number
): Vmf3Values {
  const latDeg = (latRad * 180) / Math.PI;
  const lonDeg = ((((lonRad * 180) / Math.PI) % 360) + 360) % 360;
  // Fractional row/column; rows clamp at the poles, columns wrap.
  let fi = (g.lat0 - latDeg) / g.dLat;
  fi = Math.min(Math.max(fi, 0), g.nLat - 1);
  // A global grid wraps in longitude; a regional crop clamps.
  const global = g.nLon * g.dLon > 359.9;
  let fj = (lonDeg - g.lon0) / g.dLon;
  if (global) fj = ((fj % g.nLon) + g.nLon) % g.nLon;
  else {
    if (fj < 0) fj += 360 / g.dLon;
    fj = Math.min(Math.max(fj, 0), g.nLon - 1);
  }
  const i0 = Math.min(Math.floor(fi), g.nLat - 2);
  const j0 = global ? Math.floor(fj) : Math.min(Math.floor(fj), g.nLon - 2);
  const j1 = global ? (j0 + 1) % g.nLon : j0 + 1;
  const ti = fi - i0;
  const tj = fj - j0;
  const pts = [
    [i0, j0, (1 - ti) * (1 - tj)],
    [i0, j1, (1 - ti) * tj],
    [i0 + 1, j0, ti * (1 - tj)],
    [i0 + 1, j1, ti * tj],
  ] as const;
  const out: Vmf3Values = { ah: 0, aw: 0, zhd: 0, zwd: 0 };
  for (const [i, j, w] of pts) {
    if (w === 0) continue;
    const k = i * g.nLon + j;
    const r = reduceVmf3Delays(g.zhd[k]!, g.zwd[k]!, latRad, oro[k]!, hEll);
    out.ah += w * g.ah[k]!;
    out.aw += w * g.aw[k]!;
    out.zhd += w * r.zhd;
    out.zwd += w * r.zwd;
  }
  return out;
}

/**
 * VMF3 at a station and instant from 6-hourly grid epochs (any order; the
 * two bracketing `utcMs` are interpolated linearly, outside the span the
 * nearest is used). `orography` must match the grids' resolution.
 */
export function vmf3GridAt(
  epochs: readonly Vmf3GridEpoch[],
  orography: Float64Array,
  utcMs: number,
  latRad: number,
  lonRad: number,
  hEll: number
): Vmf3Values {
  if (!epochs.length) throw new Error('VMF3 grid: no epochs.');
  const n = epochs[0]!.nLat * epochs[0]!.nLon;
  if (orography.length !== n)
    throw new Error(
      `VMF3 grid: orography has ${orography.length} points, the grid ${n}.`
    );
  const s = [...epochs].sort((a, b) => a.timeMs - b.timeMs);
  if (utcMs <= s[0]!.timeMs)
    return atEpoch(s[0]!, orography, latRad, lonRad, hEll);
  const last = s[s.length - 1]!;
  if (utcMs >= last.timeMs)
    return atEpoch(last, orography, latRad, lonRad, hEll);
  let k = 0;
  while (s[k + 1]!.timeMs < utcMs) k++;
  const a = s[k]!;
  const b = s[k + 1]!;
  const w = (utcMs - a.timeMs) / (b.timeMs - a.timeMs);
  const va = atEpoch(a, orography, latRad, lonRad, hEll);
  const vb = atEpoch(b, orography, latRad, lonRad, hEll);
  return {
    ah: va.ah + w * (vb.ah - va.ah),
    aw: va.aw + w * (vb.aw - va.aw),
    zhd: va.zhd + w * (vb.zhd - va.zhd),
    zwd: va.zwd + w * (vb.zwd - va.zwd),
  };
}

/** True when the epochs cover [t0, t1] (UTC ms) with no gap over 6 h. */
export function vmf3GridCovers(
  epochs: readonly Vmf3GridEpoch[],
  t0: number,
  t1: number
): boolean {
  const ts = epochs.map((e) => e.timeMs).sort((a, b) => a - b);
  if (!ts.length || ts[0]! > t0 || ts[ts.length - 1]! < t1) return false;
  for (let i = 1; i < ts.length; i++)
    if (ts[i]! - ts[i - 1]! > 6 * 3_600_000) return false;
  return true;
}

/** The 6-hourly grid epochs (UTC ms) a session [t0, t1] needs. */
export function vmf3GridEpochsFor(t0: number, t1: number): number[] {
  const step = 6 * 3_600_000;
  const out: number[] = [];
  for (let t = Math.floor(t0 / step) * step; t < t1 + step; t += step)
    out.push(t);
  return out;
}

/** File name of the grid epoch at `utcMs` (on a 6-hour boundary). */
export function vmf3GridFileName(utcMs: number): string {
  const d = new Date(utcMs);
  const p = (x: number) => String(x).padStart(2, '0');
  return `VMF3_${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.H${p(d.getUTCHours())}`;
}

/** URL of a VMF3_OP grid file on the VMF Data Server. */
export function vmf3GridUrl(
  utcMs: number,
  resolution: '1x1' | '5x5' = '1x1'
): string {
  return `https://vmf.geo.tuwien.ac.at/trop_products/GRID/${resolution}/VMF3/VMF3_OP/${new Date(utcMs).getUTCFullYear()}/${vmf3GridFileName(utcMs)}`;
}

/** URL of the orography (grid-point ellipsoidal heights) for a resolution. */
export function vmf3OrographyUrl(resolution: '1x1' | '5x5' = '1x1'): string {
  return `https://vmf.geo.tuwien.ac.at/station_coord_files/orography_ell_${resolution}`;
}

/** Chen & Herring (1997) gradient mapping. */
const gradientMapping = (sinEl: number, el: number) =>
  1 / (sinEl * Math.tan(el) + 0.0032);

export interface Vmf3GridTroposphereOptions {
  epochs: readonly Vmf3GridEpoch[];
  orography: Float64Array;
  /** GPT3 grid: its a-priori horizontal gradients (with `gradients`). */
  gpt3?: Gpt3Grid;
  /** Add GPT3's a-priori gradients to the slant delay. Default false. */
  gradients?: boolean;
}

/**
 * Gridded VMF3 as the PPP troposphere: the a-priori ZHD from the weather
 * model (instead of a standard or climatological atmosphere), VMF3
 * hydrostatic and wet mapping from the grid's a coefficients, and
 * optionally GPT3's a-priori gradients. Values are recomputed every 5
 * minutes or when the station moves more than ~10 m vertically.
 */
export function createVmf3GridTroposphere(
  o: Vmf3GridTroposphereOptions
): TroposphereModel & {
  /** The model's zenith values at a station and instant. */
  zenith(
    utcMs: number,
    latRad: number,
    lonRad: number,
    hEll: number
  ): Vmf3Values;
} {
  let key = '';
  let v: Vmf3Values | null = null;
  let grad = { n: 0, e: 0 };
  const zenith = (
    utcMs: number,
    latRad: number,
    lonRad: number,
    hEll: number
  ) => vmf3GridAt(o.epochs, o.orography, utcMs, latRad, lonRad, hEll);
  return {
    zenith,
    delays(utcMs, latRad, lonRad, hEll, elRad, azRad) {
      const k = `${Math.floor(utcMs / 300_000)}|${latRad.toFixed(5)}|${lonRad.toFixed(5)}|${Math.round(hEll / 10)}`;
      if (k !== key || !v) {
        v = zenith(utcMs, latRad, lonRad, hEll);
        if (o.gradients && o.gpt3) {
          const g = gpt3(o.gpt3, utcMs, latRad, lonRad, hEll);
          grad = { n: g.Gn_h + g.Gn_w, e: g.Ge_h + g.Ge_w };
        }
        key = k;
      }
      const el = Math.max(elRad, 1e-3);
      const { mfh, mfw } = vmf3(v.ah, v.aw, utcMs, latRad, lonRad, hEll, el);
      const sinEl = Math.sin(el);
      const gradient =
        o.gradients && o.gpt3
          ? gradientMapping(sinEl, el) *
            (grad.n * Math.cos(azRad) + grad.e * Math.sin(azRad))
          : 0;
      return { zhd: v.zhd, mh: mfh, mw: mfw, gradient };
    },
  };
}

/** One record of a site-wise VMF3 file. */
export interface Vmf3SiteRecord {
  /** Epoch (ms, UTC). */
  timeMs: number;
  ah: number;
  aw: number;
  zhd: number;
  zwd: number;
  /** Pressure (hPa), temperature (°C), water vapour pressure (hPa). */
  p: number;
  T: number;
  e: number;
}

const MJD_UNIX_MS = (mjd: number) => (mjd - 40587) * 86_400_000;

/** Parse a site-wise VMF3 file (`STAT  mjd ah aw zhd zwd p T e` per line)
 *  into records per station (upper-case 4-character id). */
export function parseVmf3Sitewise(text: string): Map<string, Vmf3SiteRecord[]> {
  const out = new Map<string, Vmf3SiteRecord[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('!') || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const v = f.slice(1).map(Number);
    if (!v.slice(0, 5).every(Number.isFinite)) continue;
    const id = f[0]!.toUpperCase();
    const list = out.get(id) ?? [];
    list.push({
      timeMs: Math.round(MJD_UNIX_MS(v[0]!)),
      ah: v[1]!,
      aw: v[2]!,
      zhd: v[3]!,
      zwd: v[4]!,
      p: v[5] ?? NaN,
      T: v[6] ?? NaN,
      e: v[7] ?? NaN,
    });
    out.set(id, list);
  }
  for (const l of out.values()) l.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/** URL of a day's site-wise VMF3_OP file. */
export function vmf3SitewiseUrl(utcMs: number): string {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const doy = Math.floor((utcMs - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
  return `https://vmf.geo.tuwien.ac.at/trop_products/GNSS/VMF3/VMF3_OP/daily/${y}/${y}${String(doy).padStart(3, '0')}.vmf3_g`;
}

/**
 * Site-wise VMF3 as the PPP troposphere for one station: the records are
 * ray-traced at the station's catalogued position, so the delays apply as
 * they are (no height reduction); linear in time between records.
 */
export function createVmf3SiteTroposphere(
  records: readonly Vmf3SiteRecord[]
): TroposphereModel {
  if (!records.length) throw new Error('VMF3 site-wise: no records.');
  const s = [...records].sort((a, b) => a.timeMs - b.timeMs);
  const at = (t: number) => {
    if (t <= s[0]!.timeMs) return s[0]!;
    const last = s[s.length - 1]!;
    if (t >= last.timeMs) return last;
    let k = 0;
    while (s[k + 1]!.timeMs < t) k++;
    const a = s[k]!;
    const b = s[k + 1]!;
    const w = (t - a.timeMs) / (b.timeMs - a.timeMs);
    const mix = (x: number, y: number) => x + w * (y - x);
    return {
      ...a,
      ah: mix(a.ah, b.ah),
      aw: mix(a.aw, b.aw),
      zhd: mix(a.zhd, b.zhd),
      zwd: mix(a.zwd, b.zwd),
    };
  };
  return {
    delays(utcMs, latRad, lonRad, hEll, elRad) {
      const r = at(utcMs);
      const { mfh, mfw } = vmf3(
        r.ah,
        r.aw,
        utcMs,
        latRad,
        lonRad,
        hEll,
        Math.max(elRad, 1e-3)
      );
      return { zhd: r.zhd, mh: mfh, mw: mfw, gradient: 0 };
    },
  };
}
