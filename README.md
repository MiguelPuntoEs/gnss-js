# gnss-js

Comprehensive GNSS library for JavaScript and TypeScript. Zero dependencies. Works in Node.js, browsers, Deno, Bun, and Workers.

## Install

```bash
npm install gnss-js
```

## Modules

Import only what you need via subpath exports:

### Time scales

```ts
import {
  getGpsTime,
  getTimeOfWeek,
  getWeekNumber,
  getDateFromGpsData,
} from 'gnss-js/time';
import { getGalTime, getBdsTime, getUnixTime } from 'gnss-js/time';
import { getJulianDate, getMJD } from 'gnss-js/time';
import { getLeap, getGpsLeap, getUtcDate } from 'gnss-js/time';

const date = new Date('2024-01-15T12:00:00Z');
const gpsTime = getGpsTime(date); // milliseconds since GPS epoch
const tow = getTimeOfWeek(date); // milliseconds into current GPS week
const week = getWeekNumber(date); // GPS week number
```

### Coordinates

```ts
import {
  geodeticToEcef,
  ecefToGeodetic,
  vincenty,
  deg2rad,
} from 'gnss-js/coordinates';

const [x, y, z] = geodeticToEcef(deg2rad(48.8566), deg2rad(2.3522), 35);
const { distance } = vincenty(
  deg2rad(51.5),
  deg2rad(-0.1),
  deg2rad(48.9),
  deg2rad(2.4)
);
// distance in meters, angles in radians
```

### RINEX parsing

```ts
import { parseRinexStream, parseNavFile } from 'gnss-js/rinex';

// Streaming observation parser (works with ReadableStream)
const result = await parseRinexStream(stream, {
  onObservation: (time, prn, codes, values) => {
    // process each epoch
  },
});

// Navigation file parser
const nav = parseNavFile(navFileText);
// nav.ephemerides: KeplerEphemeris[] | GlonassEphemeris[]
```

### RTCM3 decoding

```ts
import { Rtcm3Decoder, decodeMsmFull, decodeEphemeris } from 'gnss-js/rtcm3';

const decoder = new Rtcm3Decoder();
decoder.addData(chunk); // Uint8Array from NTRIP stream
for (const frame of decoder) {
  const msm = decodeMsmFull(frame); // MSM4-7 observations
  const eph = decodeEphemeris(frame); // broadcast ephemeris
}
```

### Orbit computation

```ts
import { computeAllPositions, computeDop } from 'gnss-js/orbit';

const positions = computeAllPositions(ephemerides, times, receiverPosition);
// positions.prns: string[], positions.times: number[], positions.az/el/lat/lon: Float64Array
```

### Signal analysis

```ts
import {
  MultipathAccumulator,
  CycleSlipAccumulator,
  CompletenessAccumulator,
} from 'gnss-js/analysis';

const mp = new MultipathAccumulator(header);
const cs = new CycleSlipAccumulator(header);
await parseRinexStream(stream, {
  onObservation: (time, prn, codes, values) => {
    mp.onObservation(time, prn, codes, values);
    cs.onObservation(time, prn, codes, values);
  },
});
const multipathResult = mp.finalize();
const cycleSlipResult = cs.finalize();
```

### NTRIP client

```ts
import { fetchSourcetable, connectToMountpoint } from 'gnss-js/ntrip';

const table = await fetchSourcetable('https://proxy.example.com', {
  host: 'caster.example.com',
  port: 2101,
  version: '2.0',
});

const { reader, abort } = await connectToMountpoint(
  'https://proxy.example.com',
  {
    host: 'caster.example.com',
    port: 2101,
    mountpoint: 'MOUNT',
    username: 'user',
    password: 'pass',
    version: '2.0',
  }
);
```

### Constants

```ts
import {
  C_LIGHT,
  FREQ,
  SYSTEM_NAMES,
  DUAL_FREQ_PAIRS,
} from 'gnss-js/constants';

FREQ['G']['1']; // 1575.42e6 Hz (GPS L1)
SYSTEM_NAMES['E']; // "Galileo"
```

## Unit conventions

All functions use consistent units:

| Quantity    | Unit             |
| ----------- | ---------------- |
| Time values | **milliseconds** |
| Angles      | **radians**      |
| Distances   | **meters**       |
| Frequencies | **Hz**           |

Every exported function has JSDoc with `@param` and `@returns` annotations including explicit units.

## Roadmap

- **Class-based API** — Ergonomic wrappers like `GnssTime.fromUtc(date).gps` and `Position.fromGeodetic(lat, lon, h).utm` on top of the existing functional core
- **RINEX observation writers** (RINEX 2/3/4 with gzip compression)

## License

This project is dual-licensed:

- **AGPL-3.0** — Free for open-source projects. Any software that uses gnss-js must also be open-sourced under a compatible license.
- **Commercial license** — For proprietary/closed-source use. Contact [work@miguel.es](mailto:work@miguel.es) for terms.
