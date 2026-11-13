// ── NMEA 0183 sentence writer ────────────────────────────
// GGA, RMC, GSA, GSV, GST and ZDA from a position / time / satellite model,
// in NMEA 0183 v4.10/4.11 form (GSA system ID, GSV signal ID, RMC
// navigational status) or v2.3 form. Field layouts and examples follow the
// u-blox M8 protocol description (UBX-13003221 R13 §30.2) and the NovAtel
// OEM7 logs manual (GPGGA §3.66, GPGST, GPRMC, GPZDA).

/** One satellite for GSA (used in fix) and GSV (in view). */
export interface NmeaSatellite {
  /** RINEX PRN, e.g. "G05", "R12", "E11", "C23", "J02", "S20" (= PRN 120). */
  prn: string;
  elevationDeg?: number | null;
  azimuthDeg?: number | null;
  /** C/N0 (dB-Hz); blank in GSV when null. */
  cn0?: number | null;
  /** Used in the position fix → listed in GSA. */
  used?: boolean;
}

/** GST pseudorange error statistics (all 1-σ, metres). */
export interface NmeaGst {
  rangeRms?: number | null;
  sigmaMajor?: number | null;
  sigmaMinor?: number | null;
  /** Orientation of the semi-major axis, degrees from true north. */
  orientationDeg?: number | null;
  sigmaLat?: number | null;
  sigmaLon?: number | null;
  sigmaAlt?: number | null;
}

/** One navigation epoch. Time is UTC, as every NMEA time field. */
export interface NmeaEpoch {
  time: Date;
  /** Degrees, north positive. */
  lat: number | null;
  /** Degrees, east positive. */
  lon: number | null;
  /** GGA field 9: antenna altitude above mean sea level (geoid), m. */
  altMsl?: number | null;
  /**
   * GGA field 11: geoid separation N = ellipsoidal height − MSL altitude
   * ("−" = geoid below the ellipsoid), m. Ellipsoidal h = altMsl + N.
   */
  geoidSeparation?: number | null;
  /** GGA quality: 0 invalid, 1 GPS, 2 DGPS, 4 RTK fixed, 5 RTK float, 6 DR. */
  fixQuality: number;
  /** GGA satellites used; default the number of `used` satellites. */
  numSv?: number | null;
  hdop?: number | null;
  pdop?: number | null;
  vdop?: number | null;
  /** GSA navigation mode: 1 no fix, 2 2D, 3 3D (default 3 with a fix). */
  fixDim?: 1 | 2 | 3;
  speedKnots?: number | null;
  courseDeg?: number | null;
  /** GGA age of differential corrections (s) and station ID. */
  diffAge?: number | null;
  diffStation?: string | null;
  gst?: NmeaGst;
  satellites?: NmeaSatellite[];
}

export type NmeaSentence = 'GGA' | 'RMC' | 'GSA' | 'GSV' | 'GST' | 'ZDA';

export interface NmeaWriteOptions {
  /** Sentences per epoch, in this order (default all six). */
  sentences?: readonly NmeaSentence[];
  /** Talker for GGA/RMC/GST/ZDA (default "GN", or "GP" for GPS-only epochs). */
  talker?: string;
  /** "4.10" (default) adds GSA system ID, GSV signal ID, RMC nav status. */
  version?: '2.3' | '4.10';
  /** Decimal places (defaults: minutes 7, alt 3, dop 2, time 2, speed 3, course 2, gst 3). */
  decimals?: Partial<
    Record<
      'minutes' | 'alt' | 'dop' | 'time' | 'speed' | 'course' | 'gst',
      number
    >
  >;
  /** Line terminator (default CRLF, as the standard requires). */
  eol?: string;
}

/** XOR of every character between '$' and '*', as two upper-case hex digits. */
export function nmeaChecksum(body: string): string {
  let x = 0;
  for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
  return x.toString(16).toUpperCase().padStart(2, '0');
}

/** Wrap comma-separated fields as `$<body>*hh`. */
function sentence(fields: (string | number)[]): string {
  const body = fields.join(',');
  return `$${body}*${nmeaChecksum(body)}`;
}

