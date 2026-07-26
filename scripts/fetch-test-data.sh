#!/usr/bin/env bash
# Downloads RINEX navigation files for tests.
# Sources: IGS/BKG and ESA GSSC.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/test-fixtures"
mkdir -p "$DIR"

# SHA256 of each archive — the sources are static historical files, so a
# mismatch means a corrupt or tampered download, not an update.
checksum_for() {
  case "$(basename "$1")" in
    BRDC.nav.gz)        echo "17f1a43c5074df56ea261136214d5fda5d9befa0a5422c4768ad14651b252e49" ;;
    ABMF.crx.gz)        echo "34d26113d18fb1409c91404609497b2fc0c15aeb0c0961bcc13174d67a77ce09" ;;
    ESA_MGEX.sp3.gz)    echo "bfb9bb94c99c6844fa646b64cf062c9a32c060d0c944a6e3d4b4f9453729fc9c" ;;
    ESA_GIM.inx.gz)     echo "1d74ba5c1a9ba1bbd8cb2a31db4db2d388be10311af96aa55b1fa27c3fae992c" ;;
    ESA_GIM_2024001.inx.gz) echo "a164e253ad315d28d186c5d1df129038fca6d2a0991506b7c51361ab2004d050" ;;
    brdc_v2.nav.gz)     echo "b6aeae1dc03c65c94dd93cefd4796e0d5566760d3e564241a989544cc8ba0d91" ;;
    brdc_v2_glo.nav.gz) echo "9f040749e0e0be916743bf47f24b3fe530c11876b2bd9cd80cc362755b8d3aee" ;;
    brdc_v3_igs.nav.gz) echo "e68833b1280a4413fe5cf6cfb537ef406d8a396f9e8331d339272d8c9ee27ebe" ;;
    brdc_v4_dlr.nav.gz) echo "ff11082ccb87c8c678f9aa258487ec5d8e838e330f1c5e92ce289134ef15f805" ;;
    oemv_rangecmp.gps)  echo "65c4e666c73598fac9a0dc0b915d340a606daa9628dc26cc81f1812f7dfa4d36" ;;
    *)                  echo "" ;;
  esac
}

verify() {
  local file="$1" expected actual
  expected="$(checksum_for "$file")"
  [[ -z "$expected" ]] && return 0
  actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "  ✗ checksum mismatch for $(basename "$file")" >&2
    echo "    expected $expected" >&2
    echo "    got      $actual" >&2
    rm -f "$file"
    return 1
  fi
}

download() {
  local url="$1" out="$2"
  if [[ -f "$out" ]]; then verify "$out"; return; fi
  echo "  ↓ $(basename "$out")"
  curl -fSL --connect-timeout 20 --retry 5 --retry-all-errors \
    --retry-delay 5 "$url" -o "$out.tmp"
  mv "$out.tmp" "$out"
  verify "$out"
}

decompress() {
  if [[ -f "$1.gz" && ! -f "$1" ]]; then gunzip -k "$1.gz"; fi
}

echo "Fetching test fixtures…"

# ABMF observation file (CRX 3, 2024/001) — used by the SPP tests
download "https://igs.bkg.bund.de/root_ftp/IGS/obs/2024/001/ABMF00GLP_R_20240010000_01D_30S_MO.crx.gz" "$DIR/ABMF.crx.gz"
decompress "$DIR/ABMF.crx"

# MGEX network (2024/001) for the wide-lane FCB / PPP-AR test — a spread of
# stations so the satellite fractional-cycle biases separate from the
# per-station receiver biases. Optional (the test skips without them).
OBS="https://igs.bkg.bund.de/root_ftp/IGS/obs/2024/001"
for pair in \
  "BRUX00BEL:BRUX" "ANMG00MYS:ANMG" "AREG00PER:AREG" \
  "ALIC00AUS:ALIC" "ADIS00ETH:ADIS"; do
  long="${pair%%:*}"; short="${pair##*:}"
  if download "$OBS/${long}_R_20240010000_01D_30S_MO.crx.gz" "$DIR/$short.crx.gz"; then
    decompress "$DIR/$short.crx"
  fi
done

# ESA MGEX 30 s satellite clocks (2024/001), trimmed to GPS+Galileo+BeiDou
# AS records to keep the fixture small — used by the 30 s-clock PPP test.
if [[ ! -f "$DIR/ESA_MGEX_gec.clk.gz" ]]; then
  if download "https://navigation-office.esa.int/products/gnss-products/2295/ESA0MGNFIN_20240010000_01D_30S_CLK.CLK.gz" "$DIR/_full_clk.gz"; then
    gunzip -kc "$DIR/_full_clk.gz" > "$DIR/_full.clk"
    { sed -n '1,/END OF HEADER/p' "$DIR/_full.clk"; grep -E '^AS [GEC]' "$DIR/_full.clk"; } \
      | gzip -9 > "$DIR/ESA_MGEX_gec.clk.gz"
    rm -f "$DIR/_full_clk.gz" "$DIR/_full.clk"
  fi
