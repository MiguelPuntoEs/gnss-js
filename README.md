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

### Visibility / pass prediction

```ts
import { computeVisibility } from 'gnss-js/orbit';

const vis = computeVisibility(ephemerides, rxEcef, startMs, endMs, 300, 10);
// vis.passes: rise/peak/set per satellite; vis.pdop / vis.visibleCount
// per epoch; vis.elevation[prn]: elevation timeline for plotting.
```

### Single-point positioning

```ts
import { solveSpp, ionoFree } from 'gnss-js/positioning';

const sol = solveSpp(pseudoranges, ephemerides, epochMs);
// sol.position (ECEF m), per-system clock biases, DOP, residuals,
// rejected outliers. ~10 m single-frequency; use ionoFree(p1, p2, f1, f2)
// pseudoranges for metre-level.
```

### Reference frame transformations

```ts
import { transformFrame, dateToEpoch } from 'gnss-js/frames';

// ETRS89 (ETRF2000) station coordinates → ITRF2020 at epoch 2010.5
const itrf = transformFrame(
  [3924687.7039, 301132.7618, 5001910.7712],
  'ETRF2000',
  'ITRF2020',
  2010.5
);
// Time-dependent 14-parameter Helmert (IERS/EPSG parameters);
// supports ITRF88–ITRF2020, ETRF2000/2014/2020, NAD83(2011).
// 'WGS84' is treated as an ITRF2020 alias (standard GNSS practice).
```

### RINEX parsing

```ts
import { parseRinexStream, parseNavFile } from 'gnss-js/rinex';

// Streaming observation parser (positional arguments)
const result = await parseRinexStream(
  file, // File (plain, Hatanaka .crx, or .gz)
  (percent) => {}, // optional progress callback
  undefined, // optional AbortSignal
  (time, prn, codes, values) => {
    // per-satellite observation callback
  }
);
// result.header: RinexHeader

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
// positions.prns: string[], positions.times: number[]
// positions.positions[prn][epochIdx]: { lat, lon, az, el } | null
```

### Signal analysis

```ts
import { analyzeQuality } from 'gnss-js/analysis';

// One re-parse pass: multipath (per code band, Anubis-style), cycle
// slips, completeness, and slant-TEC ionosphere series.
const q = await analyzeQuality(file, header);
// q.multipath, q.cycleSlips, q.completeness, q.iono

// The accumulators (MultipathAccumulator, CycleSlipAccumulator,
// CompletenessAccumulator, IonoAccumulator) are also exported for
// wiring into a custom parseRinexStream pass.
```

### Ionosphere and DCBs

```ts
import { parseSinexBiasDcb, applyIonoDcb } from 'gnss-js/analysis';

// q.iono: slant TEC per satellite from the geometry-free phase
// levelled to the code — DCB-biased until calibrated:
const satDcb = parseSinexBiasDcb(sinexBiasText, obsEpochMs); // ESA .BIA / CAS .BSX
const { result, receiverDcbTecu } = applyIonoDcb(q.iono, satDcb);
// result.series[n].points: calibrated STEC (TECU); receiver bias
// estimated from the night-time floor per system/signal pair.
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

### NMEA and ANTEX

```ts
import { parseNmeaFile, computeStats } from 'gnss-js/nmea';
import { parseAntex } from 'gnss-js/antex';

const track = parseNmeaFile(nmeaText); // fixes, satellites, per-sentence records
const stats = computeStats(track.fixes); // position/HDOP/speed statistics
const antex = parseAntex(antexText); // antenna PCO/PCV calibrations
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

## Development

```bash
pnpm install
bash scripts/fetch-test-data.sh   # RINEX test fixtures (~5 MB, checksummed; gitignored)
pnpm test
pnpm run lint
pnpm run build
```

Without the fixtures, the nav-file test suites are skipped silently (`describe.skipIf`), so run the fetch script before trusting a green test run.

**Releasing**: bump the version and push the tag — CI publishes to npm via Trusted Publishing (one-time setup: npm package settings → Trusted Publisher → this repo + publish.yml) and creates the GitHub Release:

```bash
npm version patch   # or minor/major; updates package.json + creates the tag
git push --follow-tags
```

**Developing against [gnsscalc](https://github.com/MiguelPuntoEs/gnsscalc)** without publishing:

```bash
cd ../gnsscalc && pnpm link ../gnss-js   # then `pnpm run build --watch` here
# undo with: pnpm unlink gnss-js && pnpm install
```

## License

This project is dual-licensed:

- **AGPL-3.0** — Free for open-source projects. Any software that uses gnss-js must also be open-sourced under a compatible license.
- **Commercial license** — For proprietary/closed-source use. Contact [work@miguel.es](mailto:work@miguel.es) for terms.
