# Changelog

## 1.41.0

### New — Trimble RETSVDATA GLONASS ephemeris (subtype 9)

- `parseTrimbleNav` now decodes GLONASS ephemerides (RETSVDATA subtype 9) — a PZ-90 state vector, not a Keplerian struct. Reverse-engineered from a real DLF100NLD1 capture and validated: |position| = 25,510 km (GLONASS MEO), speed ≈ 3.4 km/s, and the frequency channel numbers come out exactly right (R04 = +6, R12 = −1, R18 = −3, …). The reference time is the block time on the UTC scale (GPS − leap seconds), landing on a clean 15-minute tb boundary; τn carries the RINEX −τn sign and γn is passed through — both cross-checked against the 2026-07-27 BRDC (R21 γn = −3.638e-12, −τn = −3.296e-4). Positions/velocities/accelerations convert metres→km to match the RINEX/SBF GLONASS convention.
- The subtype→constellation map is confirmed by RTKLIB's rt17.c RETSVDATA table (st[9] = GLONASS Eph, st[11] = Galileo Eph, st[21] = BeiDou Eph); RTKLIB only decodes subtypes 1 and 3, so the layouts were established here. Reference capture now yields GPS + GLONASS + BeiDou (Galileo, subtype 11, is next).

## 1.40.0

### New — Trimble RETSVDATA BeiDou ephemeris (subtype 21)

- `parseTrimbleNav` now decodes BeiDou ephemerides (RETSVDATA subtype 21). Established from a real DLF100NLD1 capture that Trimble reuses the **identical 176-byte Keplerian struct** as GPS subtype 1 — decoding subtype 21 at the GPS field offsets yields √a ≈ 5282.6 m^½ (BeiDou MEO), i₀ ≈ 55°. The GPS ephemeris reader is refactored to a shared field decoder; the BeiDou path applies the GPS→BDT time-scale conversion (week − 1356, seconds-of-week − 14) so the record lands on the BDT calendar RINEX uses and matches `parseSbfNav`'s BDSNav output.
- Validated end-to-end: the decoded elements propagate through `keplerPosition` to a BeiDou-MEO orbit (altitude ≈ 21,500 km, |r| ≈ a), the toe/toc land on clean BDT broadcast boundaries (GPST − 14 s), and BDT weeks are correct (≈ 1073 for 2026). On the reference capture: 14 BeiDou + 12 GPS ephemerides.

  Health is taken from the same flags nibble as GPS (0 = healthy for the observed operational satellites); the constellation's set-on-all flags bit 0 is deliberately not used. Still not decoded: the GLONASS/Galileo/QZSS ephemeris and almanac subtypes (RETSVDATA 9/11/13/23/27).

## 1.39.0

### Fixed — Trimble RETSVDATA GPS ephemeris + ION/UTC (off-by-two length gates)

- `parseTrimbleNav` never decoded a real GPS ephemeris: the subtype-1 (GPS ephemeris) gate required `f.len >= 178`, but real RETSVDATA GPS records are **176** data bytes, so every one was silently dropped — the path had only ever been exercised by a 180-byte synthetic record. Likewise the ION/UTC (subtype-3) gate required `>= 125` while real records are **123** bytes. Both gates are corrected to the length the decoder actually reads (176 / 102). The field layout itself was always right.
- Validated against a real DLF100NLD1 Trimble capture: 12 GPS ephemerides decode to physical Keplerian elements (√a ≈ 5153.6 m^½, e < 0.03, i₀ ≈ 55°, week 2429), and the ION/UTC record yields the Klobuchar coefficients + leap seconds (18).

  Still not decoded: the GLONASS/Galileo/BeiDou/QZSS RETSVDATA subtypes (9/11/13/21/23/27 on this stream) — the multi-GNSS Trimble nav gap.

## 1.38.0

### New — SBF ReceiverSetup (5902): station identity + reference position

- Added `parseSbfReceiverSetup` — decodes the Septentrio ReceiverSetup (5902) block into the station's marker (name/number/type/code), receiver (name, serial, firmware, product), antenna (type, serial, ΔH/E/N offsets) and reference position (latitude/longitude in radians, ellipsoidal height, plus the ECEF `position` for convenience). It's the block a RINEX header's marker/receiver/antenna and APPROX POSITION lines come from — and gives a receiver-format stream the station metadata + approximate position that RTCM gets from message types 1005/1006/1033.
- Length-tolerant across block revisions: the trailing rev-1…4 fields (MarkerType, GNSSFWVersion, ProductName, the reference position, StationCode) are read only when the block length covers them.
- Validated against a real DLF500NLD1 block: marker `DLF500NLD`, receiver `SSRC7`/PolaRx5 fw `2025.08.4`, antenna `LEIAR25.R3 … LEIT`, position 51.986°N 4.387°E 75.8 m (TU Delft).

