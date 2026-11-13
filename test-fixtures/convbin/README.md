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
