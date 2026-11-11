/**
 * One type for the national grids gnss-js knows — transverse Mercator
 * (`GridProjection`) or Lambert conformal conic (`ConicProjection`) — and
 * one pair of functions to use either.
 */
import {
  geodeticToLambertConformalConic,
  lambertConformalConicToGeodetic,
  type ConicProjection,
} from './lambert-conformal-conic';
import {
  geodeticToTransverseMercator,
  transverseMercatorToGeodetic,
  type GridProjection,
} from './transverse-mercator';

export type MapProjection = GridProjection | ConicProjection;

export function isConicProjection(p: MapProjection): p is ConicProjection {
  return 'lat1' in p;
}

/** Geodetic (radians) → easting/northing (m) on either kind of grid. */
export function geodeticToGrid(
  lat: number,
  lon: number,
  p: MapProjection
): { easting: number; northing: number } {
  return isConicProjection(p)
    ? geodeticToLambertConformalConic(lat, lon, p)
    : geodeticToTransverseMercator(lat, lon, p);
}

/** Easting/northing (m) → geodetic (radians) on either kind of grid. */
export function gridToGeodetic(
  easting: number,
  northing: number,
  p: MapProjection
): { lat: number; lon: number } {
  const g = isConicProjection(p)
    ? lambertConformalConicToGeodetic(easting, northing, p)
    : transverseMercatorToGeodetic(northing, easting, p);
  // Zones across the antimeridian (Aleutians) can step past ±180°.
  const lon = Math.atan2(Math.sin(g.lon), Math.cos(g.lon));
  return { lat: g.lat, lon };
}
