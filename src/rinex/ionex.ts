/**
 * IONEX 1.0/1.1 parser — global ionosphere maps (GIMs) as published by
 * the IGS analysis centres (e.g. ESA0OPSRAP_*_GIM.INX).
 *
 * Returns the TEC maps in TECU on a regular lat/lon grid, one map per
 * epoch. Values are the file's integers × 10^EXPONENT TECU (default
 * EXPONENT −1, i.e. 0.1 TECU); 9999 ("no value") becomes NaN. An
 * EXPONENT record inside a map applies to the rows that follow it.
 *
 * The rest of the file — header records, the DIFFERENTIAL CODE BIASES
 * auxiliary block, RMS and height maps — is kept in optional fields so
 * {@link writeIonex} can write it back. Record layouts follow Appendix A
 * (Tables 1–2) and B of ionex1.pdf; the STATION / BIAS / RMS layout is the
 * one IGS analysis centres write. Only 2-D maps (MAP DIMENSION 2) are
 * modelled: rows of a 3-D map's different heights overwrite each other.
 */

/** PRN / BIAS / RMS (3X,A1,I2.2,2F10.3): satellite DCB in ns. */
export interface IonexSatDcb {
  prn: string;
  biasNs: number;
  rmsNs: number;
}

/** STATION / BIAS / RMS: receiver DCB in ns. */
export interface IonexStationDcb {
  /** System ('G', 'E', ...) or, for GLONASS FDMA, system + PRN ('R02'). */
  sys: string;
  name: string;
  /** DOMES number. */
  id: string;
  biasNs: number;
  rmsNs: number;
}

/** START OF AUX DATA … END OF AUX DATA. */
export interface IonexAuxData {
  /** Block name, e.g. 'DIFFERENTIAL CODE BIASES'. */
  name: string;
  sats: IonexSatDcb[];
  stations: IonexStationDcb[];
  comments: string[];
  /** The block lists its station records before the satellite ones. */
  stationsFirst?: boolean;
}

/** HGT1 / HGT2 / DHGT, LAT1 / LAT2 / DLAT, LON1 / LON2 / DLON. */
export interface IonexGridDef {
  from: number;
  to: number;
  step: number;
}

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

  /* ── Optional: the rest of the file, for writing it back ── */
  version?: number;
  /** Satellite system or model, e.g. 'GPS', 'MIX'. */
  system?: string;
  pgm?: string;
  runBy?: string;
  date?: string;
  descriptions?: string[];
  /** Header COMMENT lines (not those of the aux block). */
  comments?: string[];
  /** EPOCH OF FIRST / LAST MAP (ms, UT). */
  epochFirst?: number;
  epochLast?: number;
  /** INTERVAL (s; 0 = variable). */
  interval?: number;
  /** # OF MAPS IN FILE, as declared. */
  numMaps?: number;
  /** 'NONE', 'COSZ' (1/cos z), 'QFAC'. */
  mappingFunction?: string;
  /** ELEVATION CUTOFF (deg). */
  elevationCutoff?: number;
  observablesUsed?: string;
  numStations?: number;
  numSatellites?: number;
  /** BASE RADIUS (km). */
  baseRadius?: number;
  mapDimension?: number;
  /** Height grid (km); a 2-D map's single shell height is `hgt.from`. */
  hgt?: IonexGridDef;
  latDef?: IonexGridDef;
  lonDef?: IonexGridDef;
  /** Header EXPONENT (unit 10^k; default −1). */
  exponent?: number;
  aux?: IonexAuxData;
  /** Header labels in file order (the aux block as one entry). */
  headerOrder?: string[];
  /** A map-level EXPONENT per TEC map (null = the header's). */
  mapExponents?: (number | null)[];
  /** RMS maps (TECU), aligned with `maps` by map number. */
  rmsMaps?: Float32Array[];
  rmsExponents?: (number | null)[];
  /** The RMS map block carried an EPOCH OF CURRENT MAP record. */
  rmsHasEpoch?: boolean[];
  /** Height maps (km, × 10^EXPONENT; heights are HGT1 + value). */
  heightMaps?: Float32Array[];
  heightExponents?: (number | null)[];
  heightHasEpoch?: boolean[];
}

