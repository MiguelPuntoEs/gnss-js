# Changelog

## 2.44.0

### Added — start PPP from a known position

- `PppOptions.aprioriSigmaM`: the 1σ of `aprioriPos` (default 100 m, as before). Starting on a surveyed mark (a few mm to cm) gives a converged filter from the first epoch.
- `PppOptions.initialStaticSec`: in kinematic mode, the receiver stands still for this long at the start (on the mark, before moving), so its position is held as one state over that time.
- On ABMF processed kinematically, starting from its coordinate (1 cm) with 10 minutes on the mark: minutes 10–30 at 1.7 cm horizontal RMS, against 18.5 cm from a cold start.

## 2.43.0

### Added — PPP cycle-slip repair (kinematic re-convergence)

- `PppOptions.slipRepair` (default on): when a satellite returns after a short gap (≤ 120 s) or with its loss-of-lock flag set, its carrier jumps are repaired instead of re-initialising the ambiguity — wide-lane jump from Melbourne–Wübbena, L1 jump from the geometry-free phase with the ionosphere extrapolated linearly across the gap. Only accepted when the ionosphere trend is linear (fit scatter < 1 cm) and both jumps are within 0.15 cycles of an integer; otherwise the old reset. Unflagged jumps are left to the existing detectors.
- Ambiguities of unseen satellites are kept for the repair window (time-based, not 20 epochs — at 1 Hz that was 20 s).
- `PppEpochResult.posSigma3d` (formal 3D σ after the update) and `slipsRepaired`.
- Measured on 6 held-out EUREF stations, kinematic, 30 s data: a 60 s total outage every 30 min went from 65 / 42 cm RMS (H/V) and a ~16 min re-convergence to 99 % of epochs within 10 cm and a median recovery of 0 min; frequent short drops ("light urban") from 9 % to 94 % of epochs within 10 cm; open sky unchanged (2.2 / 1.7 cm). In ABMF's equatorial ionosphere most repairs are refused (no change vs reset). Outages > 2 min still re-converge.

## 2.42.0

### Added — PPP diagnostics for processing reports

- `PppOptions.diagnostics`: each epoch of the series gets `diagnostics`, with the receiver clock per constellation (`clockM`), the position's formal 1σ East/North/Up (`positionSigmaEnu`) and, per satellite above the mask, elevation, azimuth, the post-fit ionosphere-free code and phase residuals (constellation mean removed), whether code and phase entered the filter, and whether the ambiguity was reset.
- Read-only: the solution is identical with it on. Off by default (one small object per satellite and epoch).
- New types `PppEpochDiagnostics` and `PppSatDiagnostics`.

### Added — finer multipath sky

- `QualityResult.multipathSky.fine`: the code-multipath RMS on a 10° azimuth × 5° elevation grid (cells with fewer than 20 samples null), for drawing. The median, worst sector and grading stay on the 30° × 10° cells.

### Fixed

- An epoch without usable satellites reported a zenith hydrostatic delay of 0, so its ZTD dropped to the wet part alone (about 0.2 m instead of 2.5 m). It is now the station's zenith delay from the same troposphere model.

## 2.41.0

### Added — Ireland, Portugal and Spain grids

- `IRISH_TM`: Irish Transverse Mercator (EPSG:2157), on ETRS89 as ETRF2000 at 2009.756.
- `PORTUGAL_TM06`: PT-TM06 (EPSG:3763), on ETRS89 as ETRF97 at 1995.4.
- `SPAIN_UTM_ZONES`: ETRS89 UTM zones 29–31 (EPSG:25829–25831), on ERGNSS, which is ETRF2000 at 2017.0.
- Realisations as EPSG lists them (Lott, EUREF 2025).
- Matches PROJ 9.8.1 to 0.1 mm at 75 points; the inverse matches to 1e-9°.

## 2.40.0

### Fixed — PPP-AR no longer reports a stale fix

- A static session whose final fix attempt failed used to report its last accepted fix as the session's ambiguity-fixed position, however early in the session it was. On 2–4 h sessions at 25 IGS stations that fix was often 10–46 cm from the truth, because the filter had moved on since.
  - The fallback is now kept only while it lies within `ar.maxFloatGapM` (default 0.03 m) of the final float position. Otherwise `ar.rejected` is `'float-gap'` and `ar.position` is `null`.
  - A fix from the final attempt is reported as before. On short sessions a correct fix can sit a few centimetres from the not-yet-converged float, so the distance test applies only to fallbacks.
  - Against the IGS weekly solution the worst errors drop to those of float PPP (4 h: 30 → 3.7 cm horizontal; 2 h: 46 → 20 cm), and ambiguity fixing still improves the 2 h median horizontal error from 1.28 to 0.82 cm.

### Added

- `fixPppPosition()` returns `covariance`: the position covariance given the fixed integers (Q_xx − Q_xz·Q_zz⁻¹·Q_zx). `PppSolution.ar.covariance` carries it, so a fixed position no longer has to borrow the float covariance.
- `PppSolution.ar.floatGapM`: the 3D distance between the fix and the final float position.

## 2.39.0

### Added — Switzerland: CH1903+ / LV95

- `etrs89ToLv95()` and `lv95ToEtrs89()` convert between ETRS89 (CHTRF95) and CH1903+ / LV95 (EPSG:2056), as EPSG and swisstopo define it: the EPSG:1647 geocentric translation onto Bessel 1841, then the Swiss oblique Mercator.
  - As in PROJ, the point keeps its height through the shift. Unlike PROJ, the inverse iterates the Bessel height, so it exactly undoes the forward conversion; PROJ's inverse is about 1 mm off.
