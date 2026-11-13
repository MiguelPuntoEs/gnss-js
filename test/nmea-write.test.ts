/**
 * NMEA 0183 writer: the specification examples reproduced byte for byte
 * (u-blox M8 protocol §30.2 — GGA, GSA, GSV, GST, RMC, ZDA in NMEA 4.10 form;
 * NovAtel OEM7 §3.66 GPGGA with a western longitude and a negative geoid
 * separation), and a round trip through parseNmeaFile with asymmetric
 * positions in all four hemispheres.
 */

import { describe, expect, it } from 'vitest';
import {
  formatNmeaCoord,
  nmeaSatId,
  parseNmeaFile,
  verifyChecksum,
  writeNmea,
} from '../src/nmea';
import type { NmeaEpoch } from '../src/nmea';

const lines = (s: string) => s.split('\r\n').filter(Boolean);
/** ddmm.mmmm + hemisphere → degrees, written here independently of the parser. */
const deg = (dm: number, hemi: string) =>
  (Math.floor(dm / 100) + (dm % 100) / 60) *
  (hemi === 'S' || hemi === 'W' ? -1 : 1);

/*
 * The u-blox M8 examples of the three sentences that gained NMEA 4.10 fields
 * (GSA system ID, GSV signal ID, RMC navigational status) print the 4.10
 * body with the checksum of the pre-4.10 body: XOR "$GPGSA,…,1.54,1*" gives
 * 10, not the printed 0D (= 10 XOR ",1"). Those lines are reproduced byte for
 * byte in v2.3 form, and as body + recomputed checksum in v4.10 form.
 */
const docBody = (l: string) => l.slice(0, l.indexOf('*'));

describe('specification examples, byte for byte', () => {
  it('u-blox GGA: $GPGGA,092725.00,4717.11399,N,00833.91590,E,1,08,1.01,499.6,M,48.0,M,,*5B', () => {
    const out = writeNmea(
      [
        {
          time: new Date(Date.UTC(2002, 8, 16, 9, 27, 25)),
          lat: deg(4717.11399, 'N'),
          lon: deg(833.9159, 'E'),
          altMsl: 499.6,
          geoidSeparation: 48.0,
          fixQuality: 1,
          numSv: 8,
          hdop: 1.01,
        },
      ],
      { sentences: ['GGA'], decimals: { minutes: 5, alt: 1 } }
    );
    expect(lines(out)).toEqual([
      '$GPGGA,092725.00,4717.11399,N,00833.91590,E,1,08,1.01,499.6,M,48.0,M,,*5B',
    ]);
  });

  it('NovAtel GPGGA: western longitude, negative separation, RTK float, diff age + station', () => {
    const out = writeNmea(
      [
        {
          time: new Date(Date.UTC(2020, 0, 1, 20, 25, 30)),
          lat: deg(5109.0262, 'N'),
          lon: deg(11401.8407, 'W'),
          altMsl: 1097.36,
          geoidSeparation: -17.0,
          fixQuality: 5,
          numSv: 40,
          hdop: 0.5,
          diffAge: 18,
          diffStation: 'TSTR',
        },
      ],
      { sentences: ['GGA'], decimals: { minutes: 4, alt: 2, dop: 1 } }
    );
    expect(lines(out)).toEqual([
      '$GPGGA,202530.00,5109.0262,N,11401.8407,W,5,40,0.5,1097.36,M,-17.00,M,18,TSTR*61',
    ]);
  });

  it('u-blox GSA + GSV (NMEA 4.10: system ID, signal ID 0)', () => {
    const view: [number, number, number, number | null][] = [
      [23, 38, 230, 44],
      [29, 71, 156, 47],
      [7, 29, 116, 41],
      [8, 9, 81, 36],
      [10, 7, 189, null],
      [5, 5, 220, null],
      [9, 34, 274, 42],
      [18, 25, 309, 44],
      [26, 82, 187, 47],
      [28, 43, 56, 46],
    ];
    const used = [23, 29, 7, 8, 9, 18, 26, 28];
    const epoch: NmeaEpoch = {
      time: new Date(Date.UTC(2002, 8, 16, 8, 27, 10)),
      lat: 47.28,
      lon: 8.56,
      fixQuality: 1,
      pdop: 1.94,
      hdop: 1.18,
      vdop: 1.54,
      satellites: view.map(([n, el, az, cn0]) => ({
        prn: `G${String(n).padStart(2, '0')}`,
        elevationDeg: el,
        azimuthDeg: az,
        cn0,
        used: false,
      })),
    };
    // GSA lists used satellites in the order given.
    epoch.satellites = [
      ...used.map((n) => ({
        ...epoch.satellites!.find((s) => +s.prn.slice(1) === n)!,
        used: true,
      })),
      ...epoch.satellites!.filter((s) => !used.includes(+s.prn.slice(1))),
    ];
    const gsa = writeNmea([epoch], { sentences: ['GSA'] });
    expect(lines(gsa).map(docBody)).toEqual([
      docBody('$GPGSA,A,3,23,29,07,08,09,18,26,28,,,,,1.94,1.18,1.54,1*0D'),
    ]);
    expect(
      lines(writeNmea([epoch], { sentences: ['GSA'], version: '2.3' }))
    ).toEqual(['$GPGSA,A,3,23,29,07,08,09,18,26,28,,,,,1.94,1.18,1.54*0D']);
    // GSV lists satellites in view in the order given (the spec's order).
    epoch.satellites = view.map(([n, el, az, cn0]) => ({
      prn: `G${String(n).padStart(2, '0')}`,
      elevationDeg: el,
      azimuthDeg: az,
      cn0,
    }));
    const doc = [
      '$GPGSV,3,1,10,23,38,230,44,29,71,156,47,07,29,116,41,08,09,081,36,0*7F',
      '$GPGSV,3,2,10,10,07,189,,05,05,220,,09,34,274,42,18,25,309,44,0*72',
      '$GPGSV,3,3,10,26,82,187,47,28,43,056,46,0*77',
    ];
    expect(
      lines(writeNmea([epoch], { sentences: ['GSV'] })).map(docBody)
    ).toEqual(doc.map(docBody));
    expect(
      lines(writeNmea([epoch], { sentences: ['GSV'], version: '2.3' }))
    ).toEqual(doc.map((l) => l.replace(',0*', '*')));
  });

  it('u-blox RMC, GST and ZDA', () => {
    const rmcEpoch = [
      {
        time: new Date(Date.UTC(2002, 11, 9, 8, 35, 59)),
        lat: deg(4717.11437, 'N'),
        lon: deg(833.91522, 'E'),
        fixQuality: 1,
        speedKnots: 0.004,
        courseDeg: 77.52,
      },
    ];
    const doc =
      '$GPRMC,083559.00,A,4717.11437,N,00833.91522,E,0.004,77.52,091202,,,A,V*57';
    const rmc = writeNmea(rmcEpoch, {
      sentences: ['RMC'],
      decimals: { minutes: 5 },
    });
    expect(lines(rmc).map(docBody)).toEqual([docBody(doc)]);
    expect(
      lines(
        writeNmea(rmcEpoch, {
          sentences: ['RMC'],
          decimals: { minutes: 5 },
          version: '2.3',
        })
      )
    ).toEqual([doc.replace(',V*', '*')]);
    const gst = writeNmea(
      [
        {
          time: new Date(Date.UTC(2002, 8, 16, 8, 23, 56)),
          lat: 47,
          lon: 8,
          fixQuality: 1,
          gst: { rangeRms: 1.8, sigmaLat: 1.7, sigmaLon: 1.3, sigmaAlt: 2.2 },
        },
      ],
      { sentences: ['GST'], decimals: { gst: 1 } }
    );
    expect(lines(gst)).toEqual(['$GPGST,082356.00,1.8,,,,1.7,1.3,2.2*7E']);
    const zda = writeNmea(
      [
        {
          time: new Date(Date.UTC(2002, 8, 16, 8, 27, 10)),
          lat: 0,
          lon: 0,
          fixQuality: 1,
        },
      ],
      { sentences: ['ZDA'] }
    );
    expect(lines(zda)).toEqual(['$GPZDA,082710.00,16,09,2002,00,00*64']);
  });
});

