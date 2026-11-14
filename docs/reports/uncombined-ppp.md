# Uncombined PPP — report

Branch `feat/uncombined-ppp` (from 2.47.0). Everything is new API next to
the ionosphere-free engine; no default of `solvePpp` changed.

## What was built

| Piece                  | Where                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-signal input     | `ppp-signals.ts`: `PppSignal`, `PppMultiSatObs`, `selectPppSignals`, `toDualFrequencyObs`, `PPP_SIGNAL_PRIORITY`                                               | One tracking mode per band (code and carrier picked independently, e.g. GPS C1W + L1C), LLI and SNR per carrier, GLONASS FDMA by channel, band order per constellation overridable (`bands: { C: '15' }`). The first two signals are the clock-reference pair (GPS L1/L2, GLONASS G1/G2, Galileo E1/E5a, BeiDou B1I/B3I, QZSS L1/L2). Galileo E5 AltBOC is left out by default (see below). |
| Per-band antenna model | `ppp-antenna.ts`: `PppAntennaModel.satBandOffset`, `rcvBandOffsets` (optional, implemented by `buildPppAntenna` and passed through by `withSatelliteAntennas`) | Uncombined PCO/PCV per ANTEX frequency. The GPS fallback for uncalibrated bands is applied so that a pair combines exactly to `rcvOffset` (both `gps-bands` and `gps-if`); a missing third band alone takes GPS L5, else L2. The IF API is unchanged.                                                                                                                                       |
| Per-signal corrections | `ppp-corrections.ts`: `PppCorrections.evaluateSignals`                                                                                                         | Common station displacement + marker→ARP; per band antenna, wind-up × λ_j, higher-order ionosphere on code and phase. A signal whose satellite has no calibration for its band is flagged `missing` and dropped (the IF engine silently uses no offset).                                                                                                                                    |
| Uncombined engine      | `ppp-uncombined.ts`: `PppUncombinedEngine` (streaming), `solvePppUncombined` (batch)                                                                           | See the model below.                                                                                                                                                                                                                                                                                                                                                                        |
| AR cascade             | same file, `ar` option                                                                                                                                         | EWL → WL → NL with satellite phase OSBs, LAMBDA with partial fixing.                                                                                                                                                                                                                                                                                                                        |
| Ionosphere constraint  | same file, `ionosphere: { gim }`                                                                                                                               | GIM pseudo-observations + receiver DCB per clock group; single-frequency satellites usable.                                                                                                                                                                                                                                                                                                 |
| `PppOptions.gateK`     | `ppp.ts`                                                                                                                                                       | Exposes the IF engine's innovation gate (default 4, unchanged) for exact comparisons.                                                                                                                                                                                                                                                                                                       |
| Harness                | `scripts/uc/{equiv,multi,ar,load}.ts`                                                                                                                          | Bundled with esbuild and run in Node on cached EPN data.                                                                                                                                                                                                                                                                                                                                    |

### Why a separate engine and not an option of `PppEngine`

The state layout (per-satellite ionosphere, one ambiguity per carrier,
code-bias states), the measurement model and the AR are all different;
threading them through `PppEngine` (2200 lines tuned around one IF
ambiguity per satellite, with its slip-repair machinery) would have made
both harder to maintain and risked the production engine's behaviour. The
new engine reuses the shared pieces (`satStateAtEmission`, the scalar EKF
update, troposphere/gradient models, elevation weighting, the PPP
correction factory) and has the same streaming interface
(`process(epoch)` / `solution()`, `PppEpochResult` series), so a caller
can switch engines without other changes. The cost is some duplicated
logic (clock seeding, code screening, the time-differenced slip test),
deliberately kept identical so that the two engines can be compared
exactly.

### Observation model

Per satellite and signal j, μ_j = (1575.42 MHz / f_j)²:

    P_j = ρ + c·dt_r,grp − c·dt^s + T + μ_j·I + d_j + ΔP_j
    L_j = ρ + c·dt_r,grp − c·dt^s + T − μ_j·I + B_j (+ F_j) + ΔL_j

- I: slant ionosphere at 1575.42 MHz per satellite — white noise (default),
  random walk (default 0.01 m/√s), or random walk + GIM.
