#!/usr/bin/env bash
# Downloads RINEX navigation files for tests.
# Sources: IGS/BKG and ESA GSSC.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../test-fixtures" 2>/dev/null || mkdir -p "$(dirname "$0")/../test-fixtures" && cd "$(dirname "$0")/../test-fixtures" && pwd)"

download() {
  local url="$1" out="$2"
  if [[ -f "$out" ]]; then return; fi
  echo "  ↓ $(basename "$out")"
  curl -fSL --connect-timeout 15 --retry 3 --retry-delay 5 "$url" -o "$out.tmp" && mv "$out.tmp" "$out"
}

decompress() {
  if [[ -f "$1.gz" && ! -f "$1" ]]; then gunzip -k "$1.gz"; fi
}

echo "Fetching test fixtures…"

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

# RINEX 4 DLR nav (2026/001) — may not be available
download "https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2026/001/BRD400DLR_S_20260010000_01D_MN.rnx.gz" "$DIR/brdc_v4_dlr.nav.gz" || true
decompress "$DIR/brdc_v4_dlr.nav"

echo "Done."