function gridRange(l1: number, l2: number, dl: number): number[] {
  const out: number[] = [];
  const n = Math.round((l2 - l1) / dl) + 1;
  for (let i = 0; i < n; i++) out.push(l1 + i * dl);
  return out;
}

const int = (s: string) => parseInt(s.trim(), 10);

/** 6I6 → ms. */
function epoch6(c: string): number {
  const f = c.trim().split(/\s+/).map(Number);
  return Date.UTC(f[0]!, f[1]! - 1, f[2]!, f[3]!, f[4]!, f[5]!);
}

/** "2X,3F6.1" grid definition (whitespace-split: values may touch). */
function gridDef(c: string): IonexGridDef {
  const f = c.trim().split(/\s+/).map(Number);
  return { from: f[0]!, to: f[1]!, step: f[2]! };
}

export function parseIonex(text: string): IonexGrid {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let exponent = -1;
  let lats: number[] = [];
  let lons: number[] = [];
  const epochs: number[] = [];
  const maps: Float32Array[] = [];
  const h: Partial<IonexGrid> = {};
  const descriptions: string[] = [];
  const comments: string[] = [];
  const order: string[] = [];

  let i = 0;
  // ── Header ──
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const label = line.slice(60).trim();
    const c = line.slice(0, 60);
    if (label && label !== 'START OF AUX DATA') order.push(label);
    if (label === 'EXPONENT') {
      exponent = int(c);
      h.exponent = exponent;
    } else if (label === 'LAT1 / LAT2 / DLAT') {
      h.latDef = gridDef(c);
      lats = gridRange(h.latDef.from, h.latDef.to, h.latDef.step);
    } else if (label === 'LON1 / LON2 / DLON') {
      h.lonDef = gridDef(c);
      lons = gridRange(h.lonDef.from, h.lonDef.to, h.lonDef.step);
    } else if (label === 'END OF HEADER') {
      i++;
      break;
    } else if (label === 'IONEX VERSION / TYPE') {
      // F8.1,12X,A1,19X,A3
      h.version = Number(c.slice(0, 8));
      h.system = c.slice(40, 43).trim();
    } else if (label === 'PGM / RUN BY / DATE') {
      h.pgm = c.slice(0, 20).trim();
      h.runBy = c.slice(20, 40).trim();
      h.date = c.slice(40, 60).trim();
    } else if (label === 'DESCRIPTION') {
      descriptions.push(c.trimEnd());
    } else if (label === 'COMMENT') {
      comments.push(c.trimEnd());
    } else if (label === 'EPOCH OF FIRST MAP') {
      h.epochFirst = epoch6(c);
    } else if (label === 'EPOCH OF LAST MAP') {
      h.epochLast = epoch6(c);
    } else if (label === 'INTERVAL') {
      h.interval = int(c);
    } else if (label === '# OF MAPS IN FILE') {
      h.numMaps = int(c);
    } else if (label === 'MAPPING FUNCTION') {
      h.mappingFunction = c.trim();
    } else if (label === 'ELEVATION CUTOFF') {
      h.elevationCutoff = Number(c.trim());
    } else if (label === 'OBSERVABLES USED') {
      h.observablesUsed = c.trim();
    } else if (label === '# OF STATIONS') {
      h.numStations = int(c);
    } else if (label === '# OF SATELLITES') {
      h.numSatellites = int(c);
    } else if (label === 'BASE RADIUS') {
      h.baseRadius = Number(c.trim());
    } else if (label === 'MAP DIMENSION') {
      h.mapDimension = int(c);
    } else if (label === 'HGT1 / HGT2 / DHGT') {
      h.hgt = gridDef(c);
    } else if (label === 'START OF AUX DATA') {
      order.push(label);
      const aux: IonexAuxData = {
        name: c.trim(),
        sats: [],
        stations: [],
        comments: [],
      };
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        const lab = l.slice(60).trim();
        if (lab === 'END OF AUX DATA') break;
        if (lab === 'PRN / BIAS / RMS') {
          aux.sats.push({
            prn: l.slice(3, 6).replace(/^ /, 'G').replace(/\s/g, '0'),
            biasNs: Number(l.slice(6, 16)),
            rmsNs: Number(l.slice(16, 26)),
          });
        } else if (lab === 'STATION / BIAS / RMS') {
          if (!aux.sats.length && !aux.stations.length)
            aux.stationsFirst = true;
          aux.stations.push({
            sys: l.slice(1, 4).trim(),
            name: l.slice(6, 10).trim(),
            id: l.slice(11, 26).trim(),
            biasNs: Number(l.slice(26, 36)),
            rmsNs: Number(l.slice(36, 46)),
          });
        } else if (lab === 'COMMENT') {
          aux.comments.push(l.slice(0, 60).trimEnd());
        }
      }
      h.aux = aux;
    }
  }
  if (lats.length === 0 || lons.length === 0) {
    throw new Error('IONEX: missing grid definition');
  }

  /** One START OF … MAP block, from its first record after START. */
  const readMap = (end: string) => {
    const map = new Float32Array(lats.length * lons.length).fill(NaN);
    let epochMs: number | null = null;
    let mapExp: number | null = null;
    // an EXPONENT inside the map applies to the rows that follow it
    let mapScale = Math.pow(10, exponent);
    while (i < lines.length) {
      const l = lines[i]!;
      const lab = l.slice(60).trim();
      if (lab === 'EXPONENT') {
        mapExp = int(l.slice(0, 60));
        mapScale = Math.pow(10, mapExp);
        i++;
      } else if (lab === 'EPOCH OF CURRENT MAP') {
        epochMs = epoch6(l.slice(0, 60));
        i++;
      } else if (lab === 'LAT/LON1/LON2/DLON/H') {
        // fixed columns: lat in cols 3-8 (2X,5F6.1)
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
                v === 9999 ? NaN : v * mapScale;
            }
            lonIdx++;
          }
          i++;
        }
      } else if (lab === end) {
        i++;
        break;
      } else {
        i++;
      }
    }
    return { map, epochMs, mapExp };
  };

  const rms: { n: number; map: Float32Array; e: number | null; ep: boolean }[] =
    [];
  const hgt: typeof rms = [];
  const mapExponents: (number | null)[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    const label = line.slice(60).trim();
    const n = int(line.slice(0, 6));
    if (label === 'START OF TEC MAP') {
      i++;
      const m = readMap('END OF TEC MAP');
      epochs.push(m.epochMs ?? 0);
      maps.push(m.map);
      mapExponents.push(m.mapExp);
    } else if (label === 'START OF RMS MAP') {
      i++;
      const m = readMap('END OF RMS MAP');
      rms.push({ n, map: m.map, e: m.mapExp, ep: m.epochMs !== null });
    } else if (label === 'START OF HEIGHT MAP') {
      i++;
      const m = readMap('END OF HEIGHT MAP');
      hgt.push({ n, map: m.map, e: m.mapExp, ep: m.epochMs !== null });
    } else if (label === 'END OF FILE') {
      break;
    } else {
      i++;
    }
  }

  const aligned = (list: typeof rms) => {
    const at = <T>(f: (b: (typeof rms)[0]) => T, fill: T) => {
      const out: T[] = Array.from({ length: maps.length }, () => fill);
      for (const b of list)
        if (b.n >= 1 && b.n <= maps.length) out[b.n - 1] = f(b);
      return out;
    };
    return {
      maps: at(
        (b) => b.map,
        new Float32Array(lats.length * lons.length).fill(NaN)
      ),
      exps: at<number | null>((b) => b.e, null),
      ep: at((b) => b.ep, true),
    };
  };
  const r = aligned(rms);
  const g = aligned(hgt);

  return {
    epochs,
    lats,
    lons,
    maps,
    ...h,
    descriptions,
    comments,
    headerOrder: order,
    mapExponents,
    ...(rms.length
      ? { rmsMaps: r.maps, rmsExponents: r.exps, rmsHasEpoch: r.ep }
      : {}),
    ...(hgt.length
      ? { heightMaps: g.maps, heightExponents: g.exps, heightHasEpoch: g.ep }
      : {}),
  };
}
