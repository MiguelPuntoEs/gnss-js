/**
 * National transverse Mercator grids, by country, with parameters as
 * registered in EPSG (checked against PROJ 9.8). All are on GRS80 and use
 * the Krüger series in `transverse-mercator.ts`. Each grid belongs with its
 * national frame (EUREF-FIN, EUREF89, ETRS89-DNK, GDA2020/GDA94,
 * NAD83(CSRS)): convert the position into that frame first.
 */
import {
  GRS80_FLATTENING,
  GRS80_SEMI_MAJOR_AXIS,
  type GridProjection,
} from './transverse-mercator';
import type { ConicProjection } from './lambert-conformal-conic';

const tm = (
  name: string,
  epsg: number,
  lon0: number,
  k0: number,
  falseEasting: number,
  falseNorthing = 0,
  lat0 = 0
): GridProjection => ({
  name,
  epsg,
  a: GRS80_SEMI_MAJOR_AXIS,
  f: GRS80_FLATTENING,
  lon0,
  k0,
  falseEasting,
  falseNorthing,
  ...(lat0 ? { lat0 } : {}),
});

const utm = (name: string, epsg: number, zone: number, south = false) =>
  tm(name, epsg, zone * 6 - 183, 0.9996, 500000, south ? 10000000 : 0);

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/* Finland — EUREF-FIN (JHS 154) */

/** TM35FIN, Finland's national grid (EPSG:3067). */
export const TM35FIN = tm('TM35FIN', 3067, 27, 0.9996, 500000);

/**
 * ETRS-GK19 … GK31, the 1°-zone plane grids municipalities survey in
 * (EPSG:3873–3885). The false easting carries the zone number:
 * Helsinki (GK25) eastings read 25 4xx xxx.
 */
export const FINLAND_GK_ZONES: readonly GridProjection[] = range(19, 31).map(
  (z) => tm(`ETRS-GK${z}`, 3854 + z, z, 1, z * 1e6 + 500000)
);

/* Norway — EUREF89 */

/** EUREF89 UTM zones 32, 33 and 35, Norway's map grids (EPSG:25832/3/5). */
export const NORWAY_UTM_ZONES: readonly GridProjection[] = [32, 33, 35].map(
  (z) => utm(`EUREF89 UTM zone ${z}`, 25800 + z, z)
);

/**
 * NTM zones 5–30 (EPSG:5105–5130): 1° zones on the half degree, scale 1,
 * origin 58°N with 1 000 km north / 100 km east false offsets.
 */
export const NORWAY_NTM_ZONES: readonly GridProjection[] = range(5, 30).map(
  (z) => tm(`NTM zone ${z}`, 5100 + z, z + 0.5, 1, 100000, 1000000, 58)
);

/* Denmark — ETRS89 (DK) */

/** UTM zones 32 and 33, Denmark's official grids (EPSG:25832/25833). */
export const DENMARK_UTM_ZONES: readonly GridProjection[] = [32, 33].map((z) =>
  utm(`ETRS89 UTM zone ${z}`, 25800 + z, z)
);

/** DKTM1–4, the low-distortion technical grids (EPSG:4093–4096). */
export const DENMARK_DKTM_ZONES: readonly GridProjection[] = [
  tm('DKTM1', 4093, 9, 0.99998, 200000, -5000000),
  tm('DKTM2', 4094, 10, 0.99998, 400000, -5000000),
  tm('DKTM3', 4095, 11.75, 0.99998, 600000, -5000000),
  tm('DKTM4', 4096, 15, 1, 800000, -5000000),
];

/* Australia — Map Grid of Australia (UTM south) */

/** MGA2020 zones 46–59 on GDA2020 (EPSG:7846–7859). */
export const MGA2020_ZONES: readonly GridProjection[] = range(46, 59).map((z) =>
  utm(`MGA2020 zone ${z}`, 7800 + z, z, true)
);

/** MGA94 zones 46–59 on GDA94 (EPSG:6736, 6737, 28348–28358, 6738). */
export const MGA94_ZONES: readonly GridProjection[] = range(46, 59).map((z) =>
  utm(
    `MGA94 zone ${z}`,
    z === 46 ? 6736 : z === 47 ? 6737 : z === 59 ? 6738 : 28300 + z,
    z,
    true
  )
);