- `geodeticToSwissObliqueMercator()` and `swissObliqueMercatorToGeodetic()` implement EPSG method 9814 (PROJ's `somerc`). `LV95` is the grid.
- `transformFrame()` knows `'ETRF89'`, via ITRF89 (EPSG:7932). CHTRF95 is ETRF89 at epoch 1993.0.
- All of these match PROJ 9.8.1: 0.1 mm for the projection and 1 mm for the full chain, at 37 points from 200 to 4,000 m.

## 2.38.0

Not published on its own: a GitHub Actions outage stranded its CI, so its changes first ship in 2.39.0.

### Added — US State Plane, Belgium and Poland grids; one projection type

- `US_STATE_PLANE_ZONES` lists the 117 SPCS83 metre zones on NAD83(2011): transverse Mercator and Lambert, with parameters and areas of use from EPSG.
  - `statePlaneZoneAt(lat, lon)` picks the zone with the smallest area of use containing the point. Alaska zone 10, which crosses the antimeridian, is handled.
  - Not included: Alaska zone 1 (oblique Mercator), and Hawaii and the Pacific islands, which are on NAD83(PA11)/(MA11).
- `BELGIAN_LAMBERT_2008` (EPSG:3812), `POLAND_CS92` (PL-1992, EPSG:2180) and `POLAND_CS2000_ZONES` (PL-2000 zones 5–8, EPSG:2176–2179).
- `MapProjection` is one type for both kinds of grid (`GridProjection` and `ConicProjection`). `geodeticToGrid()` and `gridToGeodetic()` work with either, and `isConicProjection()` tells them apart.
- All of these match PROJ 9.8.1 to 0.1 mm at 774 points; the inverse matches to 1e-9°.

### Fixed

- Transverse Mercator and Lambert conformal conic now wrap the longitude difference from the central meridian to ±180°. Before, a zone that crosses the antimeridian put points on the far side (for example 175°E in the Aleutians) thousands of kilometres off.

## 2.37.0

Not published on its own, for the same reason as 2.38.0: these changes first ship in 2.39.0.

### Added — what RINEX 3 nav records say about themselves

`parseNavFile()` now keeps four fields of GPS, Galileo, BeiDou, QZSS and NavIC records that it used to drop. All are optional on `KeplerEphemeris`, and both nav writers write them back.

- `ttm`: when the message was transmitted, in seconds of the record's week (it can be negative, meaning the previous week). Absent when the file marks it unknown. This is what tells you which ephemeris a receiver actually had at a given moment.
- `svAccuracy`: the accuracy the message claims, in metres (GPS/QZSS URA, Galileo SISA, BeiDou URA).
- `dataSources`: Galileo only. Tells I/NAV records apart from F/NAV ones, and which signal pair the clock refers to.
- `tgd2`: the second group delay. Galileo BGD E5b/E1 and BeiDou TGD2 (B2I/B3I). `tgd` stays the first one.

## 2.36.0

### Added — France: Lambert-93 and the CC zones

- `geodeticToLambertConformalConic()` and `lambertConformalConicToGeodetic()` implement EPSG method 9802, the two-standard-parallel Lambert conformal conic projection, as PROJ's `lcc`.
- `LAMBERT_93` (EPSG:2154) and `FRANCE_CC_ZONES` (CC42–CC50, EPSG:3942–3950) are on RGF93, France's ETRS89, which IGN realises as ETRF2000 (RGF93 v2b).
- `franceCcZone(lat)` returns the CC zone for a latitude.
- Matches PROJ 9.8.1 to 0.1 mm at 143 points across mainland France and Corsica. The inverse matches to 1e-9°.

## 2.35.0

### Added — Great Britain: OSTN15/OSGM15 National Grid and heights

- `etrs89ToOsgb()` and `osgbToEtrs89()` implement Ordnance Survey's definitive ETRS89 ↔ OSGB36 National Grid (EPSG:27700) transformation and the OSGM15 geoid, as the OS user guide defines them:
  - ETRS89 is projected with the National Grid parameters on GRS80, then the shifts are interpolated bilinearly from the 1 km grid. The inverse is iterated to 0.1 mm.
  - The height datum is taken from the nearest-quadrant flag: ODN, St Marys, Douglas02, Stornoway15, Lerwick, Newlyn (Orkney) or Newlyn Offshore (`OSGM15_DATUMS`). Points outside the transformation (flag 16) are refused.
  - The projection uses OS's own transverse Mercator series, which OSTN15 is defined with. The exact series differs from it by about 1 mm in the far west of the grid.
- Reproduces all 80 OS test points (TP01–TP40 in both directions): eastings, northings and heights to OS's millimetre, datum flags exactly, latitudes and longitudes to 1e-9°.
- The grid is supplied by the caller as a node lookup (`OstnGrid`), so it can be loaded in tiles. `ostn15GridPosition()` tells the caller which cell a position needs.
- `itrfToOsgb()` and `osgbToItrf()` go through ETRF97, the realisation of OS Net v2009.
- `transformFrame()` knows `'ETRF97'`, via ITRF97 (EPSG:7939), and matches PROJ.
  - EPSG:10889 (ETRF97 → ETRF2000 directly) puts the two frames 0.28 m apart in Britain, against 6.6 cm through ITRF, so it is not used.

## 2.34.0

### Added — the Netherlands: RD and NAP (RDNAPTRANS™2018)

- `etrs89ToRdnap()` and `rdnapToEtrs89()` implement the official NSGI transformation between ETRS89 (ETRF2000) and the Dutch RD grid plus NAP heights, as variant 2 in PROJ/EPSG:
  - The rdtrans2018 offset grid takes ETRS89 to Amersfoort (Bessel), and is iterated because its offsets are defined at Amersfoort positions.
  - The oblique stereographic projection gives RD x, y.
  - NAP = h − NLGEO2018.
- `itrfToRdnap()` and `rdnapToItrf()` go through ETRF2000 from any frame `transformFrame` knows.
- Checked against NSGI's 100 certified reference points (Z001): 0.18 mm in RD and 0.05 mm in NAP in the worst case, against a 1 mm certification tolerance. The inverse matches to 2e-9°.
- Grids are supplied by the caller (PROJ CDN: `nl_nsgi_rdtrans2018.tif`, `nl_nsgi_nlgeo2018.tif`). `latLonGridModel()` interpolates any number of planes over nested grids, finer grids first.
- `geodeticToObliqueStereographic()` and `obliqueStereographicToGeodetic()` implement EPSG method 9809. `RD_NEW` (EPSG:28992) and `BESSEL_1841` are included. Matches PROJ's `sterea` to 0.1 mm.

## 2.33.1

### Fixed — BeiDou orbits used the wrong Earth rotation rate

- `computeSatPosition()`, `keplerPosition()` and the almanac path now use the CGCS2000 Earth rotation rate for BeiDou (`OMEGA_E_BDS`, 7.2921150e-5 rad/s, BDS-SIS-ICD; RTKLIB's `OMGE_CMP`). They used WGS84's 7.2921151467e-5. The 1.467e-12 rad/s difference enters through the Ωe·toe term, so the error was a rotation about the Earth's axis that grew through the BDT week: under a metre on Sunday, 15–35 m along- and cross-track by Saturday. GPS, Galileo, QZSS and NavIC keep the WGS84 value.
- Found by comparing a month of broadcast BeiDou orbits against ESA's final orbits. With the fix, BeiDou matches them to 1–2 m on every day of the week. Pinned in `test/orbit-bds-rotation.test.ts`: C30 was 14 m off and C08 33 m off on Saturday 2026-09-19.

## 2.33.0

### Added — national frames and grids for Finland, Norway, Denmark, Australia and Canada

Every transformation and grid below matches PROJ 9.8.1 in tests: 582 frame cases and 1,606 grid cases.

- `itrfToNkg()` and `nkgToItrf()` run the NKG2020 transformation (EPSG/PROJ) for the Nordic national ETRS89 realisations: SWEREF 99, EUREF-FIN (fixed at 1997.0), EUREF89 (Norway, 1995.0) and ETRS89-DNK (2015.829). The chain goes from ITRF through ETRF2014 and NKG_ETRF14 at 2000.0, then a national step, with the NKG_RF17vel land-uplift model applied at each end. Matches PROJ to 0.08 mm.
  - Norway's national step is not a Helmert transform. It is Kartverket's geocentric shift grid (EPSG:10811). Pass it as `models.norway` via the new `geocentricShiftGridModel()`. Even with the grid thinned 4× (100 KB gzipped), the result stays within 0.3 mm of PROJ on the full grid.
  - `NKG_FRAMES` gives each frame's epoch and parameters.
  - `itrfToSweref99()` and `sweref99ToItrf()` now call these functions and give the same results as before.
- `transformFrame()` knows three more frames:
  - `'GDA2020'` (EPSG:8049) and `'GDA94'` (EPSG:9682), both from ITRF2014.
  - `'NAD83(CSRS)'` (v8, EPSG:10415) from ITRF2020. Its parameters are the same as NAD83(2011)'s.
- `TransverseMercatorParams.lat0`: a latitude of origin other than the equator, which Norway's NTM needs (58°N).
- National grids as `GridProjection`s, with names and EPSG codes:
  - Finland: `TM35FIN`, `FINLAND_GK_ZONES` (ETRS-GK19–31).
  - Norway: `NORWAY_UTM_ZONES` (32/33/35), `NORWAY_NTM_ZONES` (5–30).
  - Denmark: `DENMARK_UTM_ZONES`, `DENMARK_DKTM_ZONES`.
  - Australia: `MGA2020_ZONES`, `MGA94_ZONES`.
  - Canada: `CANADA_UTM_ZONES`, `CANADA_MTM_ZONES`.
- `nearestZone(zones, lon)` returns the zone whose central meridian is closest to `lon`.

Not included:

- NAD83(CSRS) propagation to epoch 2010 with NRCan's velocity grid. `transformFrame` gives NAD83(CSRS) coordinates at the epoch you pass, as it does for NAD83(2011).
- National height systems.

## 2.32.1

### Fixed — SBAS left out of the multipath sky map (`analysis`)

`QualityResult.multipathSky` no longer includes SBAS satellites. A geostationary satellite sits in one sky cell all day, so it doesn't show where a reflector is. An anomalous SBAS signal also put the "worst sector" on that satellite at every station that saw it: S28 on 2026/313 had 19 m of code multipath at BIK0 and DJIG, 4,000 km apart.

## 2.32.0

Found by checking every computation on gnsscalc.com/coordinates against 40-digit arithmetic, GeographicLib and PROJ (`coordinates`). Geodetic ↔ ECEF, ENU/AER, rhumb lines, UTM and the frame transformations all agreed to well under a millimetre; two edge cases did not.

### Fixed — geodesics between nearly antipodal points

`vincenty()` and `vincentyDirect()` now solve the geodesic problems with Karney's algorithm (J. Geodesy 87, 2013), ported from GeographicLib (MIT) for WGS84. Vincenty's iteration fails within about 0.6° of the antipode. There it fell back to a spherical estimate:

- Distances were wrong by up to 33 km, bearings by up to 90°.
- `greatCircleMidpoint()` was off by up to 10,000 km.

Now all three match GeographicLib to nanometres everywhere: 21,000 test pairs, 9,000 of them within 1° of the antipode. Real long-haul pairs (Madrid–Wellington, Seville–Auckland) were already right and are unchanged. The names stay for compatibility, and `converged` is now always `true`.

### Added

- `geodesicInverse(lat1, lon1, lat2, lon2)` and `geodesicDirect(lat1, lon1, azi1, s12)`, in degrees, for the WGS84 inverse and direct problems.

### Fixed — ellipsoidal height near the poles

`ecefToGeodetic()` computed the height as p / cos φ − N, which divides by cos φ → 0 at the poles. The height was 1 mm wrong 1 m from the polar axis, 0.35 m at 1 cm and 28 m at 0.1 mm (more at orbital heights). It now uses h = p·cos φ + z·sin φ − a·√(1 − e²·sin²φ), which is well conditioned at every latitude: under 0.2 µm everywhere. Latitude and longitude were already right.

## 2.31.0

### New — SWEREF 99 and the Swedish national grids (`coordinates`, `frames`)

- **Projections.** `geodeticToTransverseMercator` / `transverseMercatorToGeodetic` use Krüger's formulas to n⁴ (Lantmäteriet), which stay accurate far from the central meridian. `SWEREF99_TM` (EPSG:3006) and the 12 local zones `SWEREF99_LOCAL_ZONES` (EPSG:3007–3018) are included, plus `nearestSweref99LocalZone`. Matches PROJ to 0.01 mm at 48 points across Sweden in all 13 projections.
- **Frame.** `itrfToSweref99` / `sweref99ToItrf` follow the NKG2020 chain as PROJ does: ITRF → ETRF2014 → NKG_ETRF14 @ 2000.0 → SWEREF 99, with the NKG_RF17vel intraplate velocity model for the land uplift. A plain ITRF → ETRF Helmert misses that motion. The caller supplies the grid (`velocityGridModel` wraps any regular E/N/U grid). Matches PROJ 9.8 to 0.08 mm for ITRF2020 and ITRF2014 at epochs 2000–2026.9.

## 2.30.0

Two false-slip sources, found by running QC over the 562 IGS/EUREF stations of 2026/314 (`analysis`).

### Fixed — the phase-only fallback no longer overrides a complete pair

The geometry-free test is the fallback for satellites without code on two bands. It also ran on pairs with a phase-only band when the satellite was already covered by Melbourne-Wübbena on a complete pair. BeiDou GEO C03 at POL2 (Javad) records L7I without C7I, and that L7I jitters by 10–25 cm between epochs. Geometry-free on B1I–B2I flagged 75 % of its epochs, while Melbourne-Wübbena on B1I–B3I was clean.

- The geometry-free test now runs only when Melbourne-Wübbena covered no pair for that satellite at that epoch.
- POL2: 3,836 BeiDou slip epochs before, 4 after.
- The teqc-pinned slip tests and clean stations are unchanged (WTZR, ABMF, ONSA identical).

### Changed — satellites the broadcast navigation doesn't carry are not graded

With an elevation mask, observations of a satellite are left out of the graded statistics when its system's navigation carries other satellites but never that one. Such a satellite isn't in service, and its elevation can't be checked against the mask. NavIC I06 at KUNZ was tracked but never broadcast, and accounted for all 1,439 of that day's slips (MAUR: 4,452 → 557).

- A system missing from the navigation entirely is still graded (unknown elevation is not low elevation).
- The satellites left out are listed in the new `QualityResult.notBroadcast`.

## 2.29.1

### Fixed — BeiDou B1I in RINEX 3.00–3.02 files (`rinex`)

RINEX 3.02 labels BeiDou B1I as band 1 (`C1I`/`L1I`). From 3.03, band 1 means B1C (1575.42 MHz) and B1I is band 2 (`C2I`, 1561.098 MHz). The parser read 3.02 files with the 3.03 meaning, so every B1I phase got the wrong wavelength. In QC this showed as cycle slips on half of all BeiDou epochs:

- GMSD (Trimble NetR9): 10,926 BeiDou slip epochs before, 2 after.
- HKSL (Leica GR50): 15,586 before, 6 after.

Positioning with BeiDou from such files was affected the same way. The header parser now renames BeiDou band-1 codes to band 2 for versions 3.00–3.02, as RTKLIB does. Files that already declare band-2 codes are left unchanged.

## 2.29.0

### New — receiver channel limits in tracking (`analysis`)

`TrackingResult.perSystem[].channelLimit` is set when the receiver recorded at most a fixed number of a system's satellites at once, sat at that count for most of the day (≥ 80 % of its epochs), and more satellites were above the mask during most of that time. This is a channel allocation in the receiver's configuration, not a site problem. Leica GR10/GR25 stations set to 4 or 6 Galileo satellites tracked only 49–76 % of the Galileo satellites in view and were graded as poor sites.

- On 25 IGS/EUREF stations (2026/314) it flags Galileo on 8 Leica GR10/GR25 receivers (capped at 4 or 6) and nothing on the other 17 (Septentrio, Trimble, Javad, other Leicas).
- The tracking figures themselves are unchanged. Callers decide what to do with a capped system.

## 2.28.0

### New — multipath as Anubis and teqc average it (`analysis`)

`QualityResult.referenceMultipath` reports the code multipath combinations the way Anubis and teqc average them, so the figures can be compared with those tools' reports. This is for reference only; the graded multipath is unchanged. `ReferenceMultipathAccumulator` is also available on its own. The option `referenceMultipath: false` turns it off; it adds about 2 s on a 1 Hz day.

- **Anubis method:**
  - every code signal separately (`GPS M1C`, `M2W`, `M2L`, …), each with one phase pair per satellite;
  - the standard deviation of each 20-epoch window, averaged per satellite, then over satellites;
  - a per-band summary like Anubis's `mp1`–`mp8`.
- **teqc method:**
  - MP12, MP21 (and MP15, MP51) for GPS and GLONASS;
  - each value minus the mean of its last 50 values, as an RMS per satellite above the mask, then averaged over satellites;
  - a summary that pools GPS and GLONASS, like teqc's "Moving average MP12".
- **Fitted against the tools' own output, not just their summaries.**
  - Anubis 3.11 on seven IGS/EUREF stations (2026/313, 153 signals): median ratio 0.98, and 80 % of signals within 0.91–1.10.
  - teqc 2019Feb25 on the same seven: MP12 within 0.87–1.06 and MP21 within 0.98–1.21.
  - On ABMF, a station not used for fitting: GLONASS, BeiDou and SBAS within 10 % of Anubis, GPS about 20 % low and Galileo about 20 % high. teqc MP12 is 0.82× and MP21 0.96×.
  - Clean satellites match to the centimetre. The spread comes from how each tool handles a few satellites' slips and outliers, which isn't documented for either.

## 2.27.0

### Changed — PPP is 1.8× faster (`positioning`)

`solvePpp`'s Kalman filter updated its full covariance for every observation, although each observation touches only position, clock, tropospheric delay and one ambiguity out of ~100 states. It now works from those entries and updates one triangle of the (symmetric) covariance: a 24-hour, 30-second multi-GNSS day goes from 1.06 to 0.59 s, with the same position to 0.01 mm. Campaign processing in gnsscalc spends most of its computing time here.

## 2.26.2

### Fixed — no multipath for GPS IIR satellites (`analysis`)

Multipath took one code per band for each constellation, chosen from the header's declared types: L2C (`C2L`/`L2L`, or `C2` in RINEX 2) where a file declared it. The seven GPS IIR satellites (G02, G13, G16, G19, G20, G21 and G22) don't transmit L2C, so they had no L2 code and got no multipath at all. That's about a fifth of GPS on every station.

Each band now has a ranked list of codes (`buildObsCandidates`), and every satellite uses the best one it carries; IIR satellites fall back to P(Y) (`C2W`/`P2`). Satellites that carry the preferred code keep identical values.

- ABMF: GPS MP1 now uses 24 898 points instead of 19 469 (25.65 → 25.27 cm).
- INAB: 24 856 points instead of 19 414 (5.86 → 5.91 cm).

Cycle slips and the ionosphere still take one code per band. Their per-satellite fallback is a separate change.

## 2.26.1

### Changed — QC accumulators about 20 % faster (`analysis`)

The masked QC pass over a 1 Hz day (WTZR 2026/314, 3.55 M satellite-epochs) went from 20.0 s to 15.9 s, with results identical to the bit on that day and on a 30 s day.

- **Multipath:** the step test took the median of the last five MP values by copying and sorting them with a comparator for every MP point. It now uses a small in-place insertion sort.
- **Cycle slips:** each satellite's state is two reusable buffers swapped every epoch, instead of seven new Maps per observation. The Melbourne-Wübbena window shifts in place, with its sums in the same order as before. Signal labels and keys are built once per system.
- **Signal profile, loss of lock and clock jumps:** keys are cached per code list, there is no Map per observation, and the jump median uses a typed-array sort.

## 2.26.0

### New — `EpochSats`: one block per epoch, half the memory (`rinex`)

`CompactEpoch.sats` was a `Map<string, Float64Array>`, so every satellite in every epoch had its own typed array. On a 1 Hz day (WTZR 2026/314, 3.55 M satellite-epochs) those small arrays cost about 1 GB on top of 0.5 GB of values.

- **`EpochSats`** stores an epoch's PRNs and slot offsets in two small arrays, and all of its values in one `Float64Array`. It has the Map interface the readers and writers use: `get`, `has`, `set`, `delete`, `keys`, `values`, `entries`, iteration and `size`.
  - `set` copies the values in, and `get` returns a view into the block.
  - `compact()` trims a finished epoch; `compactEpochSats(sats)` does it only for an `EpochSats`.
- **On the WTZR day:** 1 537 → 799 MB, peak 1 616 → 892 MB. Parse and QC times are unchanged, and the QC results are identical.
- **`CompactEpoch.sats` is now typed as `SatValues`,** the Map subset above. A `Map` still satisfies it, so existing code that builds epochs from Maps is unaffected. Code that read `sats` and called a Map-only method, such as `forEach`, needs `[...sats]` or a loop.

## 2.25.1

### Fixed — u-blox receiver fix time was UTC (`ubx`)

`parseUbxPvt` built `timeMs` from NAV-PVT's UTC date fields, but `ReceiverPvt` times are GPS-scale everywhere else (SBF PVTGeodetic, NovAtel BESTPOS). A u-blox receiver's own fix sat 18 s early next to its measurements. The time now comes from the GPS iTOW, with the week taken from the date, including at a week boundary.

## 2.25.0

### New — receiver health (`sbf`, `ubx`, `novatel`)

What the receiver reports about itself: CPU load, temperature, uptime, antenna feed (OK / open / short / unpowered, plus voltage and current where measured), AGC and noise per RF front end, jamming state, detected interferers, and spoofing flags. `parseSbfHealth`, `parseUbxHealth` and `parseNovatelHealth` return one partial record per message. `summarizeReceiverHealth` folds them into the latest picture with an overall `ok` / `warning` / `error` level.

- **Septentrio:** ReceiverStatus (4014) and RFStatus (4092), per the SBF Reference Guide, including each interferer's estimated power and a flag for a front end whose PLL is not locked. Validated on TU Delft's PolaRx5 TUDB: 32–49 % CPU, 52 °C, eight front ends with 20–27 dB AGC gain, and a latched software-error bit.
- **u-blox:** MON-HW, MON-RF and MON-SYS. MON-RF replaces MON-HW's single L1 row when both are logged.
- **NovAtel:** HWMONITOR, RXSTATUS and ITDETECTSTATUS (centre, bandwidth and power of each interferer, per antenna).

Only conditions the receiver itself flags become warnings or errors; there are no invented thresholds. No public u-blox or NovAtel capture carries these messages, so those two decoders are tested on frames built from the manuals: MON-HW from the u-blox M8 spec, MON-RF and MON-SYS (F9 only) from pyubx2, NovAtel from the OEM7 manual's own examples.

## 2.24.0

### New — loss-of-lock indicators from RINEX and Hatanaka (`rinex`)

- **LLI per observation.** `parseRinexStream`'s per-satellite callback gets a fifth argument, the loss-of-lock indicator of each value (`null` when blank), for RINEX 2, RINEX 3 and CRINEX 1/3. In Hatanaka files the flags are a per-satellite diff string. A satellite missing from the previous epoch starts again from blank, and in CRINEX 1 a blank data field also clears its flags, as `crx2rnx.c` does.
- **Checked against CRX2RNX.** On two full days the flags match CRX2RNX 4.2.0 exactly: SUR4 2026/308 (CRINEX 3) has 35 460 and INAB 2025/178 (CRINEX 1) has 6 614, with 0 differences. Slices of both are pinned in the tests.
- **`CompactEpoch.lli`** (optional) keeps the flags in memory alongside the values.

### New — QC diagnostics (`analysis`)

- **`LossOfLockAccumulator`.** Per band, it counts phase observations with LLI bit 0 (lock lost) and bit 1 (half-cycle). Bit 2 is ignored: it marks anti-spoofing in RINEX 2 and BOC tracking in RINEX 3, both routine. Each band is counted once per epoch, so L2L + L2W is one carrier. The result reports `available: false` when the source carried no LLI. `QualityResult.lossOfLock` holds the result.
- **Per-satellite table (`QualityResult.satellites`).** One row per satellite with:
  - its elevation range;
  - grid samples expected above the mask and how many were tracked;
  - slipped epochs and lost locks;
  - code multipath RMS per band (all arcs pooled);
  - mean C/N0 per band.
- **Untracked stretches (`TrackingResult.untracked`).** Every stretch of at least 2 minutes that a tracked satellite spent above the mask without being tracked, with its elevation and azimuth range, longest first. On ABMF this list shows GLONASS lost low in the north-west, an obstruction lower than the sky grid can detect.
- **Short gaps (`ContinuityResult.shortGaps`, `shortGapCount`, `shortGapSec`).** Gaps of two or more missing epochs that are shorter than the 10-minute long-gap limit.

## 2.23.1

### Fixed — SBAS satellites from RTCM named S120 instead of S20 (`rtcm3`)

The MSM (1101–1107) and 1043 decoders named SBAS PRN 120 `S120`. Everything else, including the other decoders, the SBAS engine and the RINEX parser, uses the RINEX form `S20`, as QZSS PRN 193 is `J01`. The four-character ID shifted every column of a RINEX observation line written from such a stream, and RTCM SBAS satellites didn't match the same satellites from other sources.

## 2.23.0

### Fixed — the jump search found steps in plain flicker noise (`analysis`)

`fitCoordinateSeries` searched for unannounced steps with a BIC that assumes white noise. GNSS coordinate series carry flicker noise, and under it the search found two or three steps in every simulated five-year series, each one bending the velocity. A candidate step must now also be significant under the white + flicker noise model: χ² > 20 over East, North and Up, with the flicker share fitted without the step (`jumpChi2` to change it; off with `noiseModel: false`).

On HOFN (Höfn, Iceland), 2021–2026, every fifth day, the old search placed three steps that neither EPN's repro3 series nor the Nevada Geodetic Laboratory's show; the new one places none, and the East velocity moves from 15.19 to 14.72 mm/yr. Simulated 5 mm steps are still found every time. Fits take about 1 s longer on five years of data.

## 2.22.0

### New — RTCM3 encoding: any receiver as a reference station (`rtcm3`)

The other direction from the decoders: receiver epochs and ephemerides in, an RTCM3 stream out, as `str2str -out …#rtcm3` does.

- **`RtcmBaseEncoder` / `receiverToRtcm3`.** Takes epochs from any receiver decoder (UBX, SBF, NovAtel, Trimble, BINEX) and their ephemerides, and returns framed messages in stream order. Station messages go out on a cadence, and each satellite's ephemeris whenever the one nearest in time changes.
- **MSM1–7** (`MsmEncoder`) for GPS, GLONASS, Galileo, BeiDou, QZSS, NavIC and SBAS. It splits a system across messages at 64 cells and tracks lock arcs: a receiver-reported slip, lock time that grows less than the time elapsed, or a missed epoch restarts the arc, and the lock indicator always drops so rovers see the slip.
- **Station and ephemeris messages:** 1005/1006, 1033 and 1230 (with a new 1230 decoder), plus all eight ephemeris types. `ephemerisToInfo` converts a receiver-decoded `Ephemeris` for them.
- **Checked against real data.** Re-encoding the DLF100 (Trimble) capture reproduces all 430 MSM7 messages and every 1006, 1033, 1230 and ephemeris message bit for bit. The WHU OEM719 base sent through MSM7 gives the same static RTK baseline as the raw log, within 0.5 mm (MSM3 within 5 mm). RTKLIB `convbin` decodes the stream to the same observations as its own NovAtel and u-blox readers.

### New — legacy observations 1001–1012 and antenna descriptor 1007/1008 (`rtcm3`)

For rovers, radios and machine-control systems that predate MSM.

- **`LegacyObsEncoder`.** Encodes all eight legacy types: GPS 1001–1004 and GLONASS 1009–1012, L1 or L1+L2, basic or extended. Lock-arc handling is shared with the MSM encoder, so slips reach rovers the same way. `RtcmBaseEncoder` gains `obs: 'legacy'`, which sends 1004 + 1012 (variant via `legacy`) and adds 1007/1008 to the station messages.
- **`encodeAntennaDescriptor`.** Sends 1007, or 1008 when a serial number is given. Older rovers read the antenna name from these rather than 1033.
- **Checked against RTKLIB.** The WHU OEM719 base as 1004/1012 decodes in RTKLIB `convbin` to the same GPS and GLONASS L1/L2 observations as its own NovAtel reader: code to the format's 2 cm step, phase within 0.002 cycles, and every slip flag after the first epoch.

### Changed — legacy obs decoding (`rtcm3`)

- **L2 code.** DF016 now maps 0/1/2/3 to 2X/2P/2D/2W, as RTKLIB does, instead of 1–3 all becoming 2W.
- **No phantom L2.** An L2 with both pseudorange and phase flagged invalid is no longer emitted as an empty signal.
- **GLONASS day.** 1009–1012 carry only the time of day. The day is now the one nearest `ObsDecodeOptions.refTimeMs` (default now), which also fixes epochs a day off for a few seconds around Moscow midnight in live streams; set it when replaying old captures.

### New — u-blox GLONASS frequency channel (`ubx`)

`UbxMeasurement.gloChannel` is RAWX `freqId − 7`, so GLONASS phase has a wavelength without an ephemeris.

### Fixed — GLONASS 1020 τc, N4 and τGPS were misread (`rtcm3`)

The decoder skipped the 11-bit N^A field, so these three were read from the wrong bits whenever the additional-data flag was set: DLF100 read τc as −15.6 ms instead of 6 ns, and N4 as 0 instead of 8. The 1020 flag bits (P1–P3, P, ln, almanac health, N^A) are now returned too.

### Fixed — GLONASS channel −7 lost phase in MSM5/7 (`rtcm3`)

DF419 = 0 is channel k = −7, not "unknown", so those satellites lost phase and Doppler. Values 14/15 (unknown) no longer set the channel to 7 or 8.

### Fixed — NovAtel RANGE: GLONASS channel off by one, QZSS dropped (`novatel`)

- **GLONASS.** RANGE reports channel + 7, but the decoder subtracted 8, so every GLONASS channel was one low. That gave GLONASS the wrong wavelength for anything using `gloChannel`, such as RTK on NovAtel logs.
- **QZSS.** QZSS PRNs arrive as 193+ (RANGE and RANGECMP) and were discarded; they now map to J01+.

## 2.21.0

Both changes come from a field check of 13 Baltic and Russian reference stations over a week.

### Changed — tracking counts satellites the receiver tracks (`analysis`)

Tracking above the mask, and the sky grid behind the horizon, now count only satellites the receiver tracked at some point that day. Satellites it never locks are beyond the receiver, not a fault of the site:

- **Firmware limits.** Firmware without the newest BeiDou-3 PRNs (C41–C46 at ABMF; PULK's Trimble BD990) read as 78 % BeiDou tracking and as a phantom eastern "obstruction".
- **Regional systems.** This generalises 2.20.0's rule for NavIC, QZSS and SBAS.

Such satellites are still listed in `neverTracked`, and obstructions, outages and interference still show, because satellites move through them.

### New — tracking per timeline bin (`analysis`)

`tracking.timeline.percent` is the tracked share across all satellites per time bin, so lost _time_ (an outage, interference) can be told from lost _directions_ (an obstruction). PULK in St Petersburg tracks 9–18 % from 00 to 02 UTC and from ~25° all round, which isn't trees.

## 2.20.0

### Fixed — tracking expected regional satellites a receiver can't see (`analysis`)

NavIC, QZSS and SBAS satellites are now expected above the mask only if the receiver tracked them at least once. Their satellites rise over much of the world without being receivable there, so a European station tracking a few NavIC satellites was charged for all of them: WTZR went from 95.7 to 98.0 %, and stopped flickering to Marginal on 95 % days. GPS, GLONASS, Galileo and BeiDou are still expected in full, so a never-tracked satellite still counts.

## 2.19.0

### New — site diagnostics: horizon, multipath by direction, antenna C/N0 (`analysis`)

Beyond pass/fail, _why_ a site behaves as it does:

- **`tracking.sky`.** Expected vs tracked samples per 10° azimuth × 5° elevation cell. From it, the **horizon** per azimuth (where tracking starts), the receiver's own cut-off (the median, the same all round) and **obstructions** (sectors ≥ 10° above it). On ABMF it finds the low eastern sector (80–90°, up to 30°).
- **`multipathSky`.** Code-multipath RMS of every signal pooled per 30° × 10° cell, with the site's median and the worst cell above 15°. Multipath comes from reflectors, so a bad sector points at the wall, roof or mast.
- **C/N0 by elevation** per signal (`signals.cn0ByElevation`, 5° bins), and **`compareCn0WithTemplate`** against `CN0_TEMPLATE`. The template is built from eight healthy geodetic stations (Septentrio and Leica), which sit within ±3 dB of it above 30°. A failing antenna, LNA or cable costs ≥ 6–10 dB on every signal: a 9 dB loss injected into ABMF reads −9 dB.
- `ElevationModel.azElDeg` returns azimuth too, interpolated the short way round north.

## 2.18.0

### New — elevation-masked QC and above-mask tracking (`analysis`)

- `QualityAccumulator` runs the four QC accumulators (cycle slips, multipath, completeness, ionosphere) behind one observation callback, with an optional elevation mask in front. Run two side by side for masked and unmasked results from one parse; `analyzeQuality` takes the same options as a fifth argument.
- `ElevationModel.create(ephemerides, rxPos)` gives satellite elevations from broadcast orbits. It samples every 5 min and interpolates, about 10× cheaper than an orbit per observation, and agrees with exact elevations to the 0.01° level. It returns null without a usable receiver position.
- `TrackingAccumulator` / `QualityResult.tracking` compare the satellite-epochs the orbits put above the mask (healthy, valid ephemeris) with those tracked on carrier phase, per system and dual-frequency. Only systems the receiver recorded are expected. This is the teqc/Anubis "% of expected observations above the mask" metric.
- `QualityResult` gains `maskDeg`, `belowMask` and `tracking`.

### New — clock jumps, continuity, tracking timeline, signal profile (`analysis`)

The teqc/Anubis checks /qc lacked. All come out of `QualityAccumulator`, which now buffers one epoch at a time (parsers deliver epoch by epoch):

- **`clockJumps`.** Receiver clock resets (teqc "Rx clock offsets", Anubis `nJmp`): code minus phase stepping by the same amount on ≥ 70 % of satellites in one epoch, reported in ms. Whole-millisecond resets are removed from the pseudoranges before the other checks run. Otherwise a 1 ms reset (≈ 300 km) reads as a cycle slip on every satellite. A 1 ms reset injected into a real day is found, and slips and multipath come out identical.
- **`continuity`.** Expected vs present epochs, gaps > 600 s and short pieces < 1800 s (Anubis defaults), repeated epochs, duplicated satellites, usable epochs (≥ 4 satellites with dual-frequency code and phase), and the most satellites seen in one epoch.
- **`tracking.timeline`.** Per satellite and time bin (≤ 96 bins), the samples expected above the mask, those tracked, and those tracked below the mask or without nav: teqc's ASCII time plot as data. Also `neverTracked` and `withoutNav`.
- **`signals`.** Observations per signal above 0/5/10/15/20/30/50/70° (Anubis "Ele>N"), and C/N0 mean ± sd per signal above the mask (teqc "Mean S1 S2").

### New — ionospheric activity (`analysis`)

`IonoResult.activity` reports how disturbed the ionosphere was, apart from cycle slips. It's space weather, not a receiver fault:

- **`events`:** epoch pairs whose L1 ionospheric delay changed faster than teqc's IOD-slip threshold (400 cm/min), per system. Epochs the slip detector confirmed as slips are excluded. teqc counts both as "IOD slips": on ABMF, our events plus our slips (160) match its 159.
- **`roti`:** the rate-of-TEC index (standard deviation of the 30 s rate of TEC in 5-min windows), as p50/p95/max and the share of windows above 0.5 TECU/min.

SBAS is left out: GEO carrier phase jumps every few dozen epochs at every station.

### Changed — fewer false cycle slips (`analysis`)

Three changes to the Melbourne-Wübbena (MW) and single-frequency detectors, each found by comparing with teqc and Anubis:

- **Persistence.** A jump is a candidate until the next epoch shows the new level persists; a one-epoch code outlier returns and is dropped.
- **Sliding reference.** MW is compared with the mean of the last 30 epochs instead of the whole arc, so slow MW drift from long-period code multipath no longer accumulates into a "slip" hours into an arc.
- **Phase confirmation.** A real wide-lane slip moves the phase-only geometry-free combination too (a 1-cycle L1 slip moves it 19 cm). A candidate MW step now needs a ≥5 cm geometry-free jump unless it is ≥3 cycles. A code shift without a phase jump is followed as a new level, not counted.

On clean stations above 10° (GPS + GLONASS), slips now match teqc: BRUX 3 against teqc's 0, ONSA 2/2, WTZR 0/0, ZIM2 9/8. Unmasked, BRUX went from 425 to 27 a day. Slips are reported at the jump epoch, but the `onSlip` callback fires one epoch later, so a slip on an arc's very last epoch can't be confirmed.

`CycleSlipResult` gains `slipEpochs` / `testedEpochs`: distinct satellite-epochs, so one slip seen by two MW pairs counts once (teqc's obs-per-slip sense). It also gains `perSystem` with the same counts by constellation.

### Validation — against teqc 2019Feb25 and G-Nut/Anubis 3.11

Seven IGS/EUREF daily files (ALIC BRUX KOUR MAS1 ONSA WTZR ZIM2, 2026/313) plus the ABMF fixture, with the day's BRDC:

- **Tracking above 10°** is within ~1 point of Anubis "%Rt>10" wherever both count the same systems.
- **Multipath** is within ±20 % of Anubis mpX for GPS, Galileo and BeiDou. Anubis averages every code on a band with a moving RMS; ours sigma-edits each arc.
- **Slips:** the constellation ranking matches Anubis. Above 10°, they match teqc's on clean stations. teqc also counts ionospheric-rate events as slips, which we don't: 159 of its 169 on ABMF.
- **teqc** (GPS + GLONASS L1/L2, via RTKLIB convbin to RINEX 2.11): dual-frequency tracking above 10° is within 1 point of teqc's "complete obs" (ABMF 92.8 vs 92.6 %). Our multipath reads 0.4–1.0× teqc's MP1/MP2, which use the C/A code and a moving average.

`test/qc-oracles.test.ts` pins the ABMF numbers for both tools.

## 2.17.0

### New — plate motion: move ITRF2020 coordinates between epochs (`frames`)

`transformFrame` changes the frame at one epoch; points on the ground also move within ITRF with their plate, a few centimetres a year. Two new functions handle that:

- `plateVelocity(xyz, plate)` — the horizontal ITRF2020 velocity of a point riding one of the 13 plates of the ITRF2020 plate motion model (Altamimi et al. 2023), including the origin rate bias. The model's vertical rates are discarded, as its authors advise. Poles and bias are exported as `ITRF2020_PMM` and `ITRF2020_PMM_ORB`.
- `propagatePosition(xyz, velocity, fromEpoch, toEpoch)` — linear propagation with that velocity, or with a known one (a SINEX station velocity, a campaign estimate).

Which plate a point is on is left to the caller; gnss-js ships no plate boundaries.

Validation against 332 IGS20 station velocities, each assigned its plate from Bird's PB2002 boundaries: the 297 on the model's 13 plates fit with a median horizontal misfit of 0.71 mm/yr, and 77 % within 2 mm/yr. The misfits above that are deforming zones (Tibet, Chile, California, Japan, the Solomon Islands), where no rigid plate applies. The other 35 are on plates the model doesn't have (Sunda, Yangtze, Okhotsk, Philippine Sea, Anatolia, …).

## 2.16.0

### Fixed — RTK across receiver makes: Galileo dropped, BeiDou biased (`positioning`)

- **Galileo.** It was only differenced when both receivers logged the same E1 attribute. Leica logs E1C and Javad E1X, so mixed pairs silently lost Galileo. Both are accepted now, and a base/rover pair on the same band is differenced: RINEX 3.01+ aligns carrier phases on one frequency.
- **BeiDou.** BDS-2 and BDS-3 now have separate reference satellites (signal group `C2I3`). A receiver-make dependent bias between the generations doesn't cancel across them: at Wettzell (Leica against Javad, 1.6 m) the float baseline was 28 mm off in East with them together, and within 2 mm with either generation alone. Fixed BeiDou solutions between these makes still show about 1 cm in Up, so static millimetre work should use GPS + Galileo.

Validation, Wettzell 2024-015 (WTZR→WTZZ, 1.6 m, fixed, against EPN weekly coordinates): GPS −0.9/1.2/−0.9 mm and GPS + Galileo −0.7/0.8/−1.4 mm (E/N/U).

### Fixed — RTK dropped the antenna height of an uncalibrated antenna (`positioning`)

With `antenna` configured, a receiver whose antenna type wasn't in the model had its marker→ARP offset (`deltaEnu`, the antenna height) ignored along with the missing PCO/PCV. The solution then put the marker at the antenna, centimetres to metres off on a tripod. The offset now always applies, and only PCO/PCV need a calibration.

### New — baseline network adjustment (`analysis`)

`adjustBaselineNetwork(fixed, baselines)` adjusts one session's static GNSS baselines by least squares, as Bernese and survey software do. It returns:

- the free points' coordinates and covariances;
- the a-posteriori variance factor σ̂₀² with a χ² test;
- a w-test on every baseline component, with data snooping that drops the worst failing baseline as long as every point stays connected;
- the misclosure of each independent loop, in mm and ppm (also available alone as `loopMisclosures`).

The w-test scales normalised residuals by their robust spread, so a blunder can't hide behind the σ̂₀² it inflates, and the 5× optimistic formal covariances typical of GNSS don't trigger mass rejection. Coordinate covariances are rescaled by σ̂₀² when it exceeds 1. `chi2Quantile` and `normalQuantile` are exported.

### New — session baseline and fixed covariance from RTK post-processing (`positioning`)

`postProcessRtk` now returns `final`, the session's static baseline: the last ambiguity-fixed epoch (else the last float one) with its covariance. RTK solutions carry `covariance`; when fixed, it's the covariance given the integers, P_xx − P_xb·Q_b⁻¹·P_bx.

### New — Unix compress (.Z) support (`rinex`)

`parseRinexStream` now reads `.Z` files directly; it used to reject them with "Please decompress first". GNSS archives stored daily files that way until about 2020 (`wtzr0010.20d.Z`: Hatanaka, then compress). `uncompressLzw` and `isUnixCompress` are exported. The decoder is a port of the BSD/ncompress reader and is byte-identical to the system `uncompress` on a 9.9 MB Hatanaka file, 3 MB of random data (16-bit codes, table clears) and a real 2016 IGS archive file.

### Fixed — static PPP-AR reported float when the last attempt failed (`positioning`)

`solvePpp(..., { ar })` took the ambiguity-fixed position from the final fixing attempt only. A static Brest session fixed at 80% of its epochs over 2 hours, and 38% over 24 hours, still came back float because its last attempt didn't pass. Static sessions now fall back to the most recent accepted fix; kinematic sessions keep the end-only rule. The new `ar.positionEpochMs` says when that fix was. Against Brest's IGS20 coordinates (2024-015, CNES products), the 2-hour Up error went from 33.0 mm (float) to 21.9 mm and the 24-hour one from 1.3 to −0.1 mm. East and North are unchanged or better.

### New — `parseRinexHeaderText` (`rinex`)

Reads a RINEX observation header (2/3/4, including Hatanaka) from its leading text alone: marker, antenna and radome, antenna offsets, receiver and first epoch. This lets you review an occupation without parsing the observations.

### Fixed — clustered known jumps made the fit fail (`analysis`)

Known jumps with no sample between them, such as an earthquake sequence falling between two monthly days, are indistinguishable. Before, they made the fit singular and `fitCoordinateSeries` returned null. They now merge into one step, keeping the first.

### Fixed — outlier test rejected good days in short series (`analysis`)

`fitCoordinateSeries` dropped good days far too often on short series. It recomputed the robust scale from the surviving days after each rejection, so the scale shrank and the rejections cascaded. On clean simulated 12-day series it dropped a day in 14% of them; 2% of all days were flagged where a 4σ test should flag about 0.02%. The scale now comes from every residual, corrected for the fitted parameters and floored at half the median formal σ. The threshold grows with the 3n component tests (at least `outlierK`), and series with under 6 degrees of freedom keep every day. Clean 12-day series now lose a day 1% of the time, and a 3 cm vertical blunder is still caught 90% of the time (95% before).

## 2.15.0

### New — SINEX writer and reader (`rinex`)

`writeSinex` writes a SINEX 2.02 station solution: SITE/ID, SOLUTION/EPOCHS, SOLUTION/ESTIMATE (STAX…VELZ) and a block-diagonal SOLUTION/MATRIX_ESTIMATE. That is the format IGS, EUREF and agencies exchange coordinates and velocities in. `parseSinexEstimates` reads any SINEX file's position and velocity estimates; it reads all 1,401 solutions of IGS's IGS20.ssc. `fitCoordinateSeries` components now also report `offsetSigma`.

## 2.14.0

### New — GPT3 + VMF3 troposphere (`troposphere`)

A new `gnss-js/troposphere` entry implements GPT3 and VMF3 (Landskron & Böhm 2018) on TU Wien's grid (VMF Data Server, CC BY 4.0). GPT3 is an empirical 5° climatology of pressure, temperature, humidity, mapping coefficients and gradients. VMF3 provides the mapping functions, with degree-12 empirical b/c coefficients and the Niell height correction.

- `parseGpt3Grid`, `gpt3` and `vmf3`;
- `saastamoinenZhd`;
- `createGpt3Troposphere(grid)`, which plugs into the PPP engine through the new `PppOptions.troposphereModel` (a-priori ZHD from GPT3 pressure, VMF3 mapping, GPT3 gradients).

Niell with the standard atmosphere stays the default. Over 24-hour and 2-hour PPP at WTZR (42 days) and BRST (24 days), GPT3 + VMF3 did not change the height scatter beyond noise, because the estimated wet delay absorbs the a-priori differences.

### New — ocean tide loading (`positioning`)

`createPppCorrections({ oceanLoading })` applies a station's ocean tide loading displacement, given its BLQ coefficients (the Onsala service's format). `parseBlq` reads BLQ files and `oceanLoadingEnu` synthesises the displacement from the 11 main constituents with IERS astronomical arguments, as RTKLIB does. At Brest (M2 radial 4.2 cm), over 24 monthly days of 2-hour PPP sessions, it cut the height bias from 25.4 to 5.1 mm and the height scatter from 53.9 to 17.9 mm. Full-day solutions barely change (the loading averages out), as expected.

### New — realistic velocity uncertainties (`analysis`)

`fitCoordinateSeries` now also fits a white + flicker noise model by maximum likelihood (new `fitWhiteFlicker`, the CATS/Hector approach), giving each component `velocitySigmaRealistic` and `flickerShare` alongside the white-noise `velocitySigma`. GNSS position series carry flicker noise, which white-noise errors ignore. In a Monte Carlo of 60 weekly 4-year series with flicker, the realistic sigma averaged 0.538 mm/yr against an actual velocity scatter of 0.543 mm/yr; the white-noise sigma averaged 0.134 mm/yr, 4× too small. Series longer than 360 samples are thinned for the full-covariance fit. `noiseModel: false` skips it.

### New — network alignment (`analysis`)

`estimateHelmert(from, to, opts)` estimates the transformation that maps one day's solutions of reference stations onto their known coordinates. It is robust: the worst reference is dropped while any residual exceeds `maxResidualM` (1.5 cm). Two models are available: `'translation'` (regional networks) and `'similarity'` (7 parameters, centred for conditioning). `applyHelmertFit` applies the result to every station of the day. This is the daily datum definition / common-mode removal of network GNSS processing.

### New — station coordinate time series (`analysis`)

`fitCoordinateSeries(samples, opts)` turns a station's position solutions (e.g. daily PPP) into the standard trajectory model:

- an offset and a velocity per local East/North/Up component;
- steps at given jumps (antenna changes, earthquakes);
- annual and semi-annual terms, automatically once the span reaches two years;
- weights from the daily formal errors.

Outliers are rejected iteratively against a robust scale (1.4826 × MAD). Further jumps can be found by a greedy BIC search. It reports velocities with white-noise formal errors scaled by the variance factor, step sizes, seasonal amplitudes, the WRMS, and per-point model values and outlier flags.

On 42 monthly daily PPP solutions of WTZR (2023–2026) it recovers the IGS20 velocity to 0.09 / 0.03 / 0.5 mm/yr (E/N/U), with a WRMS of 2.1 / 1.4 / 5.0 mm.

## 2.13.1

### Fixed — PPP with receivers whose clock drifts (`positioning`)

The PPP engine timed each satellite's emission from the geometric range alone, ignoring the receiver clock offset. Receivers that let their clock drift up to a millisecond before stepping it (Septentrio by default, some Javad models, free-running phone clocks) therefore had satellites placed up to a millisecond off. Through Earth rotation that is up to ~10 cm of East error, varying from day to day with the clock state. The emission time now comes from the pseudorange (reception − P/c − satellite clock, as RTKLIB does), which carries the receiver clock with it.

- IGS station GRAZ (PolaRx5) went from 11 cm off its IGS20 coordinate to 2–9 mm, with GPS, Galileo and BeiDou now agreeing.
- ABMF (PolaRx5) lands within 3 / 6 / 7 mm (E/N/U) of IGS20. Its old test anchor of "0.54 m East" was this bug, not plate motion.
- Steered-clock receivers are unaffected.

## 2.13.0

### New — Android raw GNSS logs (`android`)

A new `gnss-js/android` entry reads the text logs Google's GnssLogger app writes from `android.location.GnssMeasurement`: `parseAndroidGnssLog(text)` returns measurement epochs in the same shape as the receiver decoders (`prn`, RINEX `code`, pseudorange, carrier phase, Doppler, C/N0, a half-cycle flag and a lock time that restarts at cycle slips), the phone's own `Fix` positions and the device line; `isAndroidGnssLog` detects the format.

- **Signals:** GPS, GLONASS, Galileo, BeiDou, QZSS, NavIC and SBAS, on L1/E1/B1C, B1I, L5/E5a/B2a, E5b and E6. The tracking attribute comes from the `CodeType` column when present, otherwise from the band.
- **Pseudoranges:** reconstructed as Google's gps-measurement-tools and Rokubun's android_rinex do.
  - Reception time is the hardware clock minus `FullBiasNanos + BiasNanos`. The bias is held per hardware-clock segment, so code and phase stay on one clock.
  - Transmission time comes from `ReceivedSvTimeNanos` in each system's time scale: GLONASS time of day in UTC+3 h, BeiDou BDT = GPS − 14 s.
  - The arithmetic is in integer nanoseconds, because these clock values exceed what a double holds exactly.
- **Filtering:** only code-locked measurements with a resolved time of week (time of day for GLONASS) are kept.
- **Validation:**
  - Against Google's own numbers for its demo log: identical satellite-to-satellite pseudoranges (0.0 mm spread over 1,376 measurements).
  - Against Rokubun's converter on a Samsung S22 log (GPS/GLONASS/Galileo/BeiDou, L1+L5): all 8,101 pseudoranges within 4 cm (RINEX output rounding) and Doppler within 0.0005 Hz.
  - On a Pixel 8a, epoch-to-epoch code-minus-phase is 2.7 m median against Rokubun's 28.7 m, which computes the clock in floating point.

## 2.12.0

### New — Galileo OSNMA navigation message authentication (`osnma`)

A new `gnss-js/osnma` entry verifies Galileo's Open Service Navigation Message Authentication end to end, after the OSNMA SIS ICD v1.1. `OsnmaReceiver` takes E1-B I/NAV nominal pages (`pushPage`, live or batch; `verifySbfOsnma` runs it over a Septentrio SBF capture) and checks the whole chain of trust: the public key against the Merkle root (the GSC tree in force since 2025-12-10 and its PKID 2 key are built in; a key broadcast in DSM-PKR is accepted once its Merkle path verifies), the DSM-KROOT's ECDSA P-256 or P-521 signature, each TESLA chain key back to the root key, the MACSEQ and MAC look-up table, and the HMAC tags over every satellite's ephemeris, clock and status (ADKD 0 and slow-MAC 12) and GST timing parameters (ADKD 4), with tag accumulation to the Receiver Guidelines' 80/40-bit thresholds. Cross-authentication covers satellites that broadcast no OSNMA themselves. Chain renewal and revocation, public-key renewal and revocation, Merkle tree renewal and the Alert Message are followed. `status()` reports the NMA header, verified keys and chains, per-satellite authenticated IODnav and timing, and the events that matter — a tag that does not verify means the navigation data differ from what Galileo signed.

The cryptography is synchronous and dependency-free (SHA-256, SHA-512, HMAC-SHA-256, ECDSA P-256/P-521 in BigInt), checked against NIST examples and `node:crypto`.

Validated on the 19 official ICD test-vector scenarios: zero false failures; 14 match the authenticated-tag counts of the reference implementation OSNMAlib exactly, one is off by a single tag, and four differ only in how tags around "don't use" periods are counted. On live TU Delft receivers the PKID 2 key, a broadcast DSM-PKR, the KROOT and every tag verify; altering one satellite's ephemeris word, or one TESLA key, is caught.

### Fixed — centimetre static PPP (`positioning`)

Static float PPP now lands within **0.5–0.8 cm 3D of the true ITRF2020 coordinate** after 24 h on all seven IGS stations tested (ANMG, ALIC, WTZR, KOUR, HOB2, DRAO, MATE, 2024-001, ESA MGEX 5-min products, truth from ESA's daily SINEX); a median of 1.3 cm after 6 h, 3.4 cm after 2 h and 3.7 cm after 1 h. Before, 24 h runs were 9–42 cm off. Kinematic PPP, which was metres to tens of metres off per epoch, now tracks a static station at 1.5–2 cm horizontal (median per epoch, 95% within 4–5.5 cm) once converged. Five model errors were behind it:

- `ecefToGeodetic` returns radians, but the PPP corrections, the PPP troposphere latitude and the RTK receiver-antenna correction converted its output from degrees, so receiver antenna offsets, antenna heights and wind-up were applied in a wrong local frame (and Niell mapping used latitude ≈ 0).
- Phase wind-up used the receiver dipole's East axis where the model (Wu et al., RTKLIB `windupcorr`) uses West: a sign error that biased the horizontal by up to 15 cm.
- The ANTEX validity dates written by `parseAntex` were not understood by the PPP antenna model, so every GPS satellite got the phase-centre offset of the _first_ spacecraft that ever used its PRN (e.g. a 1978 Block I for G04), a GPS-only vertical bias of several centimetres.
- Within an epoch, each satellite's innovation reused the range computed at the predicted position, ignoring how far the preceding sequential updates had already moved the estimate. Harmless once a static solution has converged, it made every kinematic epoch (and every static start-up) re-apply corrections already made, so the estimate drifted and oscillated. Ranges are now linearised about the current state.
- Ambiguities were re-initialised whenever a phase innovation exceeded 15 cm, which also fired while the epoch's receiver clock was still settling, chopping arcs and keeping the solution code-dominated. Static mode now detects cycle slips with a clock-free time-differenced carrier-phase test (plus Melbourne–Wübbena), re-initialises only after three consecutive gated-out phases, and screens gross code outliers against each constellation's median first. Kinematic mode applies all code updates before any phase, and its time-differenced test fits the receiver's own displacement (a carrier-phase velocity) first.

Side effect for PPP-AR: arcs long enough for narrow-lane FCB estimation rose ~9× (GPS 32 → ~300 on the six-station test network; BeiDou now contributes ~200). `PppSolution.llh` is now in degrees as documented (it was radians).

### New — PPP with integer ambiguity resolution (`positioning`, `rinex`)

`solvePpp` / `PppEngine` can now fix the carrier-phase ambiguities to integers (PPP-AR) with an integer-clock product: pass the product's satellite code and phase biases as `osb` (a `SatOsbTable` built from a Bias-SINEX file) and set `ar: true`. The engine then applies the biases to every observation, and every two minutes resolves the converged ambiguities. The wide-lane is rounded from Melbourne–Wübbena, the narrow-lane is resolved with LAMBDA (both between satellites of the same constellation), and accepted fixes give an ambiguity-fixed position (`PppEpochResult.fixedPosition`, `PppSolution.ar`) next to the float one. A fix needs a ratio of ≥ 3, a bootstrapped success rate of ≥ 0.999 (new `LambdaResult.successRate`), at least five between-satellite ambiguities and float ambiguities consistent with the integers (χ²). Otherwise the epoch stays float. The float filter is never constrained, so a wrong fix cannot carry into later epochs.

Validated on seven IGS stations (2024-001, 1–4 h windows at six times of day, GFZ rapid orbits and 30 s clocks with CNES's code/phase biases from the PPP-Wizard archive, truth from ESA's daily SINEX):

| Session | Median horizontal error, float → fixed | Median 3D error, float → fixed |
| ------- | -------------------------------------- | ------------------------------ |
| 1 h     | 1.7 → 0.8 cm                           | 2.9 → 2.0 cm                   |
| 30 min  | 2.7 → 1.0 cm                           | 4.0 → 2.6 cm                   |

From 2 h on, float PPP is already at about a centimetre and fixing changes little.

Other changes:

- `PppSatObs.phase1` / `phase2` name the carriers when they differ from the code (GPS C1W with L1C).
- `PppEphemerisSource.phaseBias` lets a custom source supply phase biases.
- `SatOsbTable.get` falls back from a tracking mode to the band's combined `X` signal, as CNES publishes Galileo biases on `L1X`/`L5X`.
- `resolvePppAmbiguities` and `fixPppPosition` now difference within each constellation, with one reference per constellation (`ArResult.refPrns`, `ArFixedSat.ref`). Before, one reference spanned all systems, and the per-satellite wide-lane rounding kept the receiver's bias, so real multi-GNSS data could not fix.
- When a full fix fails, the resolver drops the lowest satellites and retries (partial fixing, `minPartial`).
- New `ArOptions`: `minSuccessRate`, `minFixed`, `maxChi2`.
- Code biases from a source (Galileo HAS) now correct the code observations themselves, so they reach the Melbourne–Wübbena slip detector consistently, not only the ionosphere-free code.

### Fixed — Hatanaka (CRINEX) decoding (`rinex`)

Compact RINEX files whose epochs change satellite count could decode with satellites shifted or invented: the epoch-line text repair dropped characters when a difference ran past the previous line, the satellite list was read beyond the epoch's satellite count, and the repaired line was not trimmed as `crx2rnx` trims it. Eleven IGS daily files (26 million observations) now decode identically to `crx2rnx` 4.2.0. Satellite ids written with a space (`G 2`) are normalised to `G02` in CRINEX, RINEX 3 and RINEX 2 observation files, so those satellites match precise orbits and broadcast ephemerides.

## 2.11.0

### New — BeiDou-3 B-CNAV ephemerides (`sbf`, `rinex`)

The BeiDou-3 civil navigation messages are now decoded: B-CNAV1 (B1C), B-CNAV2 (B2a) and B-CNAV3 (B2b). Septentrio's raw `BDSRawB1C` / `BDSRawB2a` / `BDSRawB2b` blocks (4218 / 4219 / 4242) are assembled into `BdsCnavEphemeris` records — ephemeris, clock, IODE/IODC, TGD/ISC group delays, health, integrity flags and accuracy indices — through `parseSbfBdsCnav` and the one-pass `decodeSbfNavigation` (new `bdsCnav` list and `counts.bdsCnavRaw`). The decoders are receiver-independent (`navbits/bds-cnav`: `BdsCnav1Assembler`, `BdsCnav2Assembler`, `BdsCnav3Assembler`) and work from the CSNO interface control documents (B1C, B2a, B2b v1.0).

RINEX 4 navigation files now read and write the matching `CNV1` / `CNV2` / `CNV3` records (`NavResult.bdsCnav`, `writeRinexNav4({ bdsCnav })`); they used to be skipped.

Validated against DLR's merged RINEX 4 broadcast file (BRD400DLR): every decoded orbit, clock, issue-of-data and group-delay field of 29 B1C/B2a/B2b ephemerides from a TU Delft receiver equals the published record. As with GPS CNAV, these records are decoded and exported; positioning still uses the D1/D2 ephemerides the same satellites broadcast.

## 2.10.1

### Fixed — compact-MSM stations in the stream census (`rtcm3`)

`updateStreamStats` now lists the satellites and signals of MSM1–3 streams (it only records presence, so their modulo-1-ms ranges need no resolving), instead of showing them as tracking nothing.

## 2.10.0

### New — compact MSM (MSM1–3) observations (`rtcm3`, `positioning`)

`decodeMsmFull` / `decodeObs` now decode MSM1 (code), MSM2 (phase) and MSM3 (code + phase) when asked to (`{ compactMsm: true }` — opt-in, so existing consumers keep getting `null` rather than incomplete ranges). These carry each satellite's rough range only modulo 1 ms (no DF397). Their epochs come back with `rangeModulo1ms: true`; `resolveMsmRanges(epoch, { timeMs, rxEcef, ephFor })` restores the whole light-milliseconds from an approximate position (tens of km is fine) and the broadcast orbit + clock, choosing them against the epoch's common receiver-clock offset so the epoch stays self-consistent. Validated on real MSM3 streams (GPS/GLONASS/Galileo/BeiDou, three stations): every satellite resolved, single-point solutions 3–5 m (median) from the stations' 1006 coordinates.

### Fixed — RINEX observation INTERVAL (`rinex`)

The observation writers declared `INTERVAL` as the gap between the first two epochs, so a file opening with an irregular gap (a late second epoch) stated the wrong interval. It is now the most common spacing between consecutive epochs (`modalIntervalS`).

## 2.9.0

### Fixed — ephemerides are only used inside their broadcast validity (`orbit`)

`selectEphemeris` and the batch position/visibility functions (`computeAllPositions`, `computeVisibility`) picked the nearest ephemeris within a flat 4 h (Keplerian) or 30 min (GLONASS/SBAS) of its toc. That let a GPS/QZSS ephemeris be used up to 2 h outside its 4-h curve fit, BeiDou up to 2.5 h past its hourly refresh, GLONASS up to 15 min outside its 30-min interval, and an SBAS GEO state vector ~24 min after it expires — and it measured GLONASS/SBAS distance on the GPS axis although their tocs are UTC (18 s off).

Selection now uses one per-system rule — GPS/QZSS ±2 h, Galileo 2.5 h, BeiDou 90 min, GLONASS ±15 min, NavIC 2 h, SBAS 6 min — with GLONASS/SBAS compared on the UTC axis. A satellite with no valid ephemeris at an epoch gets no position (`null`) there rather than an extrapolated one.

### New

- `isEphemerisValid(eph, tGpsMs)`, `nearestValidEphemeris(ephs, tGpsMs)` and the `EPHEMERIS_VALIDITY_MS` table, for consumers that select ephemerides themselves.

## 2.7.0

### Fixed — geodesy accuracy (`coordinates`)

Audited against independent exact references (numerical meridian-arc integration, Krüger/Karney transverse Mercator); every case below is now within 1 mm.

- **`rhumbLine` distance was off by up to ~0.5 %** (+559 m for 1° N–S at the equator, −2.6 km for 10° E–W at 45°N, +19 km across the antimeridian): it used one averaged meridional radius. Now exact on the ellipsoid via the meridian arc and isometric latitude, with a stable limit for near E–W lines. Bearing unchanged (it was already correct).
- **`greatCircleMidpoint` wasn't halfway**: a spherical formula on geodetic latitudes landed up to tens of km from the true halfway point on long lines. Now the geodesic midpoint (half the Vincenty distance along the initial bearing). Name kept for compatibility.
- **`geodeticToUtm` zones**: the Norway (32V) and Svalbard (31X/33X/35X/37X) exceptions are applied, and lon = +180° maps to zone 1 (was a non-existent zone 61).

### New

- `geodeticToUtm` also returns `band` (MGRS latitude band letter C–X) and `inRange` (false outside 80°S–84°N, where the returned values are computed at the clamped latitude and aren't a valid UTM position).
- `vincenty` returns `converged` — false for near-antipodal pairs, where the spherical fallback's bearings are unreliable.
- `vincentyDirect(lat, lon, bearing, distance)` — Vincenty's direct problem.
- `meridianArc(lat)` — meridian arc length from the equator (sub-mm series).

## 2.6.0

### New — zero-baseline / single-difference receiver comparison (`ZeroBaselineEngine`)

For receivers sharing one antenna (a zero baseline), between-receiver single differences cancel the geometry, satellite clock/orbit, atmosphere **and multipath**, leaving only the receiver terms — the opposite of what the double-difference RTK engine keeps. `ZeroBaselineEngine` (streaming `process`/`reset`, mirroring `RtkFloatEngine`/`PppEngine`) estimates, per epoch and per non-reference receiver:

- the **code relative clock** `c·Δdt` (robust per-system, datum-referenced), with **inter-system biases (ISB/IFB)** absorbed as offsets from the datum system — the interesting cut being between receiver _types_ on one antenna;
- a **phase-smoothed relative clock** — the time-differenced phase SD drops the constant ambiguity+bias, leaving `c·Δ(Δdt)`, integrated from the code-clock anchor (no ambiguity resolution needed for the clock trend / its Allan deviation);
- per-epoch used/rejected counts + code-SD residual RMS.

Consumes the existing `RawObservation` shape; GLONASS FDMA wavelengths handled for the phase clock (the constant FDMA IFB cancels in the time difference). Unit-tested on a synthetic zero baseline: recovers the relative clock to mm, the phase clock tighter, and the injected Galileo ISB to sub-cm. Requested by TU Delft (Hans van der Marel) for the Delft 8×DLF one-antenna rig; see `docs/zero-baseline-clock.md`.

## 2.5.0

### New — NavIC / IRNSS ephemeris

NavIC L5/S SPS navigation was counted but never decoded; it's now a first-class Keplerian ephemeris (`system` `'I'`), flowing through the same orbit/SPP/RINEX path as GPS, Galileo and BeiDou.

- **`navbits/navic.ts`** — IRNSS-SIS-ICD-SPS subframe 1 & 2 → `KeplerEphemeris`, with a streaming `NavicAssembler`. NavIC scale factors (Cuc..Cis 2⁻²⁸, Crc/Crs 2⁻⁴, Δn/Ω̇ 2⁻⁴¹), CRC-24Q over the first 262 bits. The assembler pairs only consecutive subframes and honours the alert flag — an unhealthy SV broadcasts a CRC-valid but non-physical orbit, so it's dropped rather than emitted.
- **SBF `NAVICRaw` (4093)** — `parseSbfNavic`, and wired into the one-pass `decodeSbfNavigation` (`counts.navicRaw`).
- **RTCM 3 message `1041`** — decoded (was labelled-only): the same NavIC element set as a flat message.

Validated on a 45-minute Septentrio DLF500 capture: healthy SVs decode to a = 42 164 km, i₀ ≈ 28.8°, e ≈ 0.002 (textbook NavIC IGSO); an alert-flagged SV is correctly dropped; RTCM 1041 is cross-checked bit-identical against the SBF decode of the same satellite.

## 2.4.0

### New — SBAS MT28 (clock-ephemeris covariance) → geometry-dependent δUDRE

The SBAS integrity math applied only the MT27 region-based δUDRE; the alternative a system may broadcast — **MT28**, a per-satellite clock-ephemeris covariance giving a satellite- _and_ geometry-specific δUDRE — was ignored (δUDRE = 1 for those sats), so protection levels were optimistic where MT28 is used (e.g. WAAS, and the majority of the integrity messages on some EGNOS-relayed streams).

- **`SbasProcessor` decodes MT28** (ICAO Annex 10 Vol I §3.5.4.7 / Table B-51): two satellites per message, each an upper-triangular Cholesky factor `E` + scale exponent, keyed into the current MT1 mask (IODP-guarded; cleared on a mask change). A degenerate all-zero `E` is treated as "no data" (it would give a dangerously optimistic δUDRE ≈ 0) and falls back to MT27 / δUDRE = 1.
- **δUDRE = √(Iᵀ·C·I) + ε_c** (§3.5.5.6.2.5) with `C = RᵀR`, `R = E·2^(scaleExp−5)`, `I = [î_user→sat, 1]`, `ε_c = C_covariance·SF`. `Ccovariance` is now decoded from **MT10** (Table B-49). Since `C = RᵀR`, `Iᵀ·C·I = ‖R·I‖²`, evaluated directly.
- **`satCorrection`** gains an optional `losUnitEcef` (user→satellite unit vector); when MT28 data + the LOS are present it supersedes the MT27 region δUDRE in `σ²_flt`. `solveSpp` passes the LOS on the protection-level pass. No API break — existing callers are unaffected; `Degradation` gains a `ccovariance` field.

Unit-tested against the spec formula (decode round-trip + exact δUDRE + ε_c scaling + IODP/no-data fallbacks).

## 2.3.0

### New — RTK receiver antenna corrections (mixed-antenna baselines)

RTK forms double differences per signal, so it needs the **per-frequency** receiver antenna phase-centre offset (PCO) + no-azimuth PCV — not the ionosphere-free combination PPP uses.

- **`buildRtkAntenna(antex)`** (`positioning/rtk-antenna.ts`): a per-frequency receiver model, `rcvOffset(antType, freq)` → `{ pco, pcvZen1Deg, pcvDzenDeg, pcvNoazi }` (metres) for one ANTEX frequency code (e.g. `'G01'`, `'E05'`). A deliberately separate model from the IF-combined `buildPppAntenna`. Plus **`rcvAntennaRangeM(...)`** — the additive range correction (PCO·LOS + elevation PCV + marker→ARP delta), following the PPP receiver-term convention.
- **`RtkFloatOptions.antenna = { model, base?, rover? }`** — applies each receiver's antenna correction (base folded into the base range, rover into the modelled range) before differencing. The satellite antenna is never needed: it cancels in the base↔rover double difference. Same antenna type + orientation at both ends also cancels, so this only matters on **mixed-antenna** baselines; with different antennas the uncanceled PCO/PCV difference (cm–dm, mostly vertical) is removed.

Validated by controlled recovery on the WHU OEM719 short baseline: injecting a 7 cm-PCO antenna-B signature into the rover biases the uncorrected baseline 3.6 → 9.1 cm and drops the AR fix rate 0.90 → 0.81; the matching `base`/`rover` antenna config recovers the truth baseline exactly and restores the fix rate. Existing RTK behaviour is unchanged when `antenna` is omitted.

## 2.2.0

### Changed — `SatCn0.cn0` is now `number | null`

`SatCn0.cn0` (the best-signal C/N0 in `StreamStats.satellites`) was typed `number` and set to `0` when a source carried no C/N0. But `0` is a valid-looking dB-Hz value, so consumers couldn't tell "signal strength 0" from "no C/N0 reported" — and the sources that report no C/N0 (legacy RTCM3 obs 1001–1012, RTCM 2.x) still track the satellite. `cn0` is now `number | null`: `null` means the source reports no C/N0 at all, the satellite is tracked with unknown signal strength. `updateStreamStats` sets `cn0: bestCn0 > 0 ? bestCn0 : null`. Consumers rendering C/N0 should null-check rather than treat `0` as "no signal".

## 2.1.0

### New — SSR/HAS → PPP: apply corrections + a streaming PPP engine

The bridge from the decode-only SSR/HAS decoders to a solve, plus a live PPP filter.

- **`applyOrbitClock(eph, corr, timeMs)`** + **`hasToOrbitClock(...)`** (`positioning/ssr-apply.ts`): combine a broadcast ephemeris with a normalized `OrbitClockCorrection` (RAC orbit deltas + rate, clock polynomial) → corrected ECEF position + clock offset. Builds the satellite radial/along/cross frame from position+velocity, matches IOD, enforces validity. The HAS adapter uses the additive convention (RTCM/IGS SSR adapters negate the orbit sign). Validated on a 45-min Galileo-HAS capture (correct sign, sub-metre orbit corrections, ~2× faster PPP convergence).
- **`PppEphemerisSource`** provider seam for `solvePpp`: precise satellite state now comes from a `satState(prn, tEmit)` provider, with **`Sp3EphemerisSource`** wrapping the existing SP3/CLK path as the default. `solvePpp` still accepts an `Sp3File` positionally — existing behaviour is unchanged. An SSR/HAS-fed source plugs in here for real-time PPP.
- **`PppEngine`** — a streaming PPP filter (`constructor(opts, source)`, `process(epoch)`, `reset()`, `solution()`) mirroring `RtkFloatEngine`; `solvePpp` is now a thin wrapper over it (behaviour identical).
- **Satellite code (OSB) biases**: `PppSatObs` gains optional `code1`/`code2` (RINEX-3 codes) and `PppEphemerisSource` an optional `codeBias(prn, signal, t)`, so the iono-free code build can subtract per-signal biases to stay consistent with an SSR/HAS clock reference (no-op for SP3/CLK).

## 2.0.0

### Breaking — observation types renamed (MSM → Obs)

The observation-epoch types were named for MSM back when MSM was the only source, but the same shapes now carry legacy RTCM3 obs (1001–1012) and are the neutral obs representation across the library. Renamed accordingly:

- `MsmEpoch` → `ObsEpoch`
- `MsmSatObs` → `ObsSatObs`
- `MsmSignal` → `ObsSignal`
- `msmEpochToDate(...)` → `obsEpochToDate(...)`

`decodeMsmFull` keeps its name — it genuinely is the MSM4–7 decoder. Migration is a mechanical find-and-replace of the four names; no behaviour or field changes.

### New — `decodeObs` observation dispatcher

- `decodeObs(frame)` returns an `ObsEpoch` for any RTCM3 observation frame: MSM4–7 first (`decodeMsmFull`), then the legacy fixed-layout obs (`decodeLegacyObs`), else `null`. This is the single obs entry point consumers should call, so a new obs source is added in one place rather than at every call site. `updateStreamStats` now routes through it.

### Internal — SSR decoder dedup

- The RTCM-SSR (1057–1068) and IGS-SSR (4076) decoders now share their identical orbit/clock field readers and the update-interval / URA tables via an internal `ssr-common` module (IGS-SSR mirrors RTCM-SSR's encoding field-for-field). No API or output change. Removed a dead `BitReader.bitsLeft` getter.

## 1.66.0

### New — RTCM 2.x decoding (`gnss-js/rtcm2`)

- A full decoder for the legacy RTCM 2.x format (RTCM 10402.3) — a wholly different wire format from RTCM3: 30-bit GPS-style words (24 data + 6 parity bits) carried "6-of-8" (low 6 bits of each byte; every byte 0x40–0x7F), with the D30\* bit inverting the following data exactly like GPS LNAV. `Rtcm2Decoder` strips the encoding, GPS-parity-checks each word (faithful port of RTKLIB `input_rtcm2` + `decode_word`), syncs on the 0x66 preamble, and returns message frames (header + packed body). Body decoders: `rtcm2Station` (Type 3 ARP ECEF, Type 22 extended), `rtcm2Observation` (Type 18/19 RTK carrier phase + pseudorange records), `rtcm2Dgps` (Type 1/9 GPS, Type 31 GLONASS differential corrections), `rtcm2Time` (Type 14), `rtcm2Text` (Type 16). `looksLikeRtcm2` detects the format; `RTCM2_MESSAGE_NAMES` for the census.
- **Validated against a real RTCM 2.3 stream** (a live Spanish CORS, AVL12): 135 frames all parity-valid, the Type 3 reference position decodes onto the Earth's surface at the station's location, and Types 1/3/18/19/22/31 all decode. Test fixture `test-fixtures/rtcm2_avl12_slice.bin`.

## 1.65.0

### New — RTCM3 System Parameters (1013) + Physical Reference Station (1032)

- `decodeSystemParams(frame)` decodes message 1013 (RTCM 10403.2 §3.5.5): the station's reference epoch (Modified Julian Day + seconds of day), the current **GPS−UTC leap seconds**, and the **message schedule** — the list of message types the station transmits, each with a sync flag and broadcast interval.
- Message 1032 (Physical Reference Station Position) now decodes via `updateStationMeta`: the physical station behind a non-physical/computed (VRS) station — its ID (`physicalRefStationId`, new on `StationMeta`), ITRF year and ECEF position.
- Unit-tested (leap seconds + schedule; 1032 ECEF/IDs).

## 1.64.0

### New — SSR correction decoding (RTCM-SSR 1057–1068 + IGS-SSR 4076)

- `decodeSsr(frame)` decodes the RTCM3 State Space Representation messages (RTCM 10403.2 §3.5.12): GPS 1057–1062 and GLONASS 1063–1068 — orbit (radial/along/cross + rates), clock (C0/C1/C2 polynomial), per-signal code bias, combined orbit+clock, URA (class/value → 1σ mm) and high-rate clock. Returns SI units with the SSR header (epoch, update interval, IOD SSR, provider/solution ID, multiple-message flag, satellite reference datum). `isSsrMessage(type)` classifies 1057–1068.
- `decodeIgsSsr(frame)` decodes the IGS-SSR message 4076 (IGS SSR Format v1.00): the multi-GNSS successor carrying the same orbit/clock/code-bias/URA plus **phase biases** (integer/wide-lane/discontinuity flags, for PPP-AR) across GPS/GLONASS/Galileo/QZSS/BDS/SBAS, selected by the IGS-message-number subtype, and an ionosphere VTEC (spherical-harmonic) summary. These are what the IGS real-time streams (BKG `products.igs-ip.net`) broadcast. Decode-and-inspect; applying corrections to a solve is a separate step.
- Both unit-tested against synthetic frames (combined orbit+clock, nested code/phase biases, per-GNSS satellite-ID mapping, URA).

## 1.63.0

### New — legacy (pre-MSM) RTCM3 observation decoding

- `decodeLegacyObs(frame)` decodes the classic fixed-layout RTCM3 observation messages — GPS 1001/1002/1003/1004 and GLONASS 1009/1010/1011/1012 (RTCM 10403.2 §3.5.1/§3.5.4) — into the same `MsmEpoch` shape as `decodeMsmFull`, so the RINEX writer, SPP and QC work unchanged. Extracts code, carrier phase (cycles), C/N0 and lock time per satellite/signal; reconstructs the full pseudorange from the integer modulus ambiguity on the extended types (1002/1004/1010/1012 — the basic types omit it and give a modulo-only range). GLONASS wavelength comes from the inline frequency channel (DF040). Many national CORS networks still broadcast only these legacy messages; they were previously counted but not field-decoded. Unit-tested against synthetic 1004/1012 frames.

## 1.62.0

### New — expose the SBAS ionospheric grid (IGP + GIVE)

- `SbasProcessor.ionoGrid(week, tow)` returns the current ionospheric grid as `SbasIgp[]` — every grid point (IGP) carrying a valid broadcast vertical delay (MT18 mask populated by MT26 delays), across all bands, with its location (`latDeg`/`lonDeg`), `band`, vertical `delayM`, `givei` (0–14), the `giveMeters` 99.9% error bound (DO-229D Table A-17), and the delay's `ageSec` at the query epoch. The count matches `ionoGridPoints()`. This surfaces the grid state that `ionoDelay()` interpolates internally, for visualising the SBAS ionosphere and its integrity (GIVE) — no new decoding, just exposure of already-decoded state. `SbasIgp` is exported from `gnss-js/positioning`.

## 1.61.0

### Fixed — SBAS re-broadcast wiped accumulated corrections

- `SbasProcessor` reset its correction state on every re-broadcast of the PRN mask (MT1) and the ionospheric grid mask (MT18), not only when the mask actually changed. SBAS repeats MT1/MT18 every few seconds, so each one blanked the fast/long-term corrections (MT1) and the MT26 grid delays (MT18) accumulated since the last one — the corrected-satellite count and the grid-covered count sagged toward zero between refills and never held steady (observed live on EGNOS via a Septentrio stream: the corrected count and HPL/VPL oscillated, and grid-iono coverage collapsed to 0 seconds after filling). `decodeMask`/`decodeIgpMask` now rebuild only on a genuine change (new IODP/IODI or a different masked set) and otherwise preserve the accumulated corrections, per DO-229 (the mask is quasi-static; corrections accrue against it). Regression-tested that a repeated mask keeps its corrections while a changed mask resets them; validated against real DLF500 (TU Delft) captures where per-GEO range settles at 13–14 corrected and the EGNOS iono grid fills to full local coverage and stays.

## 1.60.0

### New — MT27 service-region δUDRE (DO-229D §A.4.4.13)

- `SbasProcessor` decodes MT27 service messages (Table A-20): the geographic regions (triangular/square) and their δUDRE indicators. `deltaUdre(latDeg, lonDeg)` returns the Table A-21 multiplier for a user location — the highest-priority containing region wins (ties → lower δUDRE), else the outside value; 1 with no MT27. `satCorrection` takes optional user lat/lon and inflates σ_UDRE by δUDRE in σ²_flt, and `solveSpp` passes the receiver location on the protection-level pass. Region point-in-polygon is ray-cast (antimeridian-wrapping regions aren't handled — EGNOS/WAAS regions don't wrap). Decode + region logic unit-tested against Table A-20/A-21. (MT28 covariance-based δUDRE — the geometry-dependent alternative some providers broadcast — remains a follow-up.)

## 1.59.0

### Fixed — SBAS long-term correction time-out (DO-229D Table A-25)

- Long-term corrections were held valid for 1800 s (the RTKLIB constant); DO-229D Table A-25 times them out at 360 s (En Route/Terminal). Trusting them ~5× too long inflated coverage and could apply stale ephemeris/clock corrections. Fast corrections keep the conservative 30 s floor (Table A-8 by degradation index).

## 1.58.0

### New — MOPS-exact SBAS protection-level variances (DO-229D)

- `SbasProcessor` now decodes MT10 degradation factors (Table A-9, exposed via `SbasProcessor.degradation`), and the residual variances grow with correction age instead of using the base UDRE/GIVE only — which had made HPL/VPL optimistic when corrections went stale. σ²_flt (§J.2.2) adds ε_fc (A-51) + ε_ltc (A-54/A-55); σ²_ionogrid (§A.4.5.2) adds ε_iono (A-59) — combined per the broadcast RSSUDRE/RSSiono flags. The iono term in particular replaces a near-zero approximation that under-bounded VPL. σ_air (§J.2.4) uses the 0.36 m AAD-A noise+divergence bound (multipath & troposphere already matched).
- ε_ltc/ε_iono are exported as pure functions (`sbasLongTermDeg`, `sbasIonoDeg`) and unit-tested against the DO-229D equations; MT10 decode is tested against Table A-9. ε_rrc/ε_er are 0 (no range-rate extrapolation is applied; en-route-equivalent SPP, not an LPV/LNAV-VNAV approach), and δUDRE = 1 (MT27/28 not yet decoded).

## 1.57.0

### New — SBAS L5 / DFMC framing + GEORawL5 routing

- SBF GEORawL5 (block 4021) is routed instead of dropped. The L5 signal carries a mix: GEOs relaying DO-229 (L1-format) content on L5 — fed to the existing L1 `SbasProcessor` and decoded for GEO ephemerides — and GEOs broadcasting native DFMC frames, which are CRC-24Q-gated and censused by ICAO Annex 10 Table B-98 message type (not field-decoded: no accessible stream broadcasts DFMC corrections yet — EGNOS V3 / WAAS send only MT0/MT63 placeholders).
- `navbits/sbas-l5` (4-bit preamble unique word 0x5C693A, type at bit offset 4, shared 226-bit CRC-24Q), `parseSbfGeoL5`, and a `dfmc` census + `onDfmcMessage` hook on `decodeSbfNavigation`. Validated on a real DLF500 GEORawL5 slice (S27/S36 relay DO-229 → full 32-GPS mask; S21/S23 are native DFMC, MT0/63 only).

## 1.56.0

### New — SBAS correction-coverage funnel

- `SbasProcessor.coverage(week, tow)` returns a diagnostic census — masked / fast / long / fully-corrected satellites plus valid iono-grid points — so a consumer can tell "no corrections applied yet" from "corrections applied but the pierce points aren't grid-covered". Validated on the F9P EGNOS/WAAS fixture.

## 1.55.0

### Fixed — no more SBAS cycle-slip false-positive storm

- `CycleSlipAccumulator` no longer runs the single-frequency phase-code test (`|Δφ − ΔP|`) on SBAS (system `S`). That fallback detector is driven by pseudorange noise, and SBAS geostationary L1 C/A code is noisy enough that it tripped the 3 m threshold almost every epoch — a false-slip storm (~900 / 1000 epochs on a GEO that isn't slipping), which dominated the cycle-slip stats and quality verdict for any stream carrying SBAS. This matches RTKLIB/teqc, which likewise don't cycle-slip-QC SBAS L1. Dual-frequency Melbourne-Wübbena / geometry-free detection on SBAS (e.g. L1-L5) is unaffected and still runs.

## 1.54.0

### New — receiver PVT across NovAtel + u-blox (unified `ReceiverPvt`)

- `parseNovatelPvt` (`novatel`, BESTPOS message 42) and `parseUbxPvt` (`ubx`, UBX-NAV-PVT 0x01/0x07) decode the receiver's own position solution — mode ('standalone', 'sbas-aided', 'rtk-float', 'rtk-fixed', 'ppp', …), latitude/longitude/ellipsoidal height, satellites used, and H/V accuracy — normalised to the same `ReceiverPvt` shape as the SBF `parseSbfPvt` (whose `SbfPvt` now extends it). Any of the three receiver families can now serve as the truth/reference for validating an independent SPP/SBAS solution (and its protection level). Synthesised-frame tests validate the field offsets. (Trimble RT27 carries no position record — deferred.)

## 1.53.0

### New — SBF PVTGeodetic decoder (`parseSbfPvt`)

- `parseSbfPvt` (`sbf`) decodes Septentrio PVTGeodetic (block 4007): the receiver's own position, solution mode ('standalone', 'sbas-aided', 'rtk-fixed', 'ppp', …), satellites used, and 2-σ horizontal/vertical accuracy estimate. The receiver's fix is a ready reference to cross-check an independent SPP/SBAS solution against — e.g. a network-RTK-fixed station provides a centimetre truth to validate that a protection level genuinely bounds the actual error.

## 1.52.0

### New — SBAS protection levels (HPL / VPL)

- `sbasProtectionLevels(sats, opts?)` (`positioning`) computes the DO-229 horizontal and vertical protection levels from the per-satellite ENU geometry and total error variances: `HPL = K_H·d_major`, `VPL = K_V·d_U` (defaults K_H=6.0, K_V=5.33 for precision approach), where `d_major`/`d_U` come from the variance-weighted least-squares covariance. Needs ≥ 4 satellites.
- `solveSpp` returns `hpl`, `vpl` and `sbasSats` when the `sbas` option is set: each SBAS-corrected satellite's total variance is built from the broadcast fast/long (σ²_flt, UDRE) and grid ionosphere (σ²_uire, GIVE) plus a DO-229 airborne + residual-troposphere model (`sbasAirTropoVar`), and the corrected set is projected to a protection level — the SBAS integrity bound alongside the position.

## 1.51.0

### New — SBAS-corrected SPP + SBAS message hooks on every decoder

- `solveSpp` gains an `sbas` option (an {@link SbasProcessor} or any `SbasCorrectionSource`): each satellite in the SBAS PRN mask has its broadcast position + clock shifted by the fast/long-term corrections, and — where the ionospheric pierce point is inside the SBAS grid — the SBAS slant ionosphere replaces the Klobuchar/GIM model (falling back to them at the grid edge). This turns plain single-frequency SPP into SBAS-augmented (WAAS/EGNOS) SPP.
- `decodeSbfNavigation` (Septentrio GEORawL1) and `parseNovatelNav` (RAWSBASFRAME/RAWWAASFRAME) gain the same `onSbasMessage(msg, prn, week, tow)` hook `parseUbxRawNav` got in 1.49.0, so all three raw-frame sources can feed an `SbasProcessor` live. (NovAtel carries 232 bits — the correction fields fit; the outer OEM4 CRC-32 guarantees them.)

## 1.50.0

### Fixed — multi-GNSS SPP no longer fails when a whole constellation sits below the elevation mask

- `solveSpp` allocates a per-constellation receiver-clock unknown for every system present, but drops sub-mask satellites from iteration 2 onward. A constellation whose satellites were **all** below the mask — a lone QZSS / NavIC / SBAS / BeiDou-GEO satellite seen from the wrong hemisphere — left its clock column with no observations, making the normal-equation matrix singular, so the **entire** multi-GNSS fix returned `null`. Such an unconstrained clock is now pinned to its current value (unit diagonal), and the per-iteration observation-count requirement counts only contributing systems, so the remaining constellations still solve. Purely a robustness fix — nominal solves are unchanged.
- Reproduced from a live `AMEL00NLD0` (Netherlands) RTCM3 stream in which a single below-horizon QZSS satellite blocked every epoch; the same data now solves to ~4 m against the station's surveyed coordinate.

## 1.49.0

### New — SBAS (WAAS/EGNOS/…) wide-area corrections (`SbasProcessor`)

- `SbasProcessor` (`positioning`) ingests decoded SBAS L1 messages and produces the two corrections a single-point solve needs: `satCorrection(prn, week, tow)` — long-term satellite ephemeris + fast pseudorange/clock corrections — and `ionoDelay(...)` — a slant L1 ionospheric delay interpolated from the SBAS grid at a pierce point. It decodes MT1 (PRN mask), MT2–5/24 (fast corrections), MT6 (integrity), MT7 (fast degradation/latency), MT24/25 (long-term corrections), and MT18/26 (ionospheric grid mask + delays). A faithful port of RTKLIB `sbas.c` (`decode_sbstype*`, `sbssatcorr`, `sbsioncorr`), including the DO-229 IGP band tables and the 4-point grid interpolation. (GEO navigation MT9 remains `decodeSbasGeoNav`.)
- `parseUbxRawNav` gains an `onSbasMessage(msg, prn, week, tow)` hook that surfaces every CRC-valid SBAS L1 message (all types), for feeding the processor live.
- Validated on a real F9P WAAS stream (PRN 138): the full message set decodes, GPS satellites receive metre-level fast/clock/position corrections (σ ≈ 1 m), and the ionospheric grid (80 IGPs) interpolates plausible sub-30 m slant delays.

## 1.48.0

### New — kinematic PPP (`mode: 'kinematic'`)

- `solvePpp(..., { mode: 'kinematic' })` positions a moving receiver: the rover position becomes a white-noise state (RTKLIB `PMODE_PPP_KINEMA`) — re-estimated each epoch from that epoch's measurements while the carrier ambiguities and troposphere persist across epochs — instead of the single constant state that `'static'` (the default) averages over the whole session. Purely additive; `'static'` behaviour is unchanged.
- Kinematic float PPP with 5-minute clocks is markedly noisier than static (per-epoch clock/tropo errors that average out in static map into each epoch, the vertical most of all); precise 30 s clocks and ambiguity resolution tighten it. Verified on ABMF processed kinematically: the per-epoch track stays decimetre-horizontal / sub-2 m-vertical around the known marker, with genuine per-epoch scatter (not static convergence).

## 1.47.0

### New — code-only (DGNSS) mode in `postProcessRtk`

- `postProcessRtk(..., { codeOnly: true })` routes each paired epoch through `solveDgnss` (double-differenced pseudoranges) instead of the carrier-phase float engine — a robust metre→sub-metre differential solution that needs no carrier phase and does no ambiguity fixing. Track points come back with `status: 'dgnss'`; `fixRate` is 0. Surfaces the existing `solveDgnss` as a batch post-processing mode. Verified on the WHU short baseline (every epoch solved, metre-level).

## 1.46.0

### New — zenith hydrostatic delay in PPP output (full ZTD)

- `solvePpp` now reports the a priori **zenith hydrostatic delay** (`ztdHydrostatic`, Saastamoinen) alongside the estimated wet delay, on both `PppSolution` and every `PppEpochResult`. The total zenith tropospheric delay is `ztdHydrostatic + ztdWet`, so a caller can produce a ZTD time series (and derive integrated water vapour) without re-deriving the hydrostatic model. Purely additive — no change to the estimator or existing fields.

## 1.45.1

### Fixed — RTK post-processing on sub-1 Hz data (30 s RINEX)

- `postProcessRtk` now detects the rover sampling interval and, unless the caller pins `maxGapMs`, scales the engine's cycle-slip gap gate to it (≈2.5× the median epoch spacing, floored at 10 s). The `RtkFloatEngine` default `maxGapMs` of 10 s is tuned for ~1 Hz streams; on 30 s RINEX every epoch is >10 s from the previous one, so **every satellite was flagged as a cycle slip each epoch**, resetting the float ambiguities and collapsing the fix rate.
- Validated on the TU Delft DELF↔DLF1 ~14.3 m baseline (broadcast nav, static, instant AR): the 30 s daily pair goes from ~4% to **95% fixed** with 98% of fixes within 5 cm of the surveyed 14.321 m baseline; the 1 s pair reaches 95% fixed with 99.9% cm-accurate. 1 Hz behaviour is unchanged (gate stays at the 10 s floor).

## 1.45.0

### New — offline RTK post-processing (`postProcessRtk`)

- `postProcessRtk(base, rover, ephemerides, baseEcef, opts)` (`positioning`) is the `rnx2rtkp`-style batch driver: it pairs a base and rover observation stream by epoch time and runs each synchronized pair through a single `RtkFloatEngine` (float, with optional LAMBDA integer fixing), returning the rover track — `{ position, lat/lon/height, enu baseline, status (fixed/float/dgnss), ratio, nSats, nFixed }` per epoch plus a `fixRate`. The estimator is the same one validated on live streams; this adds the batch loop + second-aligned epoch pairing (with a `pairToleranceMs` gate) so a recorded base/rover pair — RINEX or any decoded receiver stream (`{ epochs: [{ timeMs, meas }] }`) — can be processed to a track.
- Validated on the WHU OEM719 ~1.58 km short baseline: static solution converges to the surveyed rover point at the decimetre level (< 0.3 m horizontal, < 0.6 m vertical), instant AR yields integer-fixed epochs, and rover epochs with no base within tolerance are reported as `unmatched`. Static + kinematic modes.

## 1.44.0

### New — SBAS GEO navigation from NovAtel (RAWSBASFRAME / RAWWAASFRAME)

- `parseNovatelNav` now decodes SBAS GEO navigation (message type 9) from RAWSBASFRAME (OEM6/OEM7, message 973) and its OEMV-era twin RAWWAASFRAME (287), using the shared `decodeSbasGeoNav` from 1.43.0. This brings the third receiver format to SBAS parity with u-blox and Septentrio — every constellation a NovAtel OEM7 broadcasts is now decoded.
- Layout per RTKLIB `decode_rawsbasframeb`/`decode_rawwaasframeb` and the OEM7 manual §3.169: after the OEM4 header, frame-decoder u4, PRN u4, a u4, then the 250-bit SBAS message as 29 bytes. Only 29 bytes (232 bits) are carried — enough for every MT9 field but short of the 24-bit SBAS CRC, so it is not re-checked; the OEM4 CRC-32 over the whole log already guarantees the transported bytes. Non–type-9 messages (fast/long corrections, iono) are skipped.
- Verified on the OEMV `RAWWAASFRAME` capture (90 frames → correct PRNs/message types) and with a real type-9 GEO message re-wrapped in an OEM4 frame → geostationary orbit (|r| ≈ 42,164 km).

## 1.43.0

### New — SBAS GEO navigation (message type 9) from u-blox and Septentrio

- New shared decoder `decodeSbasGeoNav` (`src/navbits/sbas.ts`) turns an SBAS L1 C/A message type 9 (GEO navigation) into a GEO ephemeris — a `GlonassEphemeris` tagged `system: 'S'`, i.e. an ECEF state vector (position/velocity/acceleration in km) plus a clock offset/drift, propagated by the same `glonassPosition` used for GLONASS. Field offsets and DO-229 scale factors follow RTKLIB `decode_sbstype9`; the 24-bit CRC-24Q is re-run on every message (`sbasCrcOk`).
- Wired into both raw-frame sources that carry SBAS L1: **u-blox RXM-SFRBX** (`parseUbxRawNav`, gnssId 1) and **Septentrio SBF GEORawL1** (block 4020, via the one-pass `decodeSbfNavigation` and the new standalone `parseSbfGeoNav`). This closes the last broadcast-nav gap on both formats — every constellation a ZED-F9P or mosaic-X5 emits is now decoded.
- Validated on real captures: the F9P slice decodes S31/S33/S38 and the DLF500 SBF slice decodes S21/S23/S36/S44, all to geostationary orbits (|r| ≈ 42,164 km, station-kept birds at ≈ 0 velocity), CRC-24Q clean on all frames. Records round-trip through the RINEX 3 nav writer as standard SBAS (`S##`) entries.
- GEORawL5 (4021, DFMC L5 SBAS) is deliberately not routed here — it carries a different message set (MT 32/34/35/…) from the L1 message type 9.

## 1.42.0

### New — Trimble RETSVDATA Galileo ephemeris (subtype 11)

- `parseTrimbleNav` now decodes Galileo ephemerides (RETSVDATA subtype 11) — Keplerian, but a distinct, more compact 184-byte struct than GPS/BeiDou (√a at +67, not +104). Reverse-engineered and **cross-checked field-by-field against the 2026-07-27 BRDC** (E04: √a = 5440.63, e = 2.773e-4, i₀ = 0.9695 rad, af1 = 3.4078e-11, BGD E5a/E1 = −3.958e-9 — all matching). The orbit propagates through `keplerPosition` to Galileo MEO (|r| ≈ 29,600 km). GST is GPS-aligned, so `tocDate`/`week` are on the GPS scale like `parseSbfNav`'s GALNav; `tgd` carries the BGD E5a/E1 group delay.
- With this, `parseTrimbleNav` covers **all four core constellations — GPS, GLONASS, Galileo, BeiDou**. On the reference DLF100NLD1 capture: 12 GPS + 9 GLONASS + 7 Galileo + 14 BeiDou ephemerides. Still not decoded: the QZSS/almanac RETSVDATA subtypes (13/23/27).

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
