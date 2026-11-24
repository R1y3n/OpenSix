#Requires -Version 7.3
param([switch] $Portable)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path -Parent $PSScriptRoot
$decoder = Join-Path $root '.deps/sixng'
$assimp = Join-Path $root '.deps/assimp'
$fbxBuild = Join-Path $root '.deps/fbx-build'
$app = Join-Path $root 'app'
$target = 'x86_64-pc-windows-msvc'

function Initialize-Dependency($Path, $Repository, $Revision) {
    if (!(Test-Path -LiteralPath (Join-Path $Path '.git'))) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
        git -C $Path init --quiet
        git -C $Path remote add origin $Repository
        git -C $Path fetch --depth 1 origin $Revision
        git -C $Path checkout --quiet --detach FETCH_HEAD
    }
    if ((git -C $Path rev-parse HEAD) -ne $Revision) {
        throw "The dependency checkout at $Path is at a different revision."
    }
}

Initialize-Dependency $decoder 'https://github.com/holdmysocks/SixNG.git' '08f1c2ed211aa80cfc7b0edfc472b89a723a3567'
Initialize-Dependency $assimp 'https://github.com/assimp/assimp.git' 'a79ff6bbce54d3e01186a918dc6374ed55317426'

function Apply-DependencyPatch($Path, $Patch) {
    $PSNativeCommandUseErrorActionPreference = $false
    git -C $Path apply --reverse --check $Patch 2>$null
    $applied = $LASTEXITCODE -eq 0
    $PSNativeCommandUseErrorActionPreference = $true
    if (!$applied) {
        git -C $Path apply $Patch
    }
}

Apply-DependencyPatch $decoder (Join-Path $root 'third_party/sixng/preview-api.patch')
Apply-DependencyPatch $assimp (Join-Path $root 'third_party/assimp/fbx-uv-layers.patch')

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

cmake -S (Join-Path $root 'native/fbx') -B $fbxBuild -G Ninja -DCMAKE_BUILD_TYPE=Release "-DASSIMP_SOURCE_DIR=$assimp"
cmake --build $fbxBuild --target opensix-fbx --parallel
Copy-Item -LiteralPath (Join-Path $fbxBuild 'opensix-fbx.exe') -Destination $worker -Force
$notices = @('LICENSE','contrib/rapidjson/license.txt','contrib/zlib/LICENSE','contrib/utf8cpp/doc/LICENSE','contrib/earcut-hpp/LICENSE')
($notices | ForEach-Object { Get-Content -LiteralPath (Join-Path $assimp $_) -Raw }) -join "`n`n" |
    Set-Content -LiteralPath (Join-Path $worker 'Assimp.LICENSE.txt') -Encoding utf8

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
