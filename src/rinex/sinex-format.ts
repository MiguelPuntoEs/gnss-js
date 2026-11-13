/** Fixed-format helpers shared by the SINEX writers (not public API). */

/** SINEX epoch "YY:DDD:SSSSS". */
export function sinexEpoch(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const doy = Math.floor((ms - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
  const sod = Math.round((ms - Date.UTC(y, 0, doy)) / 1000);
  return `${String(y % 100).padStart(2, '0')}:${String(doy).padStart(3, '0')}:${String(Math.min(sod, 86399)).padStart(5, '0')}`;
}

/** Fortran-style E format with a 2-digit exponent, right-aligned. */
export function eFmt(v: number, digits: number, width: number): string {
  const [m, e] = v.toExponential(digits).split('e') as [string, string];
  const exp = Number(e);
  const s = `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return s.padStart(width);
}

/** "DDD MM SS.S" (longitude 0…360 east) or "-DD MM SS.S" (latitude). */
export function dms(deg: number, width: number): string {
  const sign = deg < 0 ? '-' : '';
  let a = Math.abs(deg);
  let d = Math.floor(a);
  a = (a - d) * 60;
  let m = Math.floor(a);
  let s = Math.round((a - m) * 600) / 10;
  if (s >= 60) {
    s -= 60;
    m++;
  }
  if (m >= 60) {
    m -= 60;
    d++;
  }
  return `${sign}${d} ${String(m).padStart(2, '0')} ${s.toFixed(1).padStart(4, '0')}`.padStart(
    width
  );
}

/** Geodetic latitude/longitude (deg) and height (m) on GRS80/WGS84. */
export function geodetic(
  x: number,
  y: number,
  z: number
): [number, number, number] {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
  }
  return [(lat * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI, h];
}

/** Parse a SINEX epoch "YY:DDD:SSSSS" (or "YYYY:DDD:SSSSS") to ms;
 *  "00:000:00000" (undefined) → null. */
export function parseSinexEpoch(s: string): number | null {
  const m = /^\s*(\d{2,4}):(\d{3}):(\d{5})/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  const d = Number(m[2]);
  const sec = Number(m[3]);
  if (y === 0 && d === 0 && sec === 0) return null;
  if (m[1]!.length === 2) y = y < 50 ? 2000 + y : 1900 + y;
  return Date.UTC(y, 0, 1) + (d - 1) * 86_400_000 + sec * 1000;
}
