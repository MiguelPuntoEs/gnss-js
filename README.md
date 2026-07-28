# gnss-js

A comprehensive, dependency-free GNSS toolkit for JavaScript and TypeScript — from raw receiver bytes to a positioning solution, and everything between. Runs in Node.js, browsers, Deno, Bun, and Workers.

It decodes the formats a GNSS workflow actually meets in the wild (RINEX, RTCM 2/3, and the Septentrio/u-blox/NovAtel/Trimble/BINEX binary logs), reconstructs broadcast navigation down to the raw subframe, and solves positions from single-point all the way to PPP with integer ambiguity resolution — with consistent units and explicit JSDoc throughout.

## Install

```bash
npm install gnss-js
```

Everything is exposed through subpath exports (`gnss-js/rinex`, `gnss-js/positioning`, …), so bundlers only pull in what you import.

## What's inside

- **Formats in** — RINEX 2/3/4 obs + nav (plain, Hatanaka `.crx`, `.gz`), SP3, RINEX CLK, IONEX, SINEX bias; RTCM3 (MSM + legacy obs, ephemeris, SSR/IGS-SSR, station); RTCM 2.x; and the receiver binaries SBF, UBX, NovAtel OEM4, Trimble, BINEX.
- **Formats out** — RINEX 2/3/4 observation + navigation writers and Hatanaka (CRINEX) compression.
- **Navigation** — Keplerian/GLONASS ephemeris handling plus raw-frame decoding of GPS LNAV/CNAV, Galileo I/NAV + F/NAV, BeiDou D1/D2, GLONASS strings, and Galileo HAS (E6 C/NAV) corrections.
- **Orbits** — satellite position/velocity, Doppler, DOP, azimuth/elevation, pass prediction and almanac propagation.
- **Positioning** — SPP, static and kinematic float PPP, PPP-AR (LAMBDA + wide-/narrow-lane FCB estimation), post-processed RTK, DGNSS, and SBAS/DFMC augmentation.
- **Quality** — multipath, cycle slips, completeness and slant-TEC ionosphere analysis, with SINEX-DCB calibration.
- **Live** — NTRIP client and a self-detecting RTCM/receiver stream stats accumulator.
- **Foundations** — GNSS time scales, ECEF/geodetic coordinates, 14-parameter reference-frame transforms, signal/frequency definitions and physical constants.

## Usage

### Time, coordinates & reference frames

```ts
import { getGpsTime, getTimeOfWeek, getWeekNumber } from 'gnss-js/time';
import {
  geodeticToEcef,
  ecefToGeodetic,
  vincenty,
  deg2rad,
} from 'gnss-js/coordinates';
import { transformFrame } from 'gnss-js/frames';

const gpsTime = getGpsTime(new Date()); // ms since GPS epoch
const [x, y, z] = geodeticToEcef(deg2rad(48.8566), deg2rad(2.3522), 35);

// Time-dependent 14-parameter Helmert (IERS/EPSG): ITRF88–ITRF2020,
// ETRF2000/2014/2020, NAD83(2011). 'WGS84' aliases ITRF2020.
const itrf = transformFrame(
  [3924687.7, 301132.8, 5001910.8],
  'ETRF2000',
  'ITRF2020',
  2010.5
);
```

### RINEX — read, write & products

```ts
import {
  parseRinexStream,
  parseNavFile,
  parseSp3,
  parseClk,
  parseIonex,
  writeRinexObsBlob,
  writeRinexNav,
  writeCrx,
} from 'gnss-js/rinex';

// Streaming observation parser — plain, Hatanaka .crx, or .gz
const { header } = await parseRinexStream(
  file,
  (pct) => {}, // optional progress
  undefined, // optional AbortSignal
  (time, prn, codes, values) => {
    /* per-satellite obs callback */
  }
);

const nav = parseNavFile(navText); // KeplerEphemeris[] | GlonassEphemeris[]
const sp3 = parseSp3(sp3Text); // precise orbits
const clk = parseClk(clkText); // precise clocks

// Writers: RINEX 2/3/4 obs + nav, and Hatanaka compression
const rnx = writeRinexObsBlob(header, epochs);
const crx = writeCrx(rnx); // → CRINEX
```

### Receiver binary formats

One decoder per receiver family; each returns measurement epochs, and a companion nav parser reconstructs broadcast ephemeris from the raw frames.

```ts
import { parseSbfMeas, parseSbfNav, parseSbfHas } from 'gnss-js/sbf'; // Septentrio
import { parseUbxRawx, parseUbxRawNav } from 'gnss-js/ubx'; // u-blox
import { parseNovatelRange, parseNovatelNav } from 'gnss-js/novatel'; // NovAtel OEM4
import { parseTrimble, parseTrimbleNav } from 'gnss-js/trimble'; // Trimble
import { parseBinex } from 'gnss-js/binex'; // BINEX

const sbf = parseSbfMeas(bytes); // measurement epochs + counts
const nav = parseSbfNav(bytes); // GPS/GAL/BDS/GLO ephemeris from raw blocks
const has = parseSbfHas(bytes); // Galileo HAS (E6 C/NAV) SSR corrections
```

### RTCM (RTCM3, RTCM2, SSR)

