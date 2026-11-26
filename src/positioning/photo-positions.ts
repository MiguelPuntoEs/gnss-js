/**
 * Photo positions from a kinematic GNSS track: camera shutter events (a DJI
 * `Timestamp.MRK` file, RINEX event records, or any list of instants)
 * placed on the post-processed antenna track, then moved from the antenna
 * phase centre to the camera with the per-photo offset DJI records.
 *
 * The track is interpolated linearly in ECEF between the two epochs that
 * bracket each event, as GrafNav-based and RTKLIB-based workflows do; at
 * 5 Hz and 10 m/s the chord of a turn differs from the arc by millimetres.
 */

import { ecefToGeodetic, geodeticToEcef } from '../coordinates/ecef';
import type { RtkTrackPoint } from './rtk-postprocess';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

/** One shutter event. */
export interface CameraEvent {
  /** Photo number (the MRK's first column; 1-based). */
  index: number;
  /** Shutter instant, GPS-scale milliseconds. */
  timeMs: number;
  /**
   * Antenna phase centre → camera sensor, local North / East / Down (m),
   * as DJI records it per photo (it follows the gimbal); absent when the
   * source carries none.
   */
  offsetNed?: [number, number, number];
  /** The drone's own position for the photo, when the source has one. */
  onboard?: {
    /** Latitude, longitude (radians), ellipsoidal height (m). */
    lat: number;
    lon: number;
    height: number;
    /** Standard deviations North / East / Up (m). */
    sigma?: [number, number, number];
    /** Solution type: DJI flag 50 fixed, 34 float, 16 single, 0 none. */
    status: 'fixed' | 'float' | 'single' | 'none';
  };
}

const DJI_STATUS: Record<number, 'fixed' | 'float' | 'single' | 'none'> = {
  50: 'fixed',
  34: 'float',
  16: 'single',
  0: 'none',
};

/**
 * Parse a DJI `Timestamp.MRK` file (Phantom 4 RTK, Matrice 300/350 with
 * P1/L1/L2, Mavic 3 Enterprise). Each line holds the photo number, GPS
 * time of week and `[week]`, the antenna→camera offset in mm as
 * `n,N  e,E  v,V` (V down), the onboard `lat,Lat lon,Lon h,Ellh`, three
 * standard deviations (m) and `flag,Q`. Lines that don't match are
 * skipped.
 */
export function parseDjiMrk(text: string): CameraEvent[] {
  const out: CameraEvent[] = [];
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const head = new RegExp(`^\\s*(\\d+)\\s+${num}\\s+\\[(\\d+)\\]`);
  for (const line of text.split(/\r?\n/)) {
    const m = head.exec(line);
    if (!m) continue;
    const tow = Number(m[2]);
    const week = Number(m[3]);
    const ev: CameraEvent = {
      index: Number(m[1]),
      // Microseconds kept: the time of week has six decimals.
      timeMs: GPS_EPOCH_MS + (week * 604800 + tow) * 1000,
    };
    const field = (label: string): number | null => {
      const f = new RegExp(`${num}\\s*,\\s*${label}\\b`).exec(line);
      return f ? Number(f[1]) : null;
    };
    const n = field('N');
    const e = field('E');
    const v = field('V');
    if (n !== null && e !== null && v !== null)
      ev.offsetNed = [n / 1000, e / 1000, v / 1000];
    const lat = field('Lat');
    const lon = field('Lon');
    const h = field('Ellh');
    if (lat !== null && lon !== null && h !== null) {
      const q = field('Q');
      // The three standard deviations follow Ellh: "0.0169, 0.0189, 0.0468".
      const sd = new RegExp(
        `Ellh\\s+${num}\\s*,\\s*${num}\\s*,\\s*${num}`
      ).exec(line);
      ev.onboard = {
        lat: (lat * Math.PI) / 180,
        lon: (lon * Math.PI) / 180,
        height: h,
        ...(sd && { sigma: [Number(sd[1]), Number(sd[2]), Number(sd[3])] }),
        status: (q !== null && DJI_STATUS[q]) || 'none',
      };
    }
    out.push(ev);
  }
  return out;
}

/** A photo placed on the track. */
export interface PhotoPosition {
  index: number;
  timeMs: number;
  /** Camera position ECEF (m); the antenna's when the event has no offset. */
  position: [number, number, number];
  /** Geodetic latitude, longitude (radians), ellipsoidal height (m). */
  lat: number;
  lon: number;
  height: number;
  /** The worse of the two track epochs either side ('fixed' only when
   *  both are fixed). */
  status: RtkTrackPoint['status'];
  /** Time between the bracketing track epochs (ms). */
  gapMs: number;
  /** Camera − onboard position, local East / North / Up (m), when the
   *  event carries the drone's own position. */
  vsOnboard?: [number, number, number];
}

