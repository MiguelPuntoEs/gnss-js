/**
 * SINEX (Solution INdependent EXchange format, version 2.02): the format
 * IGS, EUREF and national agencies exchange station coordinates and
 * velocities in. `writeSinex` produces a station position + velocity
 * solution (SITE/ID, SOLUTION/EPOCHS, SOLUTION/ESTIMATE and a block-diagonal
 * SOLUTION/MATRIX_ESTIMATE); `parseSinexEstimates` reads the estimates back
 * (any SINEX file's STAX…VELZ).
 */

/** One station's solution. */
export interface SinexStation {
  /** 4-character site code, e.g. "WTZR". */
  code: string;
  /** DOMES number, e.g. "14201M010"; unknown → blank. */
  domes?: string;
  /** Free-text description (≤ 22 characters used). */
  description?: string;
  /** Reference epoch of the position (ms). */
  refEpochMs: number;
  /** Span of the data used (ms). */
  dataStartMs: number;
  dataEndMs: number;
  /** Position at the reference epoch, ECEF (m). */
  xyz: readonly [number, number, number];
  /** Velocity, ECEF (m/yr); omit for a position-only solution. */
  vel?: readonly [number, number, number];
  /** Covariance (m², m²/yr², m²/yr): 3×3 for position only, 6×6 with
   *  velocity (order X, Y, Z, VX, VY, VZ). */
  cov: readonly (readonly number[])[];
}

export interface SinexSolution {
  /** 3-character agency code of the creator. */
  agency: string;
  stations: SinexStation[];
  /** FILE/REFERENCE fields. */
  description?: string;
  software?: string;
  input?: string;
  /** Creation time (ms); default now. */
  createdMs?: number;
}