```ts
import {
  Rtcm3Decoder,
  decodeObs,
  decodeEphemeris,
  decodeSsr,
  decodeIgsSsr,
  updateStreamStats,
  createStreamStats,
} from 'gnss-js/rtcm3';

const decoder = new Rtcm3Decoder();
decoder.addData(chunk); // Uint8Array from an NTRIP stream
for (const frame of decoder) {
  const obs = decodeObs(frame); // ObsEpoch | null — MSM4-7 or legacy 1001-1012
  const eph = decodeEphemeris(frame); // broadcast ephemeris (all constellations)
  const ssr = decodeSsr(frame); // orbit/clock/bias corrections (1057-1068)
  const igs = decodeIgsSsr(frame); // IGS-SSR 4076 (multi-GNSS + phase bias + iono)
}
```

```ts
import { Rtcm2Decoder, rtcm2Observation, rtcm2Station } from 'gnss-js/rtcm2';

// Legacy RTCM 2.x — a wholly different wire format (30-bit words, 6-of-8)
const frames = new Rtcm2Decoder().decode(bytes);
```

### Orbits, visibility & Doppler

```ts
import {
  computeAllPositions,
  computeVisibility,
  computeDop,
  dopplerHz,
} from 'gnss-js/orbit';

const positions = computeAllPositions(ephemerides, times, rxEcef);
const vis = computeVisibility(ephemerides, rxEcef, startMs, endMs, 300, 10);
// vis.passes: rise/peak/set; vis.pdop / vis.visibleCount per epoch;
// vis.elevation[prn]: elevation timeline for plotting.
```

### Positioning — SPP → PPP → PPP-AR / RTK

```ts
import {
  solveSpp,
  ionoFree, // single-point
  solvePpp, // static/kinematic float PPP + optional AR
  postProcessRtk, // rnx2rtkp-style relative positioning
  solveDgnss, // code-differential
  SbasProcessor, // SBAS / DFMC augmentation
} from 'gnss-js/positioning';

// Single-point: ~10 m single-frequency; ionoFree(p1,p2,f1,f2) for metre-level.
const spp = solveSpp(pseudoranges, ephemerides, epochMs);

// Precise point positioning against SP3/CLK products (dm→cm; AR to cm).
const ppp = solvePpp(pppEpochs, sp3, pppOptions);

// Post-processed RTK: base + rover obs, ephemeris, base ECEF → fixed track.
const rtk = postProcessRtk(baseObs, roverObs, ephemerides, baseEcef);
```

### Signal quality & ionosphere

```ts
import {
  analyzeQuality,
  parseSinexBiasDcb,
  applyIonoDcb,
} from 'gnss-js/analysis';

// One re-parse pass: multipath (per band, Anubis-style), cycle slips,
// completeness, and slant-TEC series.
const q = await analyzeQuality(file, header);

// Calibrate STEC with satellite DCBs (ESA .BIA / CAS .BSX); receiver bias
// from the night-time floor.
const { result, receiverDcbTecu } = applyIonoDcb(
  q.iono,
  parseSinexBiasDcb(biasText, epochMs)
);
```

The individual accumulators (`MultipathAccumulator`, `CycleSlipAccumulator`, `CompletenessAccumulator`, `IonoAccumulator`) are exported too, for a custom `parseRinexStream` pass.

### NTRIP, NMEA & ANTEX

```ts
import { fetchSourcetable, connectToMountpoint } from 'gnss-js/ntrip';
import { parseNmeaFile, computeStats } from 'gnss-js/nmea';
import { parseAntex } from 'gnss-js/antex';

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

const track = parseNmeaFile(nmeaText); // fixes, satellites, per-sentence records
const antex = parseAntex(antexText); // antenna PCO/PCV calibrations
```

### Constants & signals

```ts
import { C_LIGHT, FREQ, SYSTEM_NAMES } from 'gnss-js/constants';
import { CONSTELLATIONS, computePsdDb } from 'gnss-js/signals';

FREQ['G']['1']; // 1575.42e6 Hz (GPS L1)
SYSTEM_NAMES['E']; // "Galileo"
```

## Unit conventions

All functions use consistent units, with explicit `@param`/`@returns` JSDoc:

| Quantity    | Unit             |
| ----------- | ---------------- |
| Time values | **milliseconds** |
| Angles      | **radians**      |
| Distances   | **meters**       |
| Frequencies | **Hz**           |

## Roadmap

- **Class-based API** — ergonomic wrappers (`GnssTime.fromUtc(date).gps`, `Position.fromGeodetic(...).utm`) over the functional core.
- **RTCM3 MSM1–3** and NavIC 1041 ephemeris decoding.
- **Real-time SSR/HAS application** — feeding decoded corrections into a live PPP solve.

## Development

```bash
pnpm install
bash scripts/fetch-test-data.sh   # RINEX test fixtures (~5 MB, checksummed; gitignored)
pnpm test
pnpm run lint
pnpm run build
```

Without the fixtures, the data-backed suites skip silently (`describe.skipIf`), so run the fetch script before trusting a green run.

**Releasing**: bump the version and push the tag — CI publishes to npm via Trusted Publishing and creates the GitHub Release:

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

- **AGPL-3.0** — free for open-source projects. Any software that uses gnss-js must also be open-sourced under a compatible license.
- **Commercial license** — for proprietary/closed-source use. Contact [work@miguel.es](mailto:work@miguel.es) for terms.