describe('conventions', () => {
  it('ddmm.mmmm: degrees zero-padded (2 lat, 3 lon), minute carry into degrees', () => {
    expect(formatNmeaCoord(4.5, true, 4)).toEqual(['00430.0000', 'E']);
    expect(formatNmeaCoord(-0.5, false, 4)).toEqual(['0030.0000', 'S']);
    expect(formatNmeaCoord(-123.25, true, 4)).toEqual(['12315.0000', 'W']);
    // 51° 59.99999999′ rounds to 52° 00.0000′, not "5160.0000".
    expect(formatNmeaCoord(51 + 59.99999999 / 60, false, 4)).toEqual([
      '5200.0000',
      'N',
    ]);
  });

  it('NMEA 4.10/4.11 satellite numbering', () => {
    expect(nmeaSatId('G05')).toEqual({ talker: 'GP', svId: 5, systemId: 1 });
    expect(nmeaSatId('S20')).toEqual({ talker: 'GP', svId: 33, systemId: 1 }); // PRN 120
    expect(nmeaSatId('R12')).toEqual({ talker: 'GL', svId: 76, systemId: 2 });
    expect(nmeaSatId('E11')).toEqual({ talker: 'GA', svId: 11, systemId: 3 });
    expect(nmeaSatId('C23')).toEqual({ talker: 'GB', svId: 23, systemId: 4 });
    expect(nmeaSatId('J02')).toEqual({ talker: 'GQ', svId: 2, systemId: 5 });
  });

  it('every sentence carries a valid checksum (independent XOR)', () => {
    const out = writeNmea(EPOCHS);
    for (const l of lines(out)) {
      expect(l).toMatch(/^\$[A-Z]{5},.*\*[0-9A-F]{2}$/);
      expect(verifyChecksum(l)).toBe(true);
      const body = l.slice(1, l.indexOf('*'));
      let x = 0;
      for (const ch of body) x ^= ch.charCodeAt(0);
      expect(l.slice(-2)).toBe(x.toString(16).toUpperCase().padStart(2, '0'));
    }
    expect(out.endsWith('\r\n')).toBe(true);
  });
});

