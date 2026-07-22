# Changelog

## 1.12.0

### New features

- **SP3-c/-d parser** — `parseSp3(text)` in `gnss-js/rinex` reads precise orbit/clock files (positions in meters, clocks in seconds, gaps and bad-clock sentinels as null), and `sp3Position(sp3, prn, tMs)` evaluates arbitrary epochs by 9-point Lagrange interpolation (exact at nodes, no interpolation across gaps). Tested against a real ESA MGEX final product.
- **RINEX observation writers** — `writeRinexObsBlob` (3.04), `writeRinex4ObsBlob` (4.01) and `writeRinex2ObsBlob` (2.11) moved here from the gnsscalc app, along with the `CompactEpoch` storage type and the streaming gzip sink. Output is characterization-tested byte-identical to the app's writers.

## 1.11.0

### New features

- **Klobuchar broadcast ionosphere model** — `klobucharDelay(coeffs, lat, lon, az, el, tow)` in `gnss-js/positioning` evaluates the IS-GPS-200 slant delay from the nav-header GPSA/GPSB coefficients (verified against an independent spec transcription over a broad input grid).
- **SPP ionospheric correction** — new `SppOptions.iono` applies the Klobuchar delay to every single-frequency pseudorange, scaled to each system's primary frequency. On a real 24 h single-frequency dataset (BRUX) this cut the 3D RMS vs the reference position from 6.1 m to 2.4 m, removing most of the Up bias.
- **Satellite velocity** — `SatPosition` now carries `vx`/`vy`/`vz` (ECEF m/s): analytic for Keplerian systems, from the RK4 state for GLONASS, numeric-differenced for the BDS-GEO rotated frame (all validated against finite differences of position).
- **`rangeRate(sat, rx, rxVel?)` and `dopplerHz(rangeRate, freq)`** — predicted geometric range rate and carrier Doppler.

## 1.10.0

### New features

- `VisibilityResult` gains **`visibleBySystem`** — per-constellation visible counts per epoch, honoring the (possibly azimuth-dependent) elevation mask.

## 1.9.0

### New features

- **IONEX parser** — `parseIonex(text)` in `gnss-js/rinex` reads IGS global ionosphere maps (tested against a real ESA0OPSRAP GIM): epochs, lat/lon grid, TEC maps in TECU with NaN for missing cells.
- **Azimuth-dependent elevation mask** — `computeVisibility`'s mask accepts a per-azimuth array (uniform 0–360° sectors, linearly interpolated) describing a local horizon/obstruction profile; `maskRadForAzimuth` exported.
- `VisibilityResult` gains **`subLat`/`subLon`** sub-satellite series for ground-track views.

## 1.8.0

### New features

- `VisibilityResult` gains per-PRN **`azimuth`** series (radians, same shape as `elevation`) — enables sky plots of a planned window.

## 1.7.0

### New features

- `computeVisibility` now reports **all four DOPs per epoch** (`gdop`, `hdop`, `vdop` join `pdop` on `VisibilityResult`) — they were computed and discarded.

## 1.6.1

### Fixed

- **GLONASS integrator: the J2 term was missing its GM factor**, reducing the oblateness correction to effectively zero — positions drifted ~25 m by the ±15 min edges of each ephemeris interval (½·a_J2·t²), which showed up as a very regular 30-minute sawtooth of several metres in single-frequency SPP height. Validated against ESA precise orbits: GLONASS broadcast error is now a flat ~2–3 m at every ephemeris age (was 2 m at tb growing to ~23 m at ±15 min). The precise-orbit regression test's GLONASS band is tightened from 500 m — loose enough to hide exactly this — to 30 m. Exposed by the gnsscalc ΔENU plot.

## 1.6.0

### New features

- **Time-differenced ionosphere (rate of TEC)** — `computeIonoRate(result, intervalSec?, order?)`: sequential ΔSTEC/Δt in TECU/min with all biases cancelled; a standardized baseline (e.g. 60 s, all pairs) gives a sample-rate-independent picture; `order: 2` returns the second undivided difference (gradients removed, scintillation/noise amplified). Differences never cross arc boundaries, so cycle slips do not pollute the series. `detrendIonoArcs(result)` removes the per-arc bias by anchoring each arc at its first observation, showing pure TEC variation. `IonoSeries` gains `arcStarts`. Suggested by Hans van der Marel.

## 1.5.1

### Fixed