- B_j: one float ambiguity per carrier and arc (metres).
- d_j: satellite code OSB removed when the product has one; signals beyond
  the primary pair carry a receiver code bias per clock group and tracking
  code, or, without a satellite OSB, a satellite-and-receiver bias per
  satellite and signal.
- F_j: GPS L5 inter-frequency clock bias, random-walk phase bias
  (default 3e-4 m/√s; off with time-varying phase OSBs such as CNES's).
- Slips: the primary pair by the same MW and time-differenced IF tests as
  the IF engine (any → every carrier of the satellite resets); every further
  carrier by its geometry-free change against the first with the
  ionospheric change the pair shows removed, its MW with the first, and
  LLI per carrier. Per-band reset counts are reported (`resets`).
- Default weights: code 0.5 m, carrier 3 mm per signal at zenith (the IF
  engine's 3 m / 1 cm on the combination ≈ 1 m / 3.4 mm per signal; the
  lower code σ makes the wide lanes fix sooner and leaves the float
  solution as it was, below).

### AR cascade

Every 30 s, on a copy of the filter (the float filter is never constrained,
as in the IF engine): between-satellite ambiguities in cycles per clock
group and carrier tracking mode; per satellite the extra-wide lanes
(second signal minus each further one, ≥ 2.5 m: GPS L2−L5 5.9 m, Galileo
E5a−E5b 9.8 m, E5a−E6 2.9 m) fixed by rounding; the wide lane (first minus
second) from the between-satellite Melbourne–Wübbena average when the
filter agrees, the rest by LAMBDA on the filter; then the narrow lane (the
first carrier) by LAMBDA with ratio ≥ 3, bootstrapped success rate ≥ 0.99,
χ² and partial fixing (≥ 5). Each step is imposed as a constraint before
the next. If the narrow lanes fail, the attempt is redone with the
Melbourne–Wübbena wide lanes only — the filter-based wide lanes of new,
low satellites were occasionally wrong (ONSA, before this fallback: a
window lost its fix for an hour). Carriers without a phase OSB stay in the
float solution (their ambiguity is simply not fixed) instead of dropping
the satellite; a phase OSB of another tracking mode of the same band is
used when the own one is missing (CNES publishes GPS L5I, receivers log
L5Q).

## Gates

### Stage 1 — per-band model

Unit tests (`test/ppp-signals.test.ts`): per-band satellite and receiver
offsets combine ionosphere-free to the pair API's values to 1e-12 m (PCO and
PCV at several angles, azimuth PCV included, both fallback modes, a
GPS-only calibration used on Galileo/BeiDou); `evaluateSignals` combines to
`evaluate`'s code and carrier corrections to 1e-10 m.

### Stage 2 — IF equivalence (the main oracle)

Two frequencies, white-noise ionosphere, per-signal σ chosen so the pair
has the IF engine's σ (3 m / 1 cm), IF engine with `slipRepair: false`
(the UC engine has no slip repair), same corrections (igs20, tides,
wind-up, gradients). Final 24 h static position, UC − IF:

| Data                          | Products            | Systems           | ΔE / ΔN / ΔU (mm)                         |
| ----------------------------- | ------------------- | ----------------- | ----------------------------------------- |
| ABMF 2024-001                 | ESA MGEX + 30 s CLK | GE                | 0.015 / 0.001 / 0.003                     |
| ABMF 2024-001                 | ESA MGEX + 30 s CLK | GER               | 0.006 / 0.003 / 0.007                     |
| ABMF 2024-001                 | ESA MGEX + 30 s CLK | R only (4–7 sats) | −0.046 / 0.011 / −0.026                   |
| WTZR 2024-014                 | CODE MGX            | G / GE / GER      | ≤ 0.024 / 0.009 / 0.017                   |
| ONSA 2024-014                 | CODE MGX            | G / GE / GER      | ≤ 0.002 / 0.007 / 0.033                   |
| WTZR 2024-014, kinematic, 6 h | CODE MGX            | GE                | 0.011 / −0.023 / −0.026 (per epoch ≤ 0.2) |

All under the 0.1 mm gate. Along the series the difference is ≤ 0.2 mm
after the first hour (it is not exactly zero in theory: with a carrier
ionosphere state the code–carrier "GRAPHIC" combination adds a little
geometric information the IF combination discards, and the ambiguity
priors differ; both effects are 1e-3-level). The ABMF day is a unit test
(local fixtures; skipped without them).

