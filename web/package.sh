#!/usr/bin/env bash
# Build the hosted editor into a new directory outside the checkout.
# app/node_modules must be installed using its tracked package-lock.json.
set -euo pipefail
if [[ $# != 1 || -z ${CARGO_TARGET_DIR:-} ]]; then
  echo 'Usage: CARGO_TARGET_DIR=/path/to/cache web/package.sh /new/output/directory' >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
output="$(realpath -m "$1")"
case "$output/" in "$root/"*) echo 'Choose an output directory outside the checkout.' >&2; exit 2;; esac
[[ ! -e "$output" ]] || { echo 'Choose a new output directory.' >&2; exit 2; }
cd "$root"
# Panic locations in a Rust binary otherwise expose the compiler's absolute checkout paths.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$HOME=build --remap-path-prefix=$root=sketchcraft --remap-path-prefix=$cargo_home=cargo --remap-path-prefix=$(rustc --print sysroot)=rust"
cargo build --locked --offline --release --target wasm32-unknown-unknown -p sketchcraft-web
cd app
node_modules/.bin/tsc --noEmit
mkdir -p "$(dirname "$output")"
stage="$(mktemp -d "$(dirname "$output")/.sketchcraft-package.XXXXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
node_modules/.bin/vite build --mode webos --base ./ --outDir "$stage"
"${WASM_BINDGEN:-wasm-bindgen}" --target web --no-typescript --out-dir "$stage/engine" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/sketchcraft_web.wasm"
python3 "$root/web/notices.py" "$root" "$cargo_home" "$stage/NOTICES.txt"
mv -T -- "$stage" "$output"