- **`ephInfoToEphemeris` built `tocDate` from unresolved week numbers** — GPS/QZSS RTCM messages broadcast a 10-bit week (mod 1024, resolved against reception time now) and Galileo a 12-bit GST week (epoch = GPS week 1024); a live GPS ephemeris previously got a `tocDate` in 1987 and Galileo landed 1024 weeks in the past, making `selectEphemeris` silently reject every satellite fed from the RTCM bridge.
- `parseSinexBiasDcb`: an open-ended _start_ epoch (`0000:000:00000`) resolved to +Infinity and could never cover an observation; `maxStec` reported 0 when every sample was negative (routine for uncorrected night-heavy data).
- SSR (1057–1068) and network-RTK (1015–1017, 1030/1031) message types now carry their constellation tag.

### Improvements

- README: the `parseRinexStream` example showed a non-existent options-object API; corrected to the real positional signature. Added Ionosphere/DCB and NMEA/ANTEX sections; `analyzeQuality` documented as the one-pass QC driver; fixed the stale `computeAllPositions` return-shape comment.
- Shared `median`/`percentile`/`MIN_ARC_LENGTH` (were duplicated across analysis modules); `selectEphemeris` delegates to the same validity-window logic as internal selection.
- package.json: SPDX dual-licensing expression, canonical repository URL.

## 1.5.0

### New features