/* Canada — NAD83(CSRS) */

const CSRS_UTM_EPSG: Record<number, number> = {
  7: 3154,
  8: 3155,
  9: 3156,
  10: 3157,
  11: 2955,
  12: 2956,
  13: 2957,
  14: 3158,
  15: 3159,
  16: 3160,
  17: 2958,
  18: 2959,
  19: 2960,
  20: 2961,
  21: 2962,
  22: 3761,
  23: 9709,
  24: 9713,
};

/** NAD83(CSRS) UTM zones 7N–24N. */
export const CANADA_UTM_ZONES: readonly GridProjection[] = range(7, 24).map(
  (z) => utm(`NAD83(CSRS) UTM zone ${z}N`, CSRS_UTM_EPSG[z]!, z)
);

/** MTM central meridians (degrees west), zones 1–17. */
const MTM_CM = [
  53, 56, 58.5, 61.5, 64.5, 67.5, 70.5, 73.5, 76.5, 79.5, 82.5, 81, 84, 87, 90,
  93, 96,
];
const MTM_EPSG = [
  26898, 26899, 2945, 2946, 2947, 2948, 2949, 2950, 2951, 2952, 26891, 26892,
  26893, 26894, 26895, 26896, 26897,
];

/**
 * Modified Transverse Mercator zones 1–17 (3° zones, scale 0.9999, false
 * easting 304 800 m), used in Québec, Ontario and the Maritimes.
 */
export const CANADA_MTM_ZONES: readonly GridProjection[] = MTM_CM.map((cm, i) =>
  tm(`NAD83(CSRS) MTM zone ${i + 1}`, MTM_EPSG[i]!, -cm, 0.9999, 304800)
);

/* Belgium — ETRS89 (BEREF, ETRF2000) */

/** Belgian Lambert 2008 (EPSG:3812). */
export const BELGIAN_LAMBERT_2008: ConicProjection = {
  name: 'Belgian Lambert 2008',
  epsg: 3812,
  a: GRS80_SEMI_MAJOR_AXIS,
  f: GRS80_FLATTENING,
  lat0: 50 + 47 / 60 + 52.134 / 3600,
  lon0: 4 + 21 / 60 + 33.177 / 3600,
  lat1: 49 + 50 / 60,
  lat2: 51 + 10 / 60,
  falseEasting: 649328,
  falseNorthing: 665262,
};

/* Poland — ETRF2000-PL. Polish practice writes x (northing) first. */

/** PL-1992 / CS92 (EPSG:2180), the national map grid. */
export const POLAND_CS92 = tm('PL-1992', 2180, 19, 0.9993, 500000, -5300000);

/** PL-2000 / CS2000 zones 5–8 (EPSG:2176–2179), for large-scale work. */
export const POLAND_CS2000_ZONES: readonly GridProjection[] = [5, 6, 7, 8].map(
  (z) => tm(`PL-2000 zone ${z}`, 2171 + z, z * 3, 0.999923, z * 1e6 + 500000)
);

/* Ireland — ETRS89 (ETRF2000 @ 2009.756) */

/** Irish Transverse Mercator (EPSG:2157), the Republic's national grid. */
export const IRISH_TM = tm('ITM', 2157, -8, 0.99982, 600000, 750000, 53.5);

/* Portugal — ETRS89 (ETRF97 @ 1995.4) */

/** PT-TM06 (EPSG:3763), mainland Portugal; origin at the Melriça vertex. */
export const PORTUGAL_TM06 = tm(
  'PT-TM06',
  3763,
  -(8 + 7 / 60 + 59.19 / 3600),
  1,
  0,
  0,
  39 + 40 / 60 + 5.73 / 3600
);

/* Spain — ETRS89 (ERGNSS: ETRF2000 @ 2017.0) */

/** ETRS89 UTM zones 29–31 (EPSG:25829–25831), mainland Spain and the Balearics. */
export const SPAIN_UTM_ZONES: readonly GridProjection[] = [29, 30, 31].map(
  (z) => utm(`ETRS89 UTM zone ${z}N`, 25800 + z, z)
);
