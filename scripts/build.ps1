#Requires -Version 7.3
param([switch] $Portable)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path -Parent $PSScriptRoot
$upstream = 'https://github.com/holdmysocks/SixNG.git'
$revision = '08f1c2ed211aa80cfc7b0edfc472b89a723a3567'
$decoder = Join-Path $root '.deps/sixng'
$patch = Join-Path $root 'third_party/sixng/preview-api.patch'
$app = Join-Path $root 'app'
$target = 'x86_64-pc-windows-msvc'

if (!(Test-Path -LiteralPath (Join-Path $decoder '.git'))) {
    New-Item -ItemType Directory -Force -Path $decoder | Out-Null
    git -C $decoder init --quiet
    git -C $decoder remote add origin $upstream
    git -C $decoder -c advice.detachedHead=false fetch --depth 1 origin $revision
    git -C $decoder -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
}
if ((git -C $decoder rev-parse HEAD) -ne $revision) {
    throw 'The SixNG checkout in .deps/sixng is at a different revision.'
}

# Starting from an already patched checkout is supported.
$PSNativeCommandUseErrorActionPreference = $false
git -C $decoder apply --reverse --check $patch 2>$null
$applied = $LASTEXITCODE -eq 0
$PSNativeCommandUseErrorActionPreference = $true
if (!$applied) {
    git -C $decoder apply $patch
}

$previousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = ('{0} -C target-feature=+crt-static' -f $previousRustFlags).Trim()
    cargo build --locked --release --target $target --manifest-path (Join-Path $root 'native/preview/Cargo.toml')
} finally {
    $env:RUSTFLAGS = $previousRustFlags
}
$worker = Join-Path $app 'worker'
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'native/preview/target' }
New-Item -ItemType Directory -Force -Path $worker | Out-Null
Copy-Item -LiteralPath (Join-Path $targetDir "$target/release/opensix-preview.exe") -Destination $worker -Force

Push-Location $app
try {
    npm ci --ignore-scripts
    node './node_modules/electron/install.js'
    npm run build:ui
    if ($Portable) {
        & '.\node_modules\.bin\electron-builder.cmd' --win portable --x64 --config.electronDist=node_modules/electron/dist
    }
} finally {
    Pop-Location
}