fi

# ESA MGEX final orbits (SP3, 2024/001) — precise-orbit truth for the
# broadcast-vs-precise test. Best-effort: ESA's navigation-office server
# is the only source and is unreliable from CI IPs, so a failure here
# is non-fatal (the orbit-sp3 suite skipIf's when absent). The GLONASS
# regression is independently guarded by the SPP suite, which uses the
# reliable BKG/ESA-GSSC fixtures below.
if download "http://navigation-office.esa.int/products/gnss-products/2295/ESA0MGNFIN_20240010000_01D_05M_ORB.SP3.gz" "$DIR/ESA_MGEX.sp3.gz"; then
  if [[ -f "$DIR/ESA_MGEX.sp3.gz" && ! -f "$DIR/ESA_MGEX.sp3" ]]; then
    gunzip -kc "$DIR/ESA_MGEX.sp3.gz" > "$DIR/ESA_MGEX.sp3"
  fi
else
  echo "  ⚠ ESA SP3 unavailable — the precise-orbit test will skip" >&2
fi

# ESA rapid satellite DCBs (SINEX_BIAS, rolling monthly file, no
# checksum — contents update in place). Best-effort like the SP3: the
# iono-dcb real-product tests skipIf when absent.
if ! download "https://navigation-office.esa.int/products/gnss-products/ESA0OPSFIN_DCB.BIA" "$DIR/ESA0OPSFIN_DCB.BIA"; then
  echo "  ⚠ ESA DCB unavailable — the real-product DCB tests will skip" >&2
fi

# ESA rapid global ionosphere map (IONEX, day 2026/201) — immutable
# once published; best-effort like the other ESA products.
if download "https://navigation-office.esa.int/products/gnss-products/2428/ESA0OPSRAP_20262010000_01D_01H_GIM.INX.gz" "$DIR/ESA_GIM.inx.gz"; then
  decompress "$DIR/ESA_GIM.inx"
else
  echo "  ⚠ ESA GIM unavailable — the IONEX tests will skip" >&2
fi

# ESA rapid GIM for day 2024/001 — pairs with the ABMF/BRDC SPP oracle
# so solveSpp can be validated with a real ionosphere map.
if download "https://navigation-office.esa.int/products/gnss-products/2295/ESA0OPSRAP_20240010000_01D_01H_GIM.INX.gz" "$DIR/ESA_GIM_2024001.inx.gz"; then
  decompress "$DIR/ESA_GIM_2024001.inx"
else
  echo "  ⚠ ESA GIM 2024/001 unavailable — the SPP GIM test will skip" >&2
fi

# RINEX 3 mixed nav (2024/001)
download "https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2024/001/BRDC00IGS_R_20240010000_01D_MN.rnx.gz" "$DIR/BRDC.nav.gz"
download "https://raw.githubusercontent.com/tomojitakasu/RTKLIB/master/test/data/rcvraw/oemv_200911218.gps" "$DIR/oemv_rangecmp.gps"
decompress "$DIR/BRDC.nav"

# RINEX 2 GPS nav
download "ftp://gssc.esa.int/gnss/data/daily/2026/brdc/brdc0010.26n.gz" "$DIR/brdc_v2.nav.gz"
decompress "$DIR/brdc_v2.nav"

# RINEX 2 GLONASS nav
download "ftp://gssc.esa.int/gnss/data/daily/2026/brdc/brdc0010.26g.gz" "$DIR/brdc_v2_glo.nav.gz"
decompress "$DIR/brdc_v2_glo.nav"

# RINEX 3 IGS mixed nav (2026/001)
download "https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2026/001/BRDC00IGS_R_20260010000_01D_MN.rnx.gz" "$DIR/brdc_v3_igs.nav.gz"
decompress "$DIR/brdc_v3_igs.nav"

# RINEX 4 DLR nav (2026/001)
download "https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2026/001/BRD400DLR_S_20260010000_01D_MN.rnx.gz" "$DIR/brdc_v4_dlr.nav.gz"
decompress "$DIR/brdc_v4_dlr.nav"

# The nav test suites skip silently (describe.skipIf) when fixtures are
# missing — fail loudly here instead so CI can never green-light a
# publish with suites skipped.
for f in ABMF.crx BRDC.nav brdc_v2.nav brdc_v2_glo.nav brdc_v3_igs.nav brdc_v4_dlr.nav; do
  [[ -f "$DIR/$f" ]] || { echo "Missing fixture: $f" >&2; exit 1; }
done

echo "Done."