export interface PhotoPositionOptions {
  /**
   * Largest gap between the two track epochs around an event (ms); events
   * in a longer gap, or outside the track, are left out. Default 2.5 × the
   * track's median interval (0.5 s at 5 Hz).
   */
  maxGapMs?: number;
  /** Apply the events' antenna→camera offsets. Default true. */
  applyOffset?: boolean;
}

const RANK: Record<RtkTrackPoint['status'], number> = {
  fixed: 0,
  float: 1,
  dgnss: 2,
};

/** ENU → ECEF rotation of a local vector at (lat, lon). */
function enuToEcef(
  lat: number,
  lon: number,
  [e, n, u]: readonly [number, number, number]
): [number, number, number] {
  const [sl, cl, so, co] = [
    Math.sin(lat),
    Math.cos(lat),
    Math.sin(lon),
    Math.cos(lon),
  ];
  return [
    -so * e - sl * co * n + cl * co * u,
    co * e - sl * so * n + cl * so * u,
    cl * n + sl * u,
  ];
}

/** ECEF → ENU rotation of a local vector at (lat, lon). */
function ecefToEnu(
  lat: number,
  lon: number,
  [dx, dy, dz]: readonly [number, number, number]
): [number, number, number] {
  const [sl, cl, so, co] = [
    Math.sin(lat),
    Math.cos(lat),
    Math.sin(lon),
    Math.cos(lon),
  ];
  return [
    -so * dx + co * dy,
    -sl * co * dx - sl * so * dy + cl * dz,
    cl * co * dx + cl * so * dy + sl * dz,
  ];
}

/**
 * Place camera events on a post-processed track (`postProcessRtk(...)
 * .track`, kinematic): interpolate the antenna position to each shutter
 * instant, then add the event's antenna→camera offset. Events outside the
 * track or in a gap longer than `maxGapMs` are omitted.
 */
export function photoPositions(
  track: readonly RtkTrackPoint[],
  events: readonly CameraEvent[],
  opts: PhotoPositionOptions = {}
): PhotoPosition[] {
  const pts = [...track].sort((a, b) => a.timeMs - b.timeMs);
  if (pts.length < 2) return [];
  let maxGap = opts.maxGapMs;
  if (maxGap === undefined) {
    const gaps = pts
      .slice(1)
      .map((p, i) => p.timeMs - pts[i]!.timeMs)
      .sort((a, b) => a - b);
    maxGap = 2.5 * gaps[gaps.length >> 1]!;
  }
  const out: PhotoPosition[] = [];
  for (const ev of events) {
    // First track epoch at or after the event.
    let lo = 0;
    let hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.timeMs < ev.timeMs) lo = mid + 1;
      else hi = mid;
    }
    const b = pts[lo];
    if (!b) continue;
    const a = b.timeMs === ev.timeMs ? b : pts[lo - 1];
    if (!a) continue;
    const gapMs = b.timeMs - a.timeMs;
    if (gapMs > maxGap) continue;
    const w = gapMs > 0 ? (ev.timeMs - a.timeMs) / gapMs : 0;
    let pos: [number, number, number] = [0, 1, 2].map(
      (k) => a.position[k]! + w * (b.position[k]! - a.position[k]!)
    ) as [number, number, number];
    let [lat, lon, height] = ecefToGeodetic(pos[0], pos[1], pos[2]);
    if (ev.offsetNed && opts.applyOffset !== false) {
      const [n, e, d] = ev.offsetNed;
      const dx = enuToEcef(lat, lon, [e, n, -d]);
      pos = [pos[0] + dx[0], pos[1] + dx[1], pos[2] + dx[2]];
      [lat, lon, height] = ecefToGeodetic(pos[0], pos[1], pos[2]);
    }
    const p: PhotoPosition = {
      index: ev.index,
      timeMs: ev.timeMs,
      position: pos,
      lat,
      lon,
      height,
      status: RANK[a.status] >= RANK[b.status] ? a.status : b.status,
      gapMs,
    };
    if (ev.onboard) {
      const ob = geodeticToEcef(
        ev.onboard.lat,
        ev.onboard.lon,
        ev.onboard.height
      );
      p.vsOnboard = ecefToEnu(lat, lon, [
        pos[0] - ob[0],
        pos[1] - ob[1],
        pos[2] - ob[2],
      ]);
    }
    out.push(p);
  }
  return out;
}
