# Changelog

## 1.0.0

### Breaking changes

- **`getTimeOfWeek()`** now returns milliseconds (was seconds)
- **`getTimeOfDay()`** now returns milliseconds (was seconds)
- **`getDateFromGpsData(weekNumber, timeOfWeek)`** — `timeOfWeek` is now in milliseconds
- **`getDateFromTimeOfDay(timeOfDay, date)`** — `timeOfDay` is now in milliseconds
- **`getDateFromGloN(n4, na, tod)`** — `tod` is now in milliseconds

All time-returning functions now consistently use **milliseconds**, matching `Date.getTime()`, `getGpsTime()`, `getGalTime()`, etc.

### New modules

- **`gnss-js/coordinates`** — ECEF/geodetic conversions, Vincenty/rhumb distance, UTM, Maidenhead, geohash
- **`gnss-js/constants`** — GNSS frequencies, system metadata, GLONASS FDMA, BeiDou constellation, observation indexing
- **`gnss-js/rinex`** — Streaming RINEX 2/3/4 observation parser, navigation file parser, Hatanaka decompression, validation
- **`gnss-js/rtcm3`** — RTCM3 frame decoder, MSM4-7 observation extraction, ephemeris decoding, station metadata
- **`gnss-js/orbit`** — Keplerian and GLONASS orbit computation, azimuth/elevation, DOP calculation
- **`gnss-js/analysis`** — Code multipath (MP1/MP2), cycle-slip detection (MW/GF/SF), observation completeness
- **`gnss-js/ntrip`** — NTRIP 1.0/2.0 sourcetable parsing, stream connection (configurable proxy URL)

### Improvements

- **Subpath exports** — Import only what you need: `import { vincenty } from 'gnss-js/coordinates'`
- **JSDoc on all functions** — Every exported function has `@param` and `@returns` with explicit units
- **Zero dependencies** — Pure TypeScript, works in Node.js, browsers, Deno, Bun, and Workers
- Migrated test runner from Jest to Vitest

## 0.1.2

- Fix BDS time epoch definition
- Add UTC and GPS scales for Julian date functions
- Refactor leap second table

## 0.1.1

- Add TAI and TT scales for Julian dates
- ESM migration

## 0.1.0

- Initial release: GNSS time scale conversions (GPS, Galileo, BeiDou, GLONASS, NTP, TAI, TT, UTC)
- Julian/MJD date conversions
- RINEX time format parsing
- Leap second handling