- **Satellite DCB products for the ionosphere module.** `parseSinexBiasDcb(text, epochMs?)` reads satellite DSB entries from SINEX_BIAS files (ESA .BIA, CAS/GFZ .BSX), selecting the validity window covering the given epoch (long-history files carry several windows per satellite, differing by ~10 ns across SVN swaps). `applyIonoDcb(result, satDcb)` subtracts the product satellite biases and estimates the receiver bias per system/pair from the night-time floor (1st percentile → 0 — Hans van der Marel's no-negative-values criterion), yielding calibrated slant TEC. `IonoSeries` gains `codes` (the observation pair, the product-matching key) and `tecuPerNs`. Sign conventions pinned by a synthetic ground-truth test and validated against a real ESA0OPSFIN_DCB.BIA product.

## 1.4.1

### Fixed

- **Multipath is now computed per code band, matching Anubis/TEQC** (reported by Hans van der Marel). Each dual-frequency pair previously produced MP on its _primary_ band only, so "MP L1-L5" was the L1 code re-referenced to the L5 phase — not L5 code multipath. Pairs now also yield the swapped combination: GPS (1,2)+(1,5) produce MP1, MP2 and MP5, where MP5 is the L5 code with L5/L1 phases. On ABMF, GPS MP5 = 0.24 m < MP1 = 0.29 m, the physically expected ordering for the modern L5 code.

## 1.4.0

### New features

- **`gnss-js/analysis` ionosphere module** — `IonoAccumulator` computes per-satellite slant TEC from dual-frequency observations: geometry-free phase levelled to the geometry-free code per continuous arc (median levelling for robustness against code multipath), with arcs split on time gaps, external cycle-slip notifications, and intra-arc geometry-free jumps. Output in TECU; receiver/satellite DCBs are not removed (documented — series are DCB-biased but shape-faithful). Wired into `analyzeQuality` alongside multipath/completeness/slips in the same single pass. Suggested by Hans van der Marel.

## 1.3.2

### Fixed

- **Multipath (MP) statistics were inflated ~10× over Anubis/TEQC-class daily values** (reported by Hans van der Marel, TU Delft). The Estey–Meertens combination itself was correct, but a minority of pathological arcs — cycle-slip steps that escaped the external detector, plus reacquisition spikes — dominated the RMS: the median GPS MP1 arc was a healthy 0.59 m while the aggregate read 4.3 m. Arcs now split at intra-arc MP steps > 1.25 m and are cleaned with iterative 3σ editing before debiasing. On the ABMF fixture: GPS MP1 4.33 → 0.29 m, Galileo E1 → 0.23 m, GLONASS G1 → 0.40 m, BeiDou B1I → 0.36 m — in line with Anubis, with only ~6 % of samples edited out.
- The per-signal `satellites` statistic counted arcs, not distinct satellites.

### Improvements

- RTCM message names for 1041 (NavIC ephemeris) and 1230 (GLONASS code-phase biases), previously shown as unknown; constellation mapping included.

## 1.3.1

### Fixed

- **Live GLONASS satellite positions from RTCM 1020 were garbage.** The RTCM→orbit bridge (`ephInfoToEphemeris`, behind `computeLiveSkyPositions` / the NTRIP sky plot) scaled `tb` as a raw 15-minute index although the decoder already stores it in minutes — putting the clock epoch up to two weeks in the future — and resolved the `tb` day boundary on the UTC calendar instead of the Moscow calendar, adding a further 24 h error between 21:00 and 24:00 UTC daily. GLONASS satellites now appear correctly on the live sky plot. The bridge is now exported and covered by tests, including the Moscow-midnight boundary case.
- **SPP now applies the broadcast group delay** (GPS TGD, Galileo BGD E5a/E1, BeiDou TGD1) by default — the largest modelled-effect gap after the ionosphere for single-frequency (C1C/E1/B1I) processing. Disable with `solveSpp(..., { tgd: false })` when feeding iono-free combinations, whose reference the broadcast clock already matches.
- **SPP satellite positions are now computed at the clock-corrected transmission time** (`t_tx − dt_sv`); large satellite clock offsets previously leaked up to metres of along-track satellite motion into the range model.
- `selectEphemeris` now applies the same 30-minute GLONASS validity window as the rest of the orbit module (was 4 h — long enough for the RK4 integration to drift substantially).

### Improvements

- `frames` and `positioning` are now re-exported from the package root (`import { transformFrame, solveSpp } from 'gnss-js'`); previously they were reachable only via subpath imports.

## 1.3.0

### New features

- **`computeVisibility(ephemerides, rxPos, startMs, endMs, stepSec, maskDeg)`** in `gnss-js/orbit` — satellite visibility and DOP prediction over a time window for a fixed location: per-satellite elevation timelines, visible-count and PDOP per epoch, and discrete rise/peak/set passes. Foundation for session planning.

## 1.2.0

### Fixed

- **GLONASS/SBAS satellite positions from RINEX navigation files** were wrong by tens of km. `computeSatPosition` passed GPS-scale time to the GLONASS integrator, which expects the UTC axis (an 18 s / ~63 km error); `computeLiveSkyPositions` had the mirror-image bug. Validated against ESA MGEX precise orbits (now < 500 m broadcast-vs-precise, was ~63 km).
- **GLONASS/SBAS satellite clock sign** in SPP was inverted (`−tauN` instead of `+tauN`); both parse paths already store the −τ_n bias term, so GLONASS satellites were tens of km out of the range solution and silently rejected. They now contribute.

### New modules

- **`gnss-js/positioning`** — single-point positioning: `solveSpp(pseudoranges, ephemerides, timeMs)` performs weighted iterative least squares with per-constellation receiver clocks, broadcast satellite clock + relativistic correction, Sagnac correction, elevation mask/weighting, a simple troposphere model, and sequential worst-residual outlier rejection. `ionoFree()` builds the dual-frequency combination. Validated against the ABMF IGS station: 9.6 m single-frequency, < 10 m iono-free GPS.
- **`gnss-js/frames`** — time-dependent 14-parameter Helmert transformations between terrestrial reference frames: ITRF88–ITRF2020 (IERS/IGN parameters), ETRF2000/ETRF2014/ETRF2020 (EPSG 8405/8366/10572), and NAD83(2011) (EPSG 8970, Coordinate-Frame convention normalized to Position Vector). `transformFrame(xyz, from, to, epoch)` routes through the frame graph; `WGS84` is an ITRF2020 alias. Validated against EPSG's dual-epoch parameter pairs and the physical Eurasia plate-motion direction.

## 1.1.0

### Fixed

- **MSM6/7 lock time** was returned in raw DF407 milliseconds instead of seconds (1000× too large).
- **BDS time convention unified** (BDT = GPS − 14 s, matching `START_BDS_TIME` and RTKLIB): satellite positions now evaluate BDS ephemerides at BDT seconds-of-week (was GPS sow — a 14 s along-track bias, tens of km of satellite position), BDS `tocDate` sits on the GPS-scale axis, and `msmEpochToDate` BDS timestamps shift +10 s to the correct UTC.

### Improvements

- Single `BitReader` shared by all RTCM3 decoders (msm.ts had a private near-duplicate).
- Single source of truth for carrier frequencies (`constants/gnss.ts` `FREQ`); the MSM signal tables and the MHz spectrum constants are derived from it. `FREQ.R` gains bands `4`/`6` (GLONASS CDMA L1OC/L2OC).
- `setRtcm3DebugHandler()` — observe decode errors that are otherwise silently mapped to null results.
- Physically impossible Keplerian ephemerides (e ≥ 1, sqrtA outside 3000–9000 √m, toe outside the week) are rejected before orbit computation.
- `setGloFreqNumber()` + automatic wiring from decoded 1020 ephemerides: GLONASS MSM4/6 streams (no DF419) now resolve FDMA wavelengths and emit carrier phase.
- GPS epoch / week-length constants unified with `constants/time.ts`.
- `setGloFreqNumber` rejects frequency numbers outside −7…+13 so a garbage 1020 cannot poison the wavelength cache.
- `gloFreq`/`getFreq` now resolve the GLONASS CDMA bands 3/4/6 without needing a channel map.
- `fetch-test-data.sh` fails loudly on missing fixtures — CI/publish can no longer pass with nav suites silently skipped.

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
