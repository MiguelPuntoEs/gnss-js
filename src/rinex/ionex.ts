/**
 * IONEX 1.0 parser — global ionosphere maps (GIMs) as published by
 * the IGS analysis centres (e.g. ESA0OPSRAP_*_GIM.INX).
 *
 * Returns the TEC maps in TECU on a regular lat/lon grid, one map per
 * epoch. RMS maps and the DCB auxiliary block are skipped.
 */

export interface IonexGrid {
  /** Map epochs (Unix ms, UTC). */
  epochs: number[];
  /** Grid latitudes (degrees), in file order (typically 87.5 → −87.5). */
  lats: number[];
  /** Grid longitudes (degrees), in file order (typically −180 → 180). */
  lons: number[];
  /**
   * TEC maps in TECU: maps[epochIdx][latIdx * lons.length + lonIdx].
   * NaN where the file marks no value (9999).
   */
  maps: Float32Array[];
}

function gridRange(l1: number, l2: number, dl: number): number[] {
  const out: number[] = [];
  const n = Math.round((l2 - l1) / dl) + 1;
  for (let i = 0; i < n; i++) out.push(l1 + i * dl);
  return out;
}

export function parseIonex(text: string): IonexGrid {
  const lines = text.split('\n');
  let exponent = -1;
  let lats: number[] = [];
  let lons: number[] = [];
  const epochs: number[] = [];
  const maps: Float32Array[] = [];

  let i = 0;
  // ── Header ──
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const label = line.slice(60).trim();
    if (label === 'EXPONENT') {
      exponent = parseInt(line.slice(0, 60).trim(), 10);
    } else if (label === 'LAT1 / LAT2 / DLAT') {
      const [a, b, d] = line.trim().split(/\s+/).map(Number);
      lats = gridRange(a!, b!, d!);
    } else if (label === 'LON1 / LON2 / DLON') {
      const [a, b, d] = line.trim().split(/\s+/).map(Number);
      lons = gridRange(a!, b!, d!);
    } else if (label === 'END OF HEADER') {
      i++;
      break;
    }
  }
  if (lats.length === 0 || lons.length === 0) {
    throw new Error('IONEX: missing grid definition');
  }
  const scale = Math.pow(10, exponent);

  // ── TEC maps ──
  while (i < lines.length) {
    const line = lines[i]!;
    const label = line.slice(60).trim();
    if (label === 'START OF TEC MAP') {
      const map = new Float32Array(lats.length * lons.length).fill(NaN);
      let epochMs = 0;
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const lab = l.slice(60).trim();
        if (lab === 'EPOCH OF CURRENT MAP') {
          const f = l.slice(0, 60).trim().split(/\s+/).map(Number);
          epochMs = Date.UTC(f[0]!, f[1]! - 1, f[2]!, f[3]!, f[4]!, f[5]!);
          i++;
        } else if (lab === 'LAT/LON1/LON2/DLON/H') {
          // fixed columns: lat in cols 2-8
          const lat = parseFloat(l.slice(2, 8));
          const latIdx = lats.findIndex((v) => Math.abs(v - lat) < 1e-6);
          i++;
          // data rows: 16 values of width 5 per line until all lons read
          let lonIdx = 0;
          while (lonIdx < lons.length && i < lines.length) {
            const row = lines[i]!;
            for (let c = 0; c + 5 <= 80 && lonIdx < lons.length; c += 5) {
              const vStr = row.slice(c, c + 5).trim();
              if (vStr === '') continue;
              const v = parseInt(vStr, 10);
              if (latIdx >= 0) {
                map[latIdx * lons.length + lonIdx] =
                  v === 9999 ? NaN : v * scale;
              }
              lonIdx++;
            }
            i++;
          }
        } else if (lab === 'END OF TEC MAP') {
          i++;
          break;
        } else {
          i++;
        }
      }
      epochs.push(epochMs);
      maps.push(map);
    } else if (label === 'START OF RMS MAP' || label === 'END OF FILE') {
      // RMS maps trail the TEC maps — nothing further to read.
      break;
    } else {
      i++;
    }
  }

  return { epochs, lats, lons, maps };
}