const num = (v: number | null | undefined, d: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(d);

/**
 * Degrees → NMEA (d)ddmm.mmmm + hemisphere. Rounds the total minutes first so
 * 59.9999999′ carries into the degrees instead of printing "60.0000000".
 */
export function formatNmeaCoord(
  deg: number,
  isLon: boolean,
  decimals: number
): [string, string] {
  const scale = 10 ** decimals;
  const totalMin = Math.round(Math.abs(deg) * 60 * scale) / scale;
  const d = Math.floor(totalMin / 60 + 1e-12);
  const m = totalMin - d * 60;
  const mm = Math.max(0, m)
    .toFixed(decimals)
    .padStart(decimals + 3, '0');
  const hemi = isLon ? (deg < 0 ? 'W' : 'E') : deg < 0 ? 'S' : 'N';
  return [String(d).padStart(isLon ? 3 : 2, '0') + mm, hemi];
}

function hhmmss(t: Date, decimals: number): string {
  const ms = t.getTime();
  const s = (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s - h * 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  const two = (n: number) => String(n).padStart(2, '0');
  const secStr =
    decimals > 0
      ? sec.toFixed(decimals).padStart(decimals + 3, '0')
      : two(Math.round(sec));
  return two(h) + two(m) + secStr;
}

/** NMEA 4.10/4.11 talker, SV ID and system ID for a RINEX PRN. */
export function nmeaSatId(
  prn: string
): { talker: string; svId: number; systemId: number } | null {
  const n = parseInt(prn.slice(1), 10);
  if (!Number.isFinite(n)) return null;
  switch (prn[0]) {
    case 'G':
      return { talker: 'GP', svId: n, systemId: 1 };
    case 'S':
      return { talker: 'GP', svId: n + 100 - 87, systemId: 1 }; // PRN 120 → 33
    case 'R':
      return { talker: 'GL', svId: 64 + n, systemId: 2 };
    case 'E':
      return { talker: 'GA', svId: n, systemId: 3 };
    case 'C':
      return { talker: 'GB', svId: n, systemId: 4 };
    case 'J':
      return { talker: 'GQ', svId: n, systemId: 5 }; // NMEA 4.11
    case 'I':
      return { talker: 'GI', svId: n, systemId: 6 };
    default:
      return null;
  }
}

/** RMC / GNS mode indicator from the GGA quality. */
const MODE: Record<number, string> = {
  0: 'N',
  1: 'A',
  2: 'D',
  3: 'P',
  4: 'R',
  5: 'F',
  6: 'E',
  7: 'M',
  8: 'S',
};

/**
 * Write NMEA 0183 sentences for a sequence of epochs. Sentences without the
 * data they need (no satellites → no GSA/GSV, no `gst` → no GST) are skipped.
 */
export function writeNmea(
  epochs: readonly NmeaEpoch[],
  opts: NmeaWriteOptions = {}
): string {
  const want = opts.sentences ?? ['GGA', 'RMC', 'GSA', 'GSV', 'GST', 'ZDA'];
  const v4 = (opts.version ?? '4.10') === '4.10';
  const dec = {
    minutes: 7,
    alt: 3,
    dop: 2,
    time: 2,
    speed: 3,
    course: 2,
    gst: 3,
    ...opts.decimals,
  };
  const eol = opts.eol ?? '\r\n';
  const out: string[] = [];

  for (const e of epochs) {
    const sats = e.satellites ?? [];
    const used = sats.filter((s) => s.used);
    const talker =
      opts.talker ??
      (sats.every((s) => 'GS'.includes(s.prn[0]!)) ? 'GP' : 'GN');
    const fix = e.fixQuality > 0 && e.lat !== null && e.lon !== null;
    // Round once so the time field and the RMC/ZDA date agree at midnight.
    const unit = 1000 / 10 ** dec.time;
    const t = new Date(Math.round(e.time.getTime() / unit) * unit);
    const time = hhmmss(t, dec.time);
    const [lat, ns] = fix
      ? formatNmeaCoord(e.lat!, false, dec.minutes)
      : ['', ''];
    const [lon, ew] = fix
      ? formatNmeaCoord(e.lon!, true, dec.minutes)
      : ['', ''];

    for (const s of want) {
      if (s === 'GGA') {
        const nsv = e.numSv ?? used.length;
        out.push(
          sentence([
            `${talker}GGA`,
            time,
            lat,
            ns,
            lon,
            ew,
            e.fixQuality,
            String(nsv).padStart(2, '0'),
            num(e.hdop, dec.dop),
            num(e.altMsl, dec.alt),
            'M',
            num(e.geoidSeparation, dec.alt),
            'M',
            e.diffAge === null || e.diffAge === undefined
              ? ''
              : String(e.diffAge),
            e.diffStation ?? '',
          ])
        );
      } else if (s === 'RMC') {
        const d = t;
        const date =
          String(d.getUTCDate()).padStart(2, '0') +
          String(d.getUTCMonth() + 1).padStart(2, '0') +
          String(d.getUTCFullYear() % 100).padStart(2, '0');
        const f = [
          `${talker}RMC`,
          time,
          fix ? 'A' : 'V',
          lat,
          ns,
          lon,
          ew,
          num(e.speedKnots, dec.speed),
          num(e.courseDeg, dec.course),
          date,
          '',
          '',
          MODE[fix ? e.fixQuality : 0] ?? 'A',
        ];
        if (v4) f.push('V'); // navigational status: not provided
        out.push(sentence(f));
      } else if (s === 'GSA') {
        // One GSA per system, ≤ 12 satellites each (split if more).
        const bySys = new Map<number, number[]>();
        for (const sat of used) {
          const id = nmeaSatId(sat.prn);
          if (!id) continue;
          (
            bySys.get(id.systemId) ??
            bySys.set(id.systemId, []).get(id.systemId)!
          ).push(id.svId);
        }
        const gsaTalker = bySys.size > 1 ? 'GN' : talker;
        for (const [sysId, ids] of bySys) {
          for (let k = 0; k < ids.length; k += 12) {
            const chunk = ids
              .slice(k, k + 12)
              .map((n) => String(n).padStart(2, '0'));
            while (chunk.length < 12) chunk.push('');
            const f: (string | number)[] = [
              `${gsaTalker}GSA`,
              'A',
              fix ? (e.fixDim ?? 3) : 1,
              ...chunk,
              num(e.pdop, dec.dop),
              num(e.hdop, dec.dop),
              num(e.vdop, dec.dop),
            ];
            if (v4) f.push(sysId);
            out.push(sentence(f));
          }
        }
      } else if (s === 'GSV') {
        // One GSV group per talker (system), four satellites per sentence.
        const byTalker = new Map<string, { id: number; s: NmeaSatellite }[]>();
        for (const sat of sats) {
          const id = nmeaSatId(sat.prn);
          if (!id) continue;
          (
            byTalker.get(id.talker) ??
            byTalker.set(id.talker, []).get(id.talker)!
          ).push({ id: id.svId, s: sat });
        }
        for (const [t, list] of byTalker) {
          const nMsg = Math.ceil(list.length / 4);
          for (let m = 0; m < nMsg; m++) {
            const f: (string | number)[] = [
              `${t}GSV`,
              nMsg,
              m + 1,
              String(list.length).padStart(2, '0'),
            ];
            for (const { id, s: sat } of list.slice(m * 4, m * 4 + 4)) {
              f.push(
                String(id).padStart(2, '0'),
                sat.elevationDeg == null
                  ? ''
                  : String(Math.round(sat.elevationDeg)).padStart(2, '0'),
                sat.azimuthDeg == null
                  ? ''
                  : String(Math.round(sat.azimuthDeg) % 360).padStart(3, '0'),
                sat.cn0 == null
                  ? ''
                  : String(Math.round(sat.cn0)).padStart(2, '0')
              );
            }
            if (v4) f.push(0); // signal ID 0 = all signals
            out.push(sentence(f));
          }
        }
      } else if (s === 'GST') {
        if (!e.gst) continue;
        const g = e.gst;
        out.push(
          sentence([
            `${talker}GST`,
            time,
            num(g.rangeRms, dec.gst),
            num(g.sigmaMajor, dec.gst),
            num(g.sigmaMinor, dec.gst),
            num(g.orientationDeg, dec.gst),
            num(g.sigmaLat, dec.gst),
            num(g.sigmaLon, dec.gst),
            num(g.sigmaAlt, dec.gst),
          ])
        );
      } else if (s === 'ZDA') {
        const d = t;
        out.push(
          sentence([
            `${talker}ZDA`,
            time,
            String(d.getUTCDate()).padStart(2, '0'),
            String(d.getUTCMonth() + 1).padStart(2, '0'),
            String(d.getUTCFullYear()),
            '00',
            '00',
          ])
        );
      }
    }
  }
  return out.length ? out.join(eol) + eol : '';
}