Getting there found one thing in the IF engine worth knowing: its
time-differenced slip test is meant to be confirmed by a Melbourne–Wübbena
jump, but `Vis.mw` there is the _wet mapping function_ (a name clash with
the MW combination), so that confirmation never fires — the test is
effectively "geometry-free jump or > 30 cm". The UC engine reproduces the
effective behaviour (and says so in a comment); the IF engine is not
changed here, since fixing it changes its slip decisions and needs its own
benchmark.

Cost: one day at 30 s, GE two frequencies: UC 2.3 s vs IF 5.4 s (Node,
M-series Mac, other jobs running); all frequencies GE 6–7 s, GEC (five
BeiDou signals) 18 s. The IF engine does extra per-epoch work (arc
snapshots, repair state) that the UC engine does not.

### Stage 3 — three and more frequencies

- Synthetic (`test/ppp-uncombined.test.ts`): GPS L1/L2/L5 + Galileo
  E1/E5a/E5b/E6 with receiver and satellite code biases, a 5 cm L5
  inter-frequency clock bias, noise: 4 h position within 3 mm; without the
  L5 bias state the error grows > 3× (and > 3 cm at 1 h). A 3-cycle slip
  injected on one extra carrier (GPS L5, Galileo E5b) of two satellites is
  found and only that carrier resets.
- Real days (WTZR, ONSA 2024-014, CODE MGX, float, 24 h): the daily
  coordinate with all frequencies equals the primary pair's within ~1 mm
  (WTZR GE 0.0/1.5/2.7 vs 0.1/1.3/2.3 mm against EUREF), convergence alike.
  That is the expected result: with a free ionosphere extra frequencies add
  noise-level information only; their value is in AR (below). No spurious
  resets on the extra bands (WTZR GPS L5: 0 in a day; Galileo E5b/E6 the
  same counts as E1/E5a).
- Galileo E5 AltBOC (band 8) together with E5a and E5b made short float
  solutions worse with CNES's code biases (ONSA, 2 h windows, float 3D at
  15 min 75 → 116 mm): it is the sum of the two sidebands, its code adds
  correlated multipath. It is no longer selected by default.
- BeiDou B1I/B3I/B1C/B2a/B2I runs (WTZR GEC: 45 k B1I, 26 k B1C epochs);
  float only — none of the 2024 products tested has BeiDou phase OSBs
  for the receivers' tracking modes in this harness, so BeiDou AR is
  untested.
- GPS L5 inter-frequency bias σ: 1e-4 … 1e-3 m/√s change the WTZR daily
  float by < 0.5 mm; default 3e-4.

### Stage 4 — ambiguity resolution

Eight EPN stations (HERS, JOZE, LPAL, MAR6, ONSA, SCOR, WTZR, ZIMM),
2024-014, GPS + Galileo, Niell troposphere, igs20, 10° mask; windows
starting every 2 h (1 h windows) or 3 h (2 h windows). Truth: EUREF's
weekly combined solution (week 2297). "TTF" = time to the first fixed
epoch within 5 cm of the truth; "wrong" = fixed epochs > 10 cm off. IF-AR
is today's engine with `ar: true` (what /ppp and /campaign use); IF-AR30
the same with `everyS: 30, minArcS: 300` to separate cadence from method.
UC2 = uncombined, primary pair; UCall = all frequencies.

CODE final (COD0OPSFIN: phase OSBs for GPS L1/L2 and Galileo E1/E5a only):

