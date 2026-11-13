# RTKLIB convbin oracles

Independent RINEX 3.04 conversions of our raw fixtures, made once with RTKLIB
2.4.2 p13 `convbin` (BSD-2, built with `-DENAGLO -DENAQZS -DENAGAL -DENACMP
-DNFREQ=6 -DNEXOBS=3`) so CI needs no RTKLIB. Every file was produced with

    convbin -r FMT -v 3.04 -f 6 -od -os [extra] ../FIXTURE -o OUT.obs

then trailing blanks and the two machine-specific header lines (`log:` comment,
`PGM / RUN BY / DATE`) were stripped (`sed -e 's/[[:space:]]*$//'`).
Known RTKLIB 2.4.2 limitations the tests document: no GPS/QZSS L1C or Galileo
E6 slot, Galileo PRN ≤ 30, BeiDou B1I named `1I` (RINEX 3.02).

| file              | FMT   | fixture                   | extra                                                                                                 |
| ----------------- | ----- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| dlf100_rtcm3.obs  | rtcm3 | dlf100_rtcm_rtk_base.rtcm | `-tr 2026/11/06 9:00:00 -ts 2026/11/06 09:13:51 -te 2026/11/06 09:14:00`                              |
| rtcm2_avl12.obs   | rtcm2 | rtcm2_avl12_slice.bin     | `-tr 2026/11/13 0:30:00` (RTCM 2 has no date: only the time within the hour is compared)              |
| f9p_rawx.obs      | ubx   | f9p_rawx_slice.ubx        | (RTKLIB 2.4.2 ignores RAWX sigId: every record is an L1 row)                                          |
| oem719_base.obs   | nov   | oem719_rtk_base.gps       | `-ts 2025/03/26 03:55:00 -te 2025/03/26 03:55:09`                                                     |
| oemv_rangecmp.obs | nov   | oemv_rangecmp.gps         | `-ts 2029/08/03 23:07:00 -te 2029/08/03 23:07:09` (RTKLIB adjgpsweek moves the 2009 file +1024 weeks) |
| binex_7f05.obs    | binex | binex_obs_7f05.bnx        | (2.4.2 decodes only the first satellites of this record cleanly)                                      |

## Navigation oracles

RTKLIB 2.4.2 p13 (`convbin` built from github.com/tomojitakasu/RTKLIB tag
2.4.2_p13, BSD-2) RINEX 3.03 navigation output for the raw fixtures, used as
an independent oracle by `test/nav-convbin-oracle.test.ts`:

    convbin -r <fmt> -v 3.03 -oi -ot -ol [-tr 2026/11/06 12:00:00] <file> \
      -o x.obs -n x.nav -g x.gnav -h x.hnav -q x.qnav -l x.lnav -s x.sbs

| file | -r | input |
|---|---|---|
| rtcm.nav | rtcm3 (-tr 2026/11/06 12:00:00) | dlf100_rtcm_rtk_base.rtcm |
| ubx_sfrbx.nav | ubx | f9p_sfrbx_slice.ubx |
| oem7.nav | nov | oem7_nav_slice.gps |
| oemv.nav | nov | oemv_rangecmp.gps |
| rt17.nav | rt17 | dlf100_rt27_gpsnav_slice.t02 |

(2.4.2's convbin needs every -g/-h/-q/-l/-s output named with -v 3.x, else
it writes to uninitialised file names.)