/** SINEX epoch "YY:DDD:SSSSS". */
function sinexEpoch(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const doy = Math.floor((ms - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
  const sod = Math.round((ms - Date.UTC(y, 0, doy)) / 1000);
  return `${String(y % 100).padStart(2, '0')}:${String(doy).padStart(3, '0')}:${String(Math.min(sod, 86399)).padStart(5, '0')}`;
}

/** Fortran-style E format with a 2-digit exponent, right-aligned. */
function eFmt(v: number, digits: number, width: number): string {
  const [m, e] = v.toExponential(digits).split('e') as [string, string];
  const exp = Number(e);
  const s = `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return s.padStart(width);
}

/** "DDD MM SS.S" (longitude 0…360 east) or "-DD MM SS.S" (latitude). */
function dms(deg: number, width: number): string {
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
function geodetic(x: number, y: number, z: number): [number, number, number] {
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

/** Write a SINEX 2.02 station position (+ velocity) solution. */
export function writeSinex(sol: SinexSolution): string {
  const created = sol.createdMs ?? Date.now();
  const st = sol.stations;
  const start = Math.min(...st.map((s) => s.dataStartMs));
  const end = Math.max(...st.map((s) => s.dataEndMs));
  const nPar = st.reduce((n, s) => n + (s.vel ? 6 : 3), 0);
  const ag = sol.agency.slice(0, 3).padEnd(3);
  const types = st.some((s) => s.vel) ? 'S V' : 'S';
  const L: string[] = [];
  L.push(
    `%=SNX 2.02 ${ag} ${sinexEpoch(created)} ${ag} ${sinexEpoch(start)} ${sinexEpoch(end)} P ${String(nPar).padStart(5, '0')} 2 ${types}`
  );
  L.push(
    '*-------------------------------------------------------------------------------'
  );
  L.push('+FILE/REFERENCE');
  const ref = (k: string, v?: string) => {
    if (v) L.push(` ${k.padEnd(18)} ${v.slice(0, 60)}`);
  };
  ref('DESCRIPTION', sol.description);
  ref('OUTPUT', 'Station positions and velocities');
  ref('SOFTWARE', sol.software);
  ref('INPUT', sol.input);
  L.push('-FILE/REFERENCE');
  L.push(
    '*-------------------------------------------------------------------------------'
  );
  L.push('+SITE/ID');
  L.push(
    '*CODE PT __DOMES__ T _STATION DESCRIPTION__ _LONGITUDE_ _LATITUDE__ HEIGHT_'
  );
  for (const s of st) {
    const [lat, lon, h] = geodetic(...s.xyz);
    L.push(
      ` ${s.code.padEnd(4)}  A ${(s.domes ?? '').padEnd(9)} P ${(s.description ?? s.code).slice(0, 22).padEnd(22)} ${dms((lon + 360) % 360, 11)} ${dms(lat, 11)} ${h.toFixed(1).padStart(7)}`
    );
  }
  L.push('-SITE/ID');
  L.push(
    '*-------------------------------------------------------------------------------'
  );
  L.push('+SOLUTION/EPOCHS');
  L.push('*CODE PT SOLN T _DATA_START_ __DATA_END__ _MEAN_EPOCH_');
  for (const s of st)
    L.push(
      ` ${s.code.padEnd(4)}  A    1 P ${sinexEpoch(s.dataStartMs)} ${sinexEpoch(s.dataEndMs)} ${sinexEpoch(s.refEpochMs)}`
    );
  L.push('-SOLUTION/EPOCHS');
  L.push(
    '*-------------------------------------------------------------------------------'
  );
  L.push('+SOLUTION/ESTIMATE');
  L.push(
    '*INDEX TYPE__ CODE PT SOLN _REF_EPOCH__ UNIT S __ESTIMATED VALUE____ _STD_DEV___'
  );
  let idx = 0;
  const first: number[] = [];
  for (const s of st) {
    first.push(idx + 1);
    const vals: [string, string, number][] = [
      ['STAX', 'm', s.xyz[0]],
      ['STAY', 'm', s.xyz[1]],
      ['STAZ', 'm', s.xyz[2]],
    ];
    if (s.vel)
      vals.push(
        ['VELX', 'm/y', s.vel[0]],
        ['VELY', 'm/y', s.vel[1]],
        ['VELZ', 'm/y', s.vel[2]]
      );
    vals.forEach(([type, unit, v], k) => {
      idx++;
      const sd = Math.sqrt(Math.max(s.cov[k]?.[k] ?? 0, 0));
      L.push(
        ` ${String(idx).padStart(5)} ${type.padEnd(6)} ${s.code.padEnd(4)}  A    1 ${sinexEpoch(s.refEpochMs)} ${unit.padEnd(4)} 2 ${eFmt(v, 14, 21)} ${eFmt(sd, 5, 11)}`
      );
    });
  }
  L.push('-SOLUTION/ESTIMATE');
  L.push(
    '*-------------------------------------------------------------------------------'
  );
  L.push('+SOLUTION/MATRIX_ESTIMATE L COVA');
  L.push(
    '*PARA1 PARA2 ____PARA2+0__________ ____PARA2+1__________ ____PARA2+2__________'
  );
  st.forEach((s, si) => {
    const n = s.vel ? 6 : 3;
    const base = first[si]!;
    for (let r = 0; r < n; r++)
      for (let c0 = 0; c0 <= r; c0 += 3) {
        const cols = [];
        for (let c = c0; c <= Math.min(r, c0 + 2); c++)
          cols.push(eFmt(s.cov[r]?.[c] ?? 0, 14, 21));
        L.push(
          ` ${String(base + r).padStart(5)} ${String(base + c0).padStart(5)} ${cols.join(' ')}`
        );
      }
  });
  L.push('-SOLUTION/MATRIX_ESTIMATE L COVA');
  L.push('%ENDSNX');
  return L.join('\n') + '\n';
}

export interface SinexEstimate {
  code: string;
  soln: string;
  /** Reference epoch (ms). */
  epochMs: number;
  xyz?: [number, number, number];
  vel?: [number, number, number];
  sigmaXyz?: [number, number, number];
  sigmaVel?: [number, number, number];
}

/** Read the station position/velocity estimates of a SINEX file, keyed by
 *  "CODE SOLN" (a station can carry several solutions). */
export function parseSinexEstimates(text: string): Map<string, SinexEstimate> {
  const out = new Map<string, SinexEstimate>();
  const a = text.indexOf('+SOLUTION/ESTIMATE');
  const b = text.indexOf('-SOLUTION/ESTIMATE');
  if (a < 0 || b < 0) return out;
  for (const line of text.slice(a, b).split(/\r?\n/).slice(1)) {
    if (!line.trim() || line.startsWith('*')) continue;
    const type = line.slice(7, 13).trim();
    const k = ['STAX', 'STAY', 'STAZ', 'VELX', 'VELY', 'VELZ'].indexOf(type);
    if (k < 0) continue;
    const code = line.slice(14, 18).trim();
    const soln = line.slice(22, 26).trim();
    const ep = line.slice(27, 39);
    const [yy, ddd, sss] = ep.split(':').map(Number) as [
      number,
      number,
      number,
    ];
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    const epochMs = Date.UTC(year, 0, ddd) + sss * 1000;
    const value = Number(line.slice(47, 68));
    const sd = Number(line.slice(69, 80));
    const key = `${code} ${soln}`;
    let e = out.get(key);
    if (!e) out.set(key, (e = { code, soln, epochMs }));
    if (k < 3) {
      (e.xyz ??= [0, 0, 0])[k] = value;
      (e.sigmaXyz ??= [0, 0, 0])[k] = sd;
    } else {
      (e.vel ??= [0, 0, 0])[k - 3] = value;
      (e.sigmaVel ??= [0, 0, 0])[k - 3] = sd;
    }
  }
  return out;
}