| Window | Engine  | Windows | Fixed at end | Fixed within window | TTF median (min) | TTF p75 (min) | Windows with wrong fixes | End error RMS E/N/U (mm) | Float 3D at 15/30/60 min (mm, median) |
| ------ | ------- | ------- | ------------ | ------------------- | ---------------- | ------------- | ------------------------ | ------------------------ | ------------------------------------- |
| 1 h    | IF-AR   | 96      | 79           | 86                  | 20.0             | 24.0          | 0                        | 8.8/6.7/17.1             | 46/28/21                              |
| 1 h    | IF-AR30 | 96      | 79           | 87                  | 19.5             | 24.5          | 1 (1 epoch)              | 9.0/6.8/16.9             | 46/28/21                              |
| 1 h    | UC2     | 96      | 92           | 96                  | 14.5             | 17.0          | 0                        | 6.9/6.1/18.1             | 46/32/20                              |
| 1 h    | UCall   | 96      | 92           | 96                  | 14.0             | 16.5          | 0                        | 6.8/6.1/17.9             | 50/32/22                              |
| 2 h    | IF-AR   | 64      | 56           | 60                  | 22.0             | 32.0          | 0                        | 6.6/5.0/12.2             | 51/29/20                              |
| 2 h    | IF-AR30 | 64      | 54           | 60                  | 21.2             | 27.5          | 0                        | 7.0/5.0/12.4             | 51/29/20                              |
| 2 h    | UC2     | 64      | 61           | 64                  | 14.5             | 17.5          | 0                        | 4.1/4.7/11.7             | 54/28/18                              |
| 2 h    | UCall   | 64      | 61           | 64                  | 14.5             | 17.5          | 0                        | 4.1/4.6/11.7             | 54/28/18                              |

CNES post-processed bundle (GFZ rapid orbits, CNES 30 s clocks and
time-varying OSBs incl. GPS L5 and Galileo E5b/E6 phase):

| Window | Engine  | Windows | Fixed at end | Fixed within window | TTF median (min) | TTF p75 (min) | Windows with wrong fixes | End error RMS E/N/U (mm) | Float 3D at 15/30/60 min (mm, median) |
| ------ | ------- | ------- | ------------ | ------------------- | ---------------- | ------------- | ------------------------ | ------------------------ | ------------------------------------- |
| 1 h    | IF-AR   | 96      | 82           | 85                  | 20.0             | 26.0          | 1 (8 epochs)             | 8.9/6.8/15.5             | 52/31/24                              |
| 1 h    | IF-AR30 | 96      | 79           | 86                  | 20.0             | 25.0          | 1 (4 epochs)             | 9.1/7.0/15.7             | 52/31/24                              |
| 1 h    | UC2     | 96      | 89           | 95                  | 14.0             | 17.0          | 0                        | 6.8/6.0/14.2             | 54/32/25                              |
| 1 h    | UCall   | 96      | 93           | 95                  | **10.5**         | **13.0**      | 0                        | 5.8/6.2/14.9             | 52/32/24                              |
| 2 h    | IF-AR   | 64      | 55           | 59                  | 22.0             | 30.0          | 0                        | 8.9/6.1/11.0             | 56/32/20                              |
| 2 h    | IF-AR30 | 64      | 51           | 59                  | 20.5             | 30.0          | 0                        | 9.7/6.2/11.7             | 56/32/20                              |
| 2 h    | UC2     | 64      | 59           | 63                  | 14.5             | 17.0          | 1 (1 epoch)              | 6.6/5.9/10.2             | 60/32/20                              |
| 2 h    | UCall   | 64      | 59           | 63                  | **10.5**         | **13.0**      | 0                        | 6.4/5.9/10.4             | 70/26/20                              |

Reading:

- Same products, same two frequencies, the uncombined cascade fixes about
  6–8 min sooner (median 20–22 → 14–14.5 min) and fixes almost every
  window (95–96 of 96 vs 85–87). The gain is not the attempt cadence
  (IF-AR30 is within 1 min of IF-AR); it comes from the wide lanes being
  fixed (and imposed) per satellite as soon as each is ready, and from the
  narrow lanes being searched on the conditioned filter with partial
  fixing.
- With phase OSBs on a third frequency (CNES) the extra-wide lanes fix in
  the first minutes and the median drops further to 10.5 min (p75
  17 → 13 min). With CODE's 2024 products (no L5/E5b/E6 phase OSBs) the
  extra frequencies cannot help AR and UCall = UC2.
- No wrong fixes in 160 UCall windows. The IF engine had one CNES window
  with 8 wrong epochs (WTZR 08:00, fixed > 10 cm off).
- Fixed coordinates: same accuracy (end-of-window RMS 4–9 mm horizontal,
  10–18 mm up for every engine; 24 h sessions with CODE: 1–6 mm in every
  component for both engines on all eight stations).