## 1.37.0

### New — GPS/QZSS LNAV from raw SBF blocks + one-pass `decodeSbfNavigation`

- Added the missing **GPS/QZSS LNAV decoder** for raw SBF blocks: `parseSbfGpsNav` assembles GPSRawCA (4017) / QZSRawL1CA (4066) subframes 1–3 into Keplerian ephemerides. A Septentrio configured for raw output (e.g. TU Delft's DLF500) broadcasts GPS ephemeris _only_ as GPSRawCA — `parseSbfNav` reads the decoded GPSNav block (absent in such a stream), so GPS previously came through solely via L2C/L5 CNAV. Validated against DLF500: 416 GPSRawCA → 13 GPS ephemerides, with physical `sqrtA`/`e`/`i0` and a PRN set that is a superset of the L2C/L5 CNAV satellites.
- The GPS/QZSS LNAV subframe-1/2/3 accumulator is now a shared `GpsLnavAssembler` in `navbits` (returning a discriminated `LnavPush` so each caller keeps exact bad-frame accounting); `parseUbxNav` uses it instead of its own inline copy, so u-blox and Septentrio share one implementation.
- Added **`decodeSbfNavigation(data)`** — a single-pass navigation decoder that walks the SBF stream **once** and routes every navigation block (decoded GPS/GAL/GLO/BDS/QZS, raw GPS-LNAV, GPS CNAV, Galileo I/NAV + F/NAV, GLONASS strings, BeiDou D1/D2, and the Klobuchar/NeQuick iono + GPS-UTC leap-second blocks) through one dispatch to shared per-block `feed*` helpers, merging and de-duplicating by `(prn, toc, Galileo I/NAV-vs-F/NAV source)`. It replaces the 6–8 separate full-stream rescans a consumer previously did by calling each `parseSbf*` in turn, and returns per-source block counts for coverage diagnostics. On DLF500 it yields 61 ephemerides (G13/E24/R11/C13) + 21 CNAV in one pass.

  **Remaining raw decoders** (need the signal ICDs / BDS-3 layouts, not the SBF reference alone): BDS-3 CNAV1/2/3 (B1C/B2a/B2b), SBAS (GEORawL1/L5), NavIC. Their decoded-block counterparts (GPSCNav, BDSCNav1/2/3, NavICLNav) are also not yet read.

## 1.36.0

### New — ambiguity-fixed position (`fixPppPosition`): the float→fixed loop closed

- `solvePpp` gained `exposeState` — when set, the solution carries `finalState` (float position + active-ambiguity floats + the full EKF covariance), the material needed to condition a fixed position.
- Added `fixPppPosition` — takes that state plus the satellite FCBs (from `estimateNetworkFcbs`), resolves the integers (`resolvePppAmbiguities`, LAMBDA on between-satellite single differences), and **conditions the float position on the fixed ambiguities**: `x_fixed = x_float − Q_xz·Q_zz⁻¹·(z_float − ẑ)` via a Cholesky solve, with the reference satellite (and the receiver clock it absorbs) left free. Returns the fixed position, the fixed−float shift, and the ratio. This closes the loop from float PPP to an ambiguity-**fixed** coordinate — previously the resolver was validated only in isolation and never driven from a real solve.
- The conditioning arithmetic is covered by synthetic tests (zero shift when floats already sit on integers; a bounded position pull when offset; float returned unchanged when the ratio test fails).

  **Honest scope:** `fixPppPosition` fixes the ambiguities **active at the final epoch**. Most instantaneously-tracked arcs are not fully converged, so few pass the ratio test and the fixed−float shift is sub-centimetre (the float is already close). A large demonstrated centimetre gain needs session-cumulative (per-arc) ambiguity fixing rather than a single-epoch snapshot, and a trustworthy centimetre ground truth to measure against — both still open. The mechanism and its maths are now in place and validated; the coverage and the final cm _proof_ are the remaining work.

## 1.35.0

### New — multi-GNSS PPP-AR network calibration (`estimateNetworkFcbs`)

- Added `estimateNetworkFcbs` — one call that calibrates the full wide-lane + narrow-lane satellite FCBs for PPP-AR from a set of `solvePpp` arcs, **per constellation** (the receiver biases are system-specific, so GPS/Galileo/BeiDou must not share a datum). Returns merged per-satellite `satWlFcb`/`satNlFcb` maps — the reusable product a rover applies before resolving only its own receiver bias — plus a per-system fix-rate/residual summary.
- **Multi-GNSS roughly doubles the fixable narrow-lane arcs.** Measured on the 6-station network (2024-001): GPS alone fixes ~26 narrow-lane arcs; adding Galileo brings it to ~48 (Galileo ~76%, GPS ~81%, both ~1.2 cm residual). Constellations do not lengthen individual arcs — each satellite's arc is fragmented independently by slips/scintillation — but they multiply the _count_ of simultaneous fixable arcs, which is the coverage lever when long arcs are scarce. (GLONASS is excluded: its FDMA signals break the between-satellite integer property, so it only yields float arcs.)

## 1.34.0

### New — narrow-lane FCB estimation: self-contained PPP-AR reaches centimetre

- `solvePpp` now returns `arcs: PppArc[]` — the per-arc converged float ionosphere-free ambiguity, arc-averaged wide-lane, frequencies, mean elevation and span for each continuous tracking arc. This is the raw material for ambiguity resolution.
- Added `estimateNarrowlaneFcb` — the centimetre half of PPP-AR. With the wide-lane FCBs already solved (from `estimateWidelaneFcb` on the same network), it fixes each arc's N_WL, recovers the float narrow-lane ambiguity `N1 = A_IF/λ_NL − (f2/(f1−f2))·N_WL`, and decomposes the per-satellite narrow-lane fractional-cycle biases across the network — the same Ge/Gendt method, now on the ~10.7 cm narrow-lane. No external phase-bias product.
- **Validated on the real 6-station MGEX network (2024-001), no external product**: on clean, well-converged (≥1 h) arcs with the full correction model on, the estimated narrow-lane FCBs fix at **~83%** with a **1.2 cm** residual RMS; the fix rate rises with arc length (30 min → 59% / 2.0 cm; 1 h → 83% / 1.2 cm) — the expected PPP-AR behaviour. This is the self-contained path from decimetre float PPP to **centimetre** fixed PPP, with no reliance on an AR-capable analysis centre's bias product.

  Coverage caveat: how many arcs qualify depends on continuous-arc length. Equatorial stations (ionospheric scintillation) and the current cycle-slip/re-initialisation threshold fragment arcs; a clock-robust slip detector (arcs both long _and_ clean) is the next step to widen coverage.

## 1.33.0

### Changed — satellite antenna PCO on by default (rigorous model)

- `createPppCorrections` now defaults `satPco` to **true**. Investigation confirmed the satellite-PCO path is correct (body-frame z toward geocenter, right-handed frame, correct ANTEX selection, correct LOS sign) and **consistent** with the precise products: enabling it slightly _reduces_ the post-fit phase residual on ABMF (34.0 → 32.7 mm) rather than corrupting it. The earlier "it swings the solution" caution was a misread — the metre-scale offset is mostly absorbed by the float ambiguities, and the few-cm position shift is within the reference-coordinate uncertainty, not a modelling error. Pass `satPco: false` to disable. The products' ANTEX must match the one supplied (igs20.atx for the 2024 IGS/MGEX products).

## 1.32.1

### Fixed — honest post-fit phase-residual QC (`phaseResRms`)

- `phaseResRms` is now a **post-fit** residual (each satellite re-evaluated against the epoch's final state) with the **receiver clock projected out** (per-system mean removed), instead of the pre-fit innovation. The pre-fit number was inflated by satellites processed early in the sequential update — before the carrier phase pins the per-epoch clock — which is a filter-ordering artifact, not carrier-phase noise. On ABMF this drops the reported RMS from ~63 mm to ~33 mm; the well-behaved satellites sit at ~5–12 mm (the residual RMS is dominated by a minority of short-arc / just-reinitialised satellites each epoch). No change to the position solution — this is a QC-metric correctness fix.

## 1.32.0

### New — self-contained wide-lane FCB estimation (PPP-AR without a product)

- Added `estimateWidelaneFcb` — network estimation of per-satellite wide-lane fractional-cycle biases from a small set of stations, the Ge/Gendt iterative decomposition (`Ñ_wl = N + b_rcv + b_sat`, circular-mean updates, reference-station datum). This is the route to integer ambiguities that needs **no external phase-bias product**: a single receiver can't separate the satellite bias from the integer, but a network can, because every station shares the same satellite bias. Its output feeds `resolvePppAmbiguities`' `wlBiasCyc`.
- Added `extractWidelaneArcs` — arc-averaged Melbourne–Wübbena wide-lanes from a station's epoch stream, split on cycle-slip/gap.
- **Validated on a real self-built 6-station MGEX network (2024-001), no external bias product**: estimated FCBs make ABMF's wide-lanes snap to integers at **~98% (GPS)**, **~95% (Galileo)**, **~85% (BeiDou)**, with per-constellation residual RMS of 0.09–0.14 cycles. (Biases are estimated per constellation — the receiver wide-lane bias is system-specific.) The wide-lane is the robust half of PPP-AR; the narrow-lane (the centimetre step) is next.

## 1.31.0

### New — PPP-AR building blocks (Bias-SINEX + integer resolver)

- Added a **Bias-SINEX (`.BIA`) parser** (`parseBiasSinex` / `findSatBias` / `biasMetres`) for the code (**DSB**) and observable-specific (**OSB**) biases the IGS analysis centres publish. The satellite _phase_ OSBs are the fractional-cycle biases PPP-AR needs; the code DSBs are also directly useful for SPP/ionosphere DCB corrections. Validated against the real ESA operational bias file.
- Added a **PPP integer ambiguity resolver** (`resolvePppAmbiguities`) implementing the classic decomposition: Melbourne–Wübbena **wide-lane** rounding, then **narrow-lane** resolution with the existing LAMBDA search on **between-satellite single differences** (which cancel the receiver phase bias), gated by the ratio test. Satellite WL/NL fractional-cycle biases are inputs (from a Bias-SINEX OSB). Helpers `wlWavelength` / `nlWavelength` exported.

  The resolver's algorithm is validated on synthetic known-integer data (exact recovery noise-free, robust under sub-decimetre noise, correct decline when the floats sit on half-integers, wide-lane outlier rejection, phase-bias de-biasing). **End-to-end centimetre PPP-AR on real data additionally requires an AR-capable satellite phase-bias product (e.g. CNES/CODE OSB)** wired into the product-fetch path — the ESA products currently used for `/ppp` are float-clock (no phase OSB). This release ships the tested resolution machinery; connecting it to `solvePpp`'s float ambiguities + a phase-bias product is the remaining step.

## 1.30.0

### New feature — 30 s precise clocks for PPP (`parseClk`)

- Added a **RINEX CLOCK (`.CLK`) parser** (`parseClk` / `clkBias`) for high-rate (typically 30 s) precise satellite clock corrections. It keeps only `AS` (satellite) records, infers the sampling interval, and linearly interpolates the clock bias between the bracketing samples (returning `null` across gaps > 4 intervals or outside the span).
- `solvePpp` accepts an optional `clk` (a `ClkFile`): when present, satellite clock offsets come from the 30 s clocks instead of the SP3 5-minute clocks, falling back to SP3 per satellite/epoch not covered.
- On the ABMF validation set the 30 s clocks tighten the **vertical** (≈19 cm → ≈12 cm) while the static-average horizontal is unchanged. This is expected: in static float PPP the per-epoch receiver clock and per-arc float ambiguities already absorb most of the 5-minute interpolation error, so clock rate is not the static-PPP accuracy bottleneck (integer ambiguity resolution is). High-rate clocks matter more for kinematic PPP, convergence, and as groundwork for PPP-AR.

## 1.29.0

### Improved — multi-GNSS PPP (GPS + Galileo)

- `solvePpp` now estimates **one receiver clock per constellation** (absorbing the inter-system bias), so a single call jointly processes GPS **and** Galileo (and any further systems the caller supplies) instead of GPS alone. On the ABMF validation set this roughly doubles the usable satellites (~10 → ~18) for a more robust, better-conditioned float solution. The public API is unchanged — feed mixed-system `PppSatObs` (each with its own `f1/f2` and ANTEX `band1/band2`) and the engine groups them by constellation internally.

## 1.28.0

### New feature — Precise Point Positioning (`solvePpp`)

- **Static float PPP** (`gnss-js/positioning`): absolute cm–dm positioning from a single RINEX observation file plus precise products (SP3 orbit + clock, ANTEX), **no base station**. Dual-frequency ionosphere-free code + carrier phase drive a forward Extended Kalman Filter over `[position, receiver clock, zenith wet troposphere, one float ambiguity per satellite arc]`, with precise satellite orbit + clock, the periodic relativistic clock term, Earth-rotation (Sagnac), Saastamoinen zenith hydrostatic delay + an estimated wet delay mapped by the **Niell mapping function**, **Melbourne–Wübbena** cycle-slip detection (ionosphere-free, so it holds at equatorial stations where a geometry-free test fails), elevation weighting and innovation-based outlier rejection.
- **Optional rigorous corrections** (opt-in via `createPppCorrections`): satellite & receiver antenna PCO/PCV from ANTEX, carrier-phase wind-up, and IERS solid-earth tides, driven by a compact low-precision Sun/Moon ephemeris (`sunEcef`/`moonEcef`/`solidEarthTide`).
- New exports: `solvePpp`, the `Ppp*` types, `niellMapping`, `buildPppAntenna`, `createPppCorrections`, `sunEcef`, `moonEcef`, `solidEarthTide`, `gmst`. Validated on real ABMF (2024-01-01) + ESA MGEX SP3: converges from a 10 m offset to **decimetre-level (centimetre vertical)** with cm–dm post-fit phase residuals — an order of magnitude better than single-point positioning. The residual horizontal at this GPS-only equatorial station is geometry-limited; multi-GNSS + ambiguity resolution are the roadmap to centimetre.

## 1.27.0

### New feature — Hatanaka (Compact RINEX) compression

- **`writeCrx`** (`gnss-js/rinex`): compress a RINEX observation file to Compact RINEX (Hatanaka / CRINEX) — text in, text out, the inverse of the existing `crx.ts` decoder. A faithful TypeScript port of RNXCMP's `rnx2crx` 4.2.0 (Y. Hatanaka / GSI Japan), supporting RINEX 2.x (CRINEX 1.0) and 3.x / 4.0x (CRINEX 3.0), including the RINEX 4.02 pico-second record (CRINEX 3.1). Validated **byte-for-byte** against the `rnx2crx`/`crx2rnx` oracles on real multi-GNSS RINEX 3.03/3.04 files (ABMF, ALBH) and synthetic RINEX 2.11 exercising obs/satellite-list continuation lines, blank fields and the CRINEX-1 present→blank flag-reset edge case; full `crx2rnx` round-trips are identical. This removes the need for a vendored `rnx2crx` C binary to produce Hatanaka downloads (CRINEX is ~2.9× smaller than gzipped RINEX, lossless).

## 1.26.0

### New features — two more receiver formats

- **Trimble RT17/RT27** (`gnss-js/trimble`): `parseTrimble` decodes Trimble RAWDATA **record 27** — the multi-GNSS raw-measurement format streamed by ALLOY/NetR9 receivers (e.g. TU Delft's DLF100NLD1) — into pseudorange / carrier phase / Doppler / C/N0 / cycle-slip across GPS, GLONASS, Galileo, BeiDou and SBAS, with multi-page reassembly; plus `parseTrimbleNav` (GPS ephemeris + ION/UTC). Framing and GPS-eph are ported from RTKLIB `rt17.c`; record 27 — which RTKLIB does **not** implement (it decodes only records 17/29) — was decoded from Trimble's ICD and verified byte-for-byte on a live 60 s DLF100NLD1 capture: 59 epochs, 11,766 observations, carrier phase reconstructs pseudorange to **~1 ppm** on every signal. Deferred: legacy RT17 records 17/29 and non-GPS RETSVDATA ephemeris subtypes.
- **BINEX** (`gnss-js/binex`): `parseBinex` decodes the open UNAVCO/EarthScope binary exchange format — forward records in both byte orders, XOR-8/CRC16/CRC32, `ubnxi` variable-length integers — with record **0x7f-05** multi-GNSS observations and record **0x01** ephemeris (GPS/GLONASS/SBAS/Galileo/BeiDou/QZSS). Ported from RTKLIB `binex.c`, with EarthScope's reference decoder resolving two places RTKLIB is wrong for these files; GPS and GLONASS ephemeris validated **field-for-field against teqc RINEX oracles**. Deferred: reverse-readable records, MD5-checksum (≥1 MB) records, and site-metadata/prototype record types.

Both slot into the same receiver pipeline as SBF/UBX/NovAtel (observation epochs + `Ephemeris`), exported as `gnss-js/trimble` and `gnss-js/binex`.

## 1.25.0

### Improved — single-point positioning accuracy (troposphere + ionosphere)

Two model upgrades to `solveSpp`, both aimed at the height component where a single-frequency solution is weakest. Measured on the ABMF (Guadeloupe) ground-truth oracle, single-frequency multi-GNSS, mid-day:

| iono model          | vertical error |
| ------------------- | -------------- |
| none                | 8.3 m          |
| broadcast Klobuchar | 3.2 m          |
| **GIM**             | **1.1 m**      |

- **Saastamoinen troposphere** replaces the previous fixed 2.47 m zenith delay. Standard-atmosphere hydrostatic + wet terms, station-height- and latitude-dependent, mapped by 1/sin(el) — a port of RTKLIB's `tropmodel` (humidity 0.7), so results stay directly comparable with the rnx2rtkp oracle. Removes the residual vertical bias a constant zenith delay leaves behind.
- **GIM (IONEX) ionosphere** — new `gim` option on `solveSpp` accepts a parsed `IonexGrid` (`parseIonex`) and takes precedence over broadcast `iono`, backfilling from Klobuchar only in a map time gap. Global maps capture ~80–90% of the true ionosphere versus Klobuchar's ~50%, cutting the ABMF vertical error ~3× (3.2 → 1.1 m). New exports: `gimSlantIonoDelayL1`, `gimVerticalTec`, `IONO_L1_M_PER_TECU` (`gnss-js/positioning`). The thin-shell evaluator (pierce point at 450 km, bilinear-in-space / linear-in-time TEC, obliquity mapping, TEC→L1 delay) is validated end-to-end against a real ESA rapid GIM in the SPP oracle.

No API changes to existing calls — `troposphere` default unchanged (on); `iono` still works as before. RTK double-differencing keeps its own differential tropo term (short-baseline self-cancelling).

## 1.24.0

### New features — RTK stage 2: integer ambiguity resolution

- **MLAMBDA** (`gnss-js/positioning`): LtDL decorrelation + shrinking-ellipsoid integer search (RTKLIB lambda.c port, brute-force-verified on classic problems), exposed as `lambdaSearch`/`lambdaReduction`.
- **`RtkFloatEngine` fixes integers**: opt-in `ambiguityResolution: 'instant'` conditions the position on validated integer ambiguities (ratio test, elevation-ordered partial fixing with a half-set floor against cold-start false fixes). Oracle vs RTKLIB rnx2rtkp on the WHU base/rover pair: 99.3% vs 100% fix rate (all misses = first 40 s warm-up), commonly-fixed baselines agree at 2-3 cm, **1.05 cm horizontal RMS vs the surveyed truth, 0 wrong fixes in 1,447 epochs**. Default stays 'off' — stage-1 behavior untouched.

## 1.23.0

### New features — RTK stage 1

- **`solveDgnss` + `RtkFloatEngine`** (`gnss-js/positioning`): double-differenced code DGNSS and a carrier-phase float EKF (per-satellite float DD ambiguities, exact reference-satellite re-mapping, lock-time slip resets; GLONASS FDMA with per-channel wavelengths, IFB absorbed into ambiguities). Oracle vs RTKLIB rnx2rtkp on a public OEM719 base/rover pair (1,457 epochs, GPS+GAL+BDS): float agreement 8.6/8.5/10.4 cm RMS; against the dataset's surveyed ground truth our float lands 3.1/3.9/19.8 cm RMS. Ambiguity resolution (LAMBDA) is stage 2 — the filter maintains the joint float covariance it needs.

### Fixed

- **BDS GEO satellites could be propagated with the wrong frame** — the GEO branch was gated on broadcast inclination < 0.1 rad, but GEO elements are broadcast in the −5°-tilted frame, so real GEO records (i0 ≈ 5–6°) could fall through to the MEO/IGSO math: hundreds of km of satellite error, ~100 m double-difference errors. GEO detection is now PRN-based (C01–C05, C59–C63), matching RTKLIB and the BDS ICD; cross-record consistency 852 km → 0.4 m, verified against an RTKLIB C harness. Affects SPP/visibility/monitoring using BDS GEOs whenever the broadcast i0 exceeded the old threshold.

## 1.22.0

### New features — u-blox drops become four-constellation nav sources

- **`parseUbxRawNav`** (`gnss-js/ubx`): Galileo I/NAV (E1B+E5b), BeiDou D1/D2 and GLONASS strings decoded from RXM-SFRBX through the shared navbits assemblers — the u-blox counterpart of the SBF raw-frame suite. Oracle vs RTKLIB convbin on a full 75-minute ZED-F9P capture: **62/62 Galileo, 17/17 BeiDou, 37/37 GLONASS records**, worst rel err 4.7e-12, zero missed. BeiDou words get a real BCH(15,11,1) parity check (RTKLIB checks none on this path); GLONASS time reference from interleaved RXM-RAWX, never the system clock.

## 1.21.0

### New features — Galileo HAS

- **Galileo High Accuracy Service decoding** — `parseSbfHas` (`gnss-js/sbf`, GALRawCNAV blocks) through a new E6-B C/NAV stack: page CRC-24Q, network-wide message assembly, Reed-Solomon(255,32) erasure recovery (`navbits/rs255`), and full MT1 SSR parsing (satellite/signal masks, orbit RAC + clock corrections, code/phase biases, validity intervals) per the HAS SIS ICD. Validated three ways: 100% page CRC on 10,558 real blocks; **49,630 fields identical to FGI's HASlib reference decoder (0 mismatches)** incl. the RS generator matrix; and physically — applying the corrections heals Galileo broadcast IODNav-switchover discontinuities from 0.115 m to 0.006 m RMS (clock 0.049 → 0.012 m) across 34 switchovers, with the sign-flipped control 2× worse than raw, pinning the ICD convention (X_HAS = X_brdc + R·Δ, opposite of RTCM SSR).

## 1.20.0

### New features — raw-frame navigation completes, almanacs propagate

- **Galileo I/NAV + F/NAV from raw pages** — `parseSbfGalNav` (GALRawINAV/GALRawFNAV): 34/34 records vs RTKLIB convbin at 4e-12; I/NAV-vs-F/NAV clock-set semantics per the OS ICD; raw-vs-receiver-decoded agreement at 2e-15.
- **BeiDou D1/D2 + GLONASS strings from raw frames** — `parseSbfBdsNav`/`parseSbfGloNav` (BDSRaw/GLORawCA): 15/15 + 11/11 vs convbin; own BCH(15,11,1) and Hamming-KX checks (matching the receiver's CRC verdicts on all 7,456 BDS blocks); fixes RTKLIB's inverted BDS week fold near rollovers (documented).
- **NovAtel RAWCNAVFRAME (1066)** — GPS CNAV via the shared assembler; validated by wrapping real oracle-validated L2C messages in synthetic containers.
- **Almanac propagation, all constellations** — `almanacSatPosition` (GPS/GAL/BDS Kepler almanacs, BDS-GEO frame, unfolded multi-day offsets) and `glonassAlmanacPosition` (GLONASS ICD A.3.2 algorithm incl. C20 corrections; the ICD's worked example reproduced to 0.14 m — and a 278 km misprint in the English edition identified). Real-data: PolaRx almanacs propagated 2 days land 1.2-2.6 km (GAL) and ≤6.4 km (GLO, 24/24 slots) from broadcast ephemerides.

## 1.19.0

### New features — RINEX 4 navigation

- **`writeRinexNav4`** — RINEX 4.01 navigation writer: classic records with per-constellation message labels (LNAV/INAV/D1/D2/FDMA/SBAS), `EPH … CNAV` records from `CnavEphemeris` (Table A10 conventions: √A on the wire, toe ≡ toc, t_op/wn_op, blank = unavailable ISCs), and `ION` records (Klobuchar + NeQuick-G) from header iono corrections.
- **`parseNavFile` reads v4 CNAV records** (GPS/QZSS) into a new optional `NavResult.cnav`. Round-trip write→parse is field-identical on IGS hourly files, the DLR daily v4 product (19 349 records) and v3→v4 conversions; text agreement with BKG's own records at 2.5e-13.

### Fixed

- **v3 nav writer flipped the GLONASS clock-bias sign** (wrote −tauN where tauN already holds the RINEX-convention value). Exported GLONASS nav records now carry the correct sign.
- v4 nav parsing skipped ION/EOP records with wrong line counts, silently swallowing the records that followed.

## 1.18.0

### New features — modern navigation, phase 1

- **GPS CNAV decoding (L2C + L5)** — new `navbits` CNAV core (CRC-24Q, message types 10/11/30-37, per-satellite assembly with the toe/toc consistency rule) exposed as `parseSbfCnav` (`gnss-js/sbf`, GPSRawL2C/GPSRawL5 blocks) and `parseUbxCnav` (`gnss-js/ubx`, RXM-SFRBX). Emits the new standalone `CnavEphemeris` type (the classic `Ephemeris` union is untouched). RTKLIB has no CNAV decoder — this is a pure IS-GPS-200 §30 implementation, validated against RINEX 4 CNAV records from IGS hourly nav files: 21/21 records, 672 fields, zero disagreements; L2C and L5 assemble bit-identical sets; CRC-24Q passes 100% on both receivers' raw bits; on a 2020 F9P capture CNAV-propagated positions agree with LNAV to < 6 m.
- **NovAtel GPSEPHEM (7)** — the decoded-fields GPS ephemeris log many captures use instead of RAWEPHEM. No RTKLIB reference exists; validated against same-day IGS BRDC files: 42/42 records field-for-field (worst rel err 3.8e-12), including a parked satellite's stale set matching a three-weeks-earlier file.

### Notes

- `computeSatPosition` does not yet use CNAV's ΔA-dot/Δn0-dot terms (a `CnavEphemeris` consumer must fold them, as the oracle does); CNAV-aware propagation and a RINEX 4 nav writer are the next phase.

## 1.17.0

### New features — receiver logs as complete navigation sources

- **NovAtel Galileo/BeiDou/QZSS ephemerides** — GALEPHEMERIS 1122 and BDSEPHEMERIS 1696 in `parseNovatelNav`, oracle-validated 107/107 records against convbin on a public OEM719 capture (WHU RTK-GNSS, MIT). QZSSEPHEMERIS 1336 ported from the OEM7 manual (no RTKLIB decoder and no public capture exists — synthetic-tested, marked data-untested).
- **Broadcast ionosphere + leap seconds, all three formats** — NovAtel IONUTC 8 (data-tested), SBF `parseSbfIonoUtc` (GPSIon/GALIon/BDSIon/GPSUtc), and u-blox `parseUbxIonoUtc` (GPS LNAV subframe 4 page 18 from RXM-SFRBX). All return the RINEX header `ionoCorrections` shape (GPSA/GPSB/GAL/BDSA/BDSB) + `leapSeconds`. Convergence check: Hans's PolaRx (decoded SBF floats) and a ZED-F9P (raw LNAV bits) yield structurally identical Klobuchar sets; convbin header oracle passes on every capture.

## 1.16.0

### New features

- **u-blox navigation from raw subframes** — `parseUbxNav` (`gnss-js/ubx`): GPS and QZSS broadcast ephemerides assembled from RXM-SFRBX LNAV subframes (per-satellite subframe 1-3 assembly, IODC/IODE consistency gating, week resolved from RXM-RAWX in the same stream or a `refWeek` option — never the system clock). Oracle: 22/22 GPS records on a full ZED-F9P capture vs convbin at the printing quantum. UBX logs now carry their own nav like SBF and NovAtel.
- **`ubxFrames`** public framing iterator (Fletcher-8-checked), mirroring `oem4Frames`; `parseUbxRawx` rebuilt on it.
- **`scanSbfFrames`** re-exported from `gnss-js/sbf` for external frame-level tooling.

## 1.15.0

### New features — navigation and almanacs from receiver logs

- **SBF navigation blocks** — `parseSbfNav` (`gnss-js/sbf`): GPSNav/GLONav/GALNav/BDSNav/QZSNav into the standard `Ephemeris` types. Oracle-validated against convbin on a TU Delft PolaRx file (83 records, 1822 fields, zero disagreements) and independently spot-checked against sbf2rin output.
- **SBF almanac blocks** — `parseSbfAlmanac`: GPSAlm/GALAlm/GLOAlm/BDSAlm into new almanac types, decoded to absolute orbital elements per the ICDs (fixing an RTKLIB Galileo-almanac TODO and a demo5 week-adjustment sign bug along the way). Physically validated: almanac-propagated positions agree with broadcast ephemerides at almanac accuracy (Galileo 14–21 km, BDS 0.5–2.3 km).
- **NovAtel navigation** — `parseNovatelNav` (`gnss-js/novatel`): RAWEPHEM (raw LNAV subframes) and full GLOEPHEMERIS. Oracle: 14/14 records vs convbin at the printing quantum.
- **`gnss-js` internal `navbits`** — generic MSB-first bit readers and a GPS LNAV frame decoder shared by NovAtel today and a future u-blox RXM-SFRBX path.

## 1.14.1

### Bug fixes

- **`msmEpochToDate` returned UTC instead of GPS-scale time** — every consumer of epoch milliseconds in this library (satellite propagation, SPP, RINEX epoch tags) uses the GPS clock-face convention, so the 18-leap-second offset put satellite positions ±14 km wrong per satellite. Live SPP from an NTRIP stream scattered by kilometres; RINEX files recorded from streams carried epoch tags 18 s off. All three time branches (GPS-scale, GLONASS UTC+3h, BDS) now return the same GPS-scale instant, pinned by regression tests against an RTKLIB-verified capture. End-to-end validation on a real caster stream: single-frequency SPP now lands at 1.1/1.0/4.8 m E/N/U RMS against the station's surveyed position.

## 1.14.0

### New features — receiver raw formats

- **u-blox UBX** — `parseUbxRawx` (`gnss-js/ubx`): RXM-RAWX observables with the (gnssId, sigId) → RINEX code tables in the RTKLIB convention. Oracle-validated against RTKLIB convbin on a public F9P dataset: 4521/4521 epochs, ~1M observables at the 0.0005 RINEX printing quantum.
- **Septentrio SBF** — `parseSbfMeas` (`gnss-js/sbf`): Meas3Ranges reference/delta epochs with master/slave signals, Meas3CN0HiRes, Meas3Doppler, and classic MeasEpoch. Ported from RTKLIB demo5 septentrio.c (BSD-2-Clause) and cross-checked against the mosaic-X5 reference guide; validated against convbin on a TU Delft PolaRx daily file: 328,683 observables at the printing quantum. Two latent indexing quirks in the C original were fixed (documented in the source).
- **NovAtel OEM4/6/7** — `parseNovatelRange` (`gnss-js/novatel`): RANGE and RANGECMP (compressed) logs, carrier phase reconstructed from the 2^23-cycle rollover, GLONASS FDMA channels recovered from GLOEPHEMERIS. Validated against convbin on RTKLIB's OEMV sample: 4140 observables at the printing quantum.

## 1.13.0

### New features

- **`computeVisibilityFromPositions(all, mask)`** — the visibility aggregation (counts, DOPs, passes, tracks) split out of `computeVisibility` so it works from any position source shaped like `AllPositionsData` (broadcast ephemerides, TLE/SGP4, interpolated SP3). `computeVisibility` is unchanged, now a thin wrapper.

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
