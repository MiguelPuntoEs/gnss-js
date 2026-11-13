# RTKLIB convbin oracles

Independent RINEX 3.04 conversions of our raw fixtures, made once with RTKLIB
2.4.2 p13 `convbin` (BSD-2, built with `-DENAGLO -DENAQZS -DENAGAL -DENACMP
-DNFREQ=6 -DNEXOBS=3`) so CI needs no RTKLIB. Every file was produced with

    convbin -r FMT -v 3.04 -f 6 -od -os [extra] ../FIXTURE -o OUT.obs

then trailing blanks and the two machine-specific header lines (`log:` comment,
`PGM / RUN BY / DATE`) were stripped (`sed -e 's/[[:space:]]*$//'`).
Known RTKLIB 2.4.2 limitations the tests document: no GPS/QZSS L1C or Galileo
E6 slot, Galileo PRN ≤ 30, BeiDou B1I named `1I` (RINEX 3.02).

| file             | FMT   | fixture                   | extra                                                                                    |
| ---------------- | ----- | ------------------------- | ---------------------------------------------------------------------------------------- |
| dlf100_rtcm3.obs | rtcm3 | dlf100_rtcm_rtk_base.rtcm | `-tr 2026/11/06 9:00:00 -ts 2026/11/06 09:13:51 -te 2026/11/06 09:14:00`                 |
| rtcm2_avl12.obs  | rtcm2 | rtcm2_avl12_slice.bin     | `-tr 2026/11/13 0:30:00` (RTCM 2 has no date: only the time within the hour is compared) |
