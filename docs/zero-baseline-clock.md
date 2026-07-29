# Zero-baseline / single-difference receiver comparison

Design note — not yet built. Requested by Hans van der Marel (TU Delft) for the
Delft rig: 8 receivers (`DLF…`, mixed Septentrio PolaRx5 / Leica GR50 / Trimble
Alloy) on **one shared antenna** → a ~zero baseline. He wants receiver **clock
parameters and their differences**, which the existing RTK path cannot give him.

## Why RTK (double-difference) is the wrong tool here

The live RTK engine (`RtkFloatEngine`, DD code+phase EKF + LAMBDA) forms
double differences — between receivers **and** between satellites. The
between-satellite difference cancels the receiver-clock term by construction, so
DD deliberately throws away exactly the signal Hans wants.

## Why single-difference is clean on a zero baseline

For receiver `r` vs a reference receiver `0`, satellite `s`, signal `f`, epoch `t`:

```
ΔP_{r,s,f}(t) = P_r − P_0 = c·(dt_r − dt_0)(t) + (b^P_{r,f} − b^P_{0,f})                      + εP
ΔΦ_{r,s,f}(t) = Φ_r − Φ_0 = c·(dt_r − dt_0)(t) + (b^Φ_{r,f} − b^Φ_{0,f}) + λ·ΔN_{r,s,f}      + εΦ
```

On a zero baseline the geometric range, satellite clock/orbit, ionosphere,
troposphere — and **multipath** (same antenna!) — are identical for both
receivers and cancel exactly. What survives:

- `c·Δdt(t)` — the **relative receiver clock**, common across all sats/signals at `t`.
- `Δb_f` — per-signal receiver **hardware bias**, ~constant in time (code/phase,
  per frequency, per system).
- `λ·ΔN` — phase integer ambiguity, constant per continuous arc.
- noise — with multipath gone, this is close to the pure receiver noise floor.

## Products

1. **Relative clock** `Δdt(t)` time series (per receiver vs reference) → feed an
   **Allan deviation** to compare oscillator stability across the fleet.
2. **Inter-system / inter-frequency biases (ISB/IFB)** — per system relative to a
   reference system (GPS), and per signal; the interesting cut is _between
   receiver brands_ (PolaRx5 vs GR50 vs Alloy), all present on this rig.
3. **Residual RMS** per receiver — the receiver noise floor (multipath ≈ 0).

## Estimation

Per epoch `t`, robust least squares over the SDs of all common (sat, signal):

- **Code → absolute-ish clock.** With one signal, `Δdt` and the mean bias are not
  separable per epoch; estimate a single per-epoch "code clock difference"
  (`Δdt` + mean bias). Its **time variation** is the true relative clock (the
  constant bias differences away). Multi-GNSS makes ISB observable: per system
  `g`, the SD mean = `Δdt(t) + ISB_g`; fix `ISB_GPS = 0`, estimate the rest.
- **Phase → precise clock (no AR needed).** Time-difference the phase SD
  (between epochs): the per-arc ambiguity **and** the constant bias drop out,
  leaving `c·(Δdt(t) − Δdt(t−1))`. Integrate → precise relative clock up to a
  constant, which the code clock pins to an absolute level. Ambiguity resolution
  is unnecessary for clock _stability_.
- **Cycle-slip guard** per (receiver, sat, signal) phase-SD arc — since geometry
  cancels, a slip is a clean jump in the phase SD; detect and reset the arc.
- Elevation weighting / mask optional (elevation less critical at zero baseline);
  reuse the BRDC/stream orbit → elevation path when an ephemeris source is present.

The math is strictly simpler than RTK: no float/fixed EKF, no LAMBDA.

## API (gnss-js, `positioning/zero-baseline.ts`)

Mirror the streaming style of `RtkFloatEngine` / `PppEngine` (`process` / `reset`).

```ts
export interface ZeroBaselineOptions {
  reference: string; // reference receiver id
  referenceSystem?: string; // ISB datum, default 'G'
  elevationMaskDeg?: number; // default 0
}
export interface ReceiverClockSample {
  t: number; // epoch ms
  receiver: string;
  clockOffsetM: number | null; // relative clock from code (÷c for seconds)
  clockOffsetPhaseM: number | null; // phase-smoothed relative clock
  used: number;
  rejected: number;
  residualRmsM: number;
}
export interface ReceiverBias {
  receiver: string;
  system: string; // ISB per system vs referenceSystem
  code: string; // RINEX signal code
  biasM: number;
  sigmaM: number;
}
export class ZeroBaselineEngine {
  constructor(opts: ZeroBaselineOptions);
  /** One time-aligned instant: obs per receiver id. */
  process(epoch: {
    timeMs: number;
    obs: Record<string, RawObservation[]>;
  }): ReceiverClockSample[];
  biases(): ReceiverBias[];
  reset(): void;
}
```

Reuse `RawObservation`. For N>2 receivers each differences against the reference.

## gnsscalc integration

Reuse the two-stream RTK UI (point base+rover at two `DLF…` mounts), add a
"zero-baseline / receiver comparison" mode:

- relative clock-difference time series (ns),
- Allan deviation (log-log),
- ISB table (system × receiver-pair),
- residual RMS / noise-floor readout,
- CSV export of the clock series.

Epoch time-alignment: the existing `EpochPairer` (gnsscalc) handles 2 streams;
generalize to N for v2.

## Phasing

- **v1** — 2 receivers, code+phase relative clock + ISB, slip-guarded phase arcs,
  Allan. Zero-baseline assumption (geometry cancels).
- **v2** — N receivers vs reference; short _non-zero_ baseline (subtract geometry
  via a known/estimated baseline + satellite positions); full between-brand bias
  matrix.
- **Non-goals (v1)** — absolute clock (relative only), ambiguity resolution.

## Validation

Delft 8×`DLF` zero-baseline. Expect relative clocks at receiver-oscillator level,
stable per-brand ISBs, and phase-SD residuals ~mm (receiver noise). Cross-check
against Hans's own analysis where available.

## Effort

Moderate — a few focused days in gnss-js (SD formation + per-epoch LSQ + arc/slip
bookkeeping) plus a gnsscalc viz pass. Sequence **after** the current positioning
/ SBAS-DFMC / QC-report work settles; do not open it as another parallel thread.
