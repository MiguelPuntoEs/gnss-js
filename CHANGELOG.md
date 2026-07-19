# Changelog

## Unreleased (1.1.0)

### Fixed

- **MSM6/7 lock time** was returned in raw DF407 milliseconds instead of seconds (1000× too large).

### Improvements

- Single `BitReader` shared by all RTCM3 decoders (msm.ts had a private near-duplicate).
- Single source of truth for carrier frequencies (`constants/gnss.ts` `FREQ`); the MSM signal tables and the MHz spectrum constants are derived from it. `FREQ.R` gains bands `4`/`6` (GLONASS CDMA L1OC/L2OC).
- `setRtcm3DebugHandler()` — observe decode errors that are otherwise silently mapped to null results.
- Physically impossible Keplerian ephemerides (e ≥ 1, sqrtA outside 3000–9000 √m, toe outside the week) are rejected before orbit computation.
- `setGloFreqNumber()` + automatic wiring from decoded 1020 ephemerides: GLONASS MSM4/6 streams (no DF419) now resolve FDMA wavelengths and emit carrier phase.
- GPS epoch / week-length constants unified with `constants/time.ts`.

### Known issues (flagged, not changed)

- The BDS epoch offset differs between `constants/time.ts` (+14 s GPS scale), `rtcm3/msm.ts` (−14 s), and `orbit/index.ts` (no offset) — see `TODO(review)` comments; needs a deliberate convention decision.

## 1.0.1

### Fixed

- **RTCM 1005/1006 station coordinates**: the 38-bit ECEF fields were truncated to 32 bits (`BitReader` built values with 32-bit shift operators), so any |axis| > ~429 496 m decoded as the true value mod 2³². Reported by Hans van der Marel (TU Delft) for DELF00NLD0. Sign handling of negative coordinates via `readSM` had the same bug class.
- **MSM4/6 observations**: the decoder read a phantom 4-bit extended-satellite-info field (DF419 exists only in MSM5/7), shifting all satellite and cell data — MSM4/MSM6 messages decoded to garbage. Verified against RTKLIB `decode_msm4`/`decode_msm6`.
- **MSM6/7 carrier phase**: the fine phase range was scaled by `(1 << 31)`, which is negative in JavaScript — every value had an inverted sign, and the invalid-value sentinel passed the validity check, emitting phony phase observations.

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