- The float solution is the same at 15/30/60 min. UCall with CNES on 2 h
  windows is worse at 15 min (70 vs 56 mm median); not explained yet
  (E5b/E6 code-bias handling is the suspect; see open items).
- 24 h sessions (one per station): UC TTF 8–17 min (CNES, all
  frequencies) vs 14–32 min (IF); fixed share of epochs 63–99 % vs
  43–94 %.

### Stage 5 — ionosphere constraint (GIM)

CODE's final GIM (1 h) as a pseudo-observation (σ 1 m) when a satellite's
ionosphere state starts and every 30 min, random-walk ionosphere, a
receiver DCB per clock group; CODE products, 1 h windows, same eight
stations:

| Engine    | Fixed within window | TTF median (min) | Windows with wrong fixes | Float 3D 15/30/60 min (mm) |
| --------- | ------------------- | ---------------- | ------------------------ | -------------------------- |
| UC2       | 96                  | 14.5             | 0                        | 46/32/20                   |
| UC2 + GIM | 95                  | 14.5             | 1 (6 epochs)             | 49/30/20                   |

No gain: a 1 m map is too weak next to the code (σ 0.5 m per signal, ×
dozens of satellites) to speed convergence. Tighter σ (0.5 m) produced a
wrong fix. A first try with a 2 mm/√s random walk (the literature's
typical value) gave wrong fixes and decimetre floats on every station:
the slant ionosphere at 30 s moves faster than that; 1 cm/√s behaves like
white noise. The constraint stays in the API (it is what makes
single-frequency satellites usable, tested synthetically), off by default.
Regional maps with decimetre accuracy would be the case to re-test.

## What is left

- **gnsscalc integration** (not done; nothing was needed there for the
  validation): `loadPppInput` would call `selectPppSignals` instead of
  `pppSatFrom`, keeping LLI; `/ppp` and `/campaign` would call
  `solvePppUncombined`; ZTD backward pass, diagnostics (`PppEpochDiagnostics`
  per signal) and `exposeState`/`fixPppPosition` are not ported to the UC
  engine yet; the AR summary has no `maxFloatGapM` fallback logic.
- **Antenna binary**: the site's compact antenna file has IF pairs only;
  the UC engine needs per-band offsets (`satBandOffset`/`rcvBandOffsets`) —
  a new layout. Without them `evaluateSignals` applies no antenna model.
- **BeiDou / QZSS AR**: untested (needs CODE MGX 2026 or CNES BeiDou OSBs
  with matching tracking modes); GLONASS stays float (no phase OSBs).
- **CODE MGX OSB** (2026: B1C/B2a and QZSS L1/L5 phase) and Wuhan
  (L5/E5b/E6 phase) would give the third-frequency AR gain with daily
  constant biases; only CNES's time-varying biases were tested here.
- **UCall float with CNES at 15 min** (above) and the band-8 finding
  suggest the extra signals' code-bias handling (receiver bias per tracking
  code vs per satellite) deserves a look; also whether to estimate the
  receiver code bias per _pair_ group (2W vs 2L GPS satellites share a
  clock today, as in the IF engine).
- **Slip repair** of the IF engine is not ported (the UC engine resets);
  with three frequencies repair is simpler (geometry-free + EWL) and is
  the natural next step for /stream.
- **Kinematic/stream**: only the equivalence was checked in kinematic mode;
  no 1 Hz or moving-receiver data, no AR "hold" mode.
- The IF engine's inert MW slip confirmation (above).
- The EPN 40-station benchmark was not run (other jobs held the CPU); all
  numbers here are 8 stations × one day.

## Recommendation

- **/ppp (short sessions, AR): switch, after the integration work above.**
  The same products give fixes ~30 % sooner and in nearly every window,
  with no wrong fixes seen, and with three-frequency phase biases about
  half the IF engine's time to fix. Keep the IF engine as the fallback until
  the per-band antenna binary exists and a 40-station week has been run.
- **/campaign (24 h static): no reason to switch yet.** The daily float and
  fixed coordinates are the same (the equivalence gate shows why); the
  switch only pays once BeiDou/QZSS AR or slip repair need it.
- **/stream: switch later.** Faster AR matters most there, but it needs
  slip repair, a hold mode and 1 Hz validation first.