/* Four hemispheres, |lat| ≠ |lon|, longitude < 100° (leading zero), an
   epoch across midnight UTC, multi-GNSS satellites. */
const EPOCHS: NmeaEpoch[] = [
  [
    51.98601602,
    4.38745705,
    75.81 - 47.11,
    47.11,
    4,
    '2026-11-12T23:59:59.000Z',
  ],
  [-33.86785, 151.20732, 12.3, 22.4, 5, '2026-11-13T00:00:00.000Z'],
  [-12.04637, -77.04279, 154.2, 9.8, 1, '2026-11-13T00:00:01.000Z'],
  [40.71278, -74.00594, 10.5, -32.7, 2, '2026-11-13T00:00:02.500Z'],
].map(([lat, lon, alt, sep, q, t]) => ({
  time: new Date(t as string),
  lat: lat as number,
  lon: lon as number,
  altMsl: alt as number,
  geoidSeparation: sep as number,
  fixQuality: q as number,
  hdop: 0.87,
  pdop: 1.53,
  vdop: 1.26,
  speedKnots: 0.123,
  courseDeg: 287.45,
  gst: {
    rangeRms: 0.42,
    sigmaMajor: 0.031,
    sigmaMinor: 0.018,
    orientationDeg: 37.5,
    sigmaLat: 0.027,
    sigmaLon: 0.021,
    sigmaAlt: 0.058,
  },
  satellites: [
    { prn: 'G05', elevationDeg: 61, azimuthDeg: 292, cn0: 49, used: true },
    { prn: 'G12', elevationDeg: 8, azimuthDeg: 31, cn0: 33, used: false },
    { prn: 'R12', elevationDeg: 44, azimuthDeg: 117, cn0: 45, used: true },
    { prn: 'E11', elevationDeg: 27, azimuthDeg: 203, cn0: 41, used: true },
    { prn: 'C23', elevationDeg: 72, azimuthDeg: 5, cn0: 47, used: true },
  ],
}));

describe('round trip through parseNmeaFile', () => {
  const track = parseNmeaFile(writeNmea(EPOCHS));

  it('one fix per epoch, GGA and RMC merged', () => {
    expect(track.fixes).toHaveLength(4);
  });

  it('lat/lon signs and values survive to the 7-decimal minute (2 mm)', () => {
    track.fixes.forEach((f, i) => {
      expect(f.lat).toBeCloseTo(EPOCHS[i]!.lat!, 8);
      expect(f.lon).toBeCloseTo(EPOCHS[i]!.lon!, 8);
    });
    expect(
      track.fixes.map((f) => [Math.sign(f.lat), Math.sign(f.lon)])
    ).toEqual([
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]);
  });

  it('alt is MSL, geoidSep separate; ellipsoidal = alt + geoidSep', () => {
    track.fixes.forEach((f, i) => {
      expect(f.alt).toBeCloseTo(EPOCHS[i]!.altMsl!, 3);
      expect(f.geoidSep).toBeCloseTo(EPOCHS[i]!.geoidSeparation!, 3);
      expect(f.hdop).toBe(0.87);
    });
    expect(track.fixes[0]!.alt! + track.fixes[0]!.geoidSep!).toBeCloseTo(
      75.81,
      3
    );
  });

  it('UTC time and the RMC date, across midnight', () => {
    expect(track.fixes.map((f) => f.time!.toISOString())).toEqual(
      EPOCHS.map((e) => e.time.toISOString())
    );
  });

  it('quality, satellites used, speed and course', () => {
    expect(track.fixes.map((f) => f.fixQuality)).toEqual([4, 5, 1, 2]);
    for (const f of track.fixes) {
      expect(f.satellites).toBe(4);
      expect(f.speed).toBe(0.123);
      expect(f.course).toBe(287.45);
    }
  });

  it('GSA per system and GSV per talker carry the satellites', () => {
    const out = lines(writeNmea(EPOCHS.slice(0, 1)));
    const ids = out.map((l) => l.slice(1, 6));
    expect(ids).toEqual([
      'GNGGA',
      'GNRMC',
      'GNGSA',
      'GNGSA',
      'GNGSA',
      'GNGSA',
      'GPGSV',
      'GLGSV',
      'GAGSV',
      'GBGSV',
      'GNGST',
      'GNZDA',
    ]);
    // GPS GSA: only the used G05; system ID 1.
    expect(out[2]).toMatch(/^\$GNGSA,A,3,05,,,,,,,,,,,,1\.53,0\.87,1\.26,1\*/);
    expect(out[3]).toMatch(/^\$GNGSA,A,3,76,/); // GLONASS slot 12 → 76
    expect(out[6]).toMatch(/^\$GPGSV,1,1,02,05,61,292,49,12,08,031,33,0\*/);
  });
});
