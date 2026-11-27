#!/usr/bin/env bash
# Build every native component and the Linux Electron app.
# Intended for GitHub Actions on ubuntu-latest; nothing here cross-compiles.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deps="$root/.deps"
worker="$root/app/worker"
target="${RUST_TARGET:-x86_64-unknown-linux-gnu}"
cargo_target="${CARGO_TARGET_DIR:-$deps/cargo-target-linux}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }
}

for tool in git cargo rustc cmake ninja dotnet node npm; do need "$tool"; done

init_dep() {
  local name="$1" repo="$2" revision="$3" dir="$deps/$1"
  if [[ ! -d "$dir/.git" ]]; then
    mkdir -p "$dir"
    git -C "$dir" init --quiet
    git -C "$dir" remote add origin "$repo"
  fi
  if [[ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" != "$revision" ]]; then
    git -C "$dir" fetch --depth 1 origin "$revision"
    git -C "$dir" checkout --quiet --detach FETCH_HEAD
  fi
  local actual
  actual="$(git -C "$dir" rev-parse HEAD)"
  [[ "$actual" == "$revision" ]] || { echo "Wrong revision in $dir: $actual" >&2; exit 1; }
}

apply_patch() {
  local dir="$1" patch="$2"
  if git -C "$dir" apply --reverse --check "$patch" >/dev/null 2>&1; then
    return
  fi
  git -C "$dir" apply "$patch"
}

init_dep sixng     https://github.com/holdmysocks/SixNG.git          08f1c2ed211aa80cfc7b0edfc472b89a723a3567
init_dep assimp    https://github.com/assimp/assimp.git              a79ff6bbce54d3e01186a918dc6374ed55317426
init_dep rpf9-explorer https://github.com/breadbbbb/rpf9-explorer.git af549336624fdabf7d1bb6f00b8783e7e1ef692e
init_dep victory   https://github.com/Marvisak/VIctory.git           d2a4bae1f49533ef5cb512fd1b1ba1513f2e1989
init_dep bink2     https://github.com/codingkoala/bink2-decoder.git  2e709c23023d0af75eead5e93cdeb4e5c19f4128
init_dep 6to5m     https://github.com/DesignWithTommy/6to5m.git      5d62e745bb4413d7f21923b23c713b6651728868

apply_patch "$deps/sixng"    "$root/third_party/sixng/preview-api.patch"
apply_patch "$deps/sixng"    "$root/third_party/sixng/ped-skeleton-install.patch"
apply_patch "$deps/assimp"   "$root/third_party/assimp/fbx-uv-layers.patch"
apply_patch "$deps/assimp"   "$root/third_party/assimp/fbx-specular-factor.patch"
apply_patch "$deps/rpf9-explorer" "$root/third_party/rpf9-explorer/ttpf-preview.patch"
apply_patch "$deps/victory"  "$root/third_party/victory/external-tables.patch"

export CARGO_TARGET_DIR="$cargo_target"
rustup target add "$target" >/dev/null 2>&1 || true

echo "==> Rust workers ($target)"
cargo build --locked --release --target "$target" --manifest-path "$root/native/preview/Cargo.toml"
cargo build --locked --release --target "$target" --manifest-path "$root/native/bcpack/Cargo.toml"
cargo build --locked --release --target "$target" --manifest-path "$deps/6to5m/Cargo.toml"

mkdir -p "$worker"
stage="$cargo_target/$target/release"
cp "$stage/opensix-preview" "$worker/"
cp "$stage/libopensix_bcpack.so" "$worker/"
cp "$stage/6ixpack" "$worker/"
cp "$deps/victory/LICENSE" "$worker/VIctory.LICENSE.txt"
cp "$deps/bink2/LICENSE" "$worker/Bink2.LICENSE.txt"
cp "$deps/6to5m/LICENSE" "$worker/6to5m.LICENSE.txt"

echo "==> Texture-pool worker (linux-x64)"
pool_build="$deps/pool-build-linux"
dotnet publish "$root/native/texture-pools/OpenSix.Pools.csproj" \
  -c Release -r linux-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:EnableCompressionInSingleFile=true -p:DebugType=None \
  -o "$pool_build" --nologo
cp "$pool_build/opensix-pool" "$worker/"
runtime_root="${NUGET_PACKAGES:-$HOME/.nuget/packages}/microsoft.netcore.app.runtime.linux-x64"
runtime_license="$(find "$runtime_root" -type f -name LICENSE.TXT 2>/dev/null | sort -V | tail -n 1)"
runtime_notices="$(find "$runtime_root" -type f -name THIRD-PARTY-NOTICES.TXT 2>/dev/null | sort -V | tail -n 1)"
if [[ -n "$runtime_license" && -n "$runtime_notices" ]]; then
  cp "$runtime_license" "$worker/DotNet.LICENSE.txt"
  cp "$runtime_notices" "$worker/DotNet.NOTICES.txt"
else
  echo "Could not locate the .NET runtime licenses under $runtime_root" >&2
  exit 1
fi

echo "==> FBX exporter (Assimp)"
cmake -S "$root/native/fbx" -B "$deps/fbx-build-linux" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release "-DASSIMP_SOURCE_DIR=$deps/assimp"
cmake --build "$deps/fbx-build-linux" --target opensix-fbx --parallel
cp "$deps/fbx-build-linux/opensix-fbx" "$worker/"
{
  for notice in LICENSE contrib/rapidjson/license.txt contrib/zlib/LICENSE contrib/utf8cpp/doc/LICENSE contrib/earcut-hpp/LICENSE; do
    cat "$deps/assimp/$notice"
    printf '\n\n'
  done
} > "$worker/Assimp.LICENSE.txt"

echo "==> Node tests"
node --test "$root/scripts/test-outfits.mjs"

echo "==> Electron UI and Linux packages"
(
  cd "$root/app"
  npm ci --ignore-scripts
  node ./node_modules/electron/install.js
  npm run build:ui
  # Catch missing optional-asset reads before packaging: names.mjs used to
  # crash at startup when the gitignored verified-paths list was absent.
  node --input-type=module -e "await import('./names.mjs')"
  ./node_modules/.bin/electron-builder --linux --config electron-builder.linux.yml --publish never
)

echo "Linux build complete. Packages are in app/release/."
