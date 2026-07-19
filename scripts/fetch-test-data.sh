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
    brdc_v2.nav.gz)     echo "b6aeae1dc03c65c94dd93cefd4796e0d5566760d3e564241a989544cc8ba0d91" ;;
    brdc_v2_glo.nav.gz) echo "9f040749e0e0be916743bf47f24b3fe530c11876b2bd9cd80cc362755b8d3aee" ;;
    brdc_v3_igs.nav.gz) echo "e68833b1280a4413fe5cf6cfb537ef406d8a396f9e8331d339272d8c9ee27ebe" ;;
    brdc_v4_dlr.nav.gz) echo "ff11082ccb87c8c678f9aa258487ec5d8e838e330f1c5e92ce289134ef15f805" ;;
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
  curl -fSL --connect-timeout 15 --retry 3 --retry-delay 5 "$url" -o "$out.tmp"
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

# RINEX 3 mixed nav (2024/001)
download "https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2024/001/BRDC00IGS_R_20240010000_01D_MN.rnx.gz" "$DIR/BRDC.nav.gz"
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
