param(
  [string]$BuildRoot = "$PSScriptRoot\..\.context\airplay-runtime",
  [string]$Revision = '5497138ed8b2fb5106df1532d325e30f63baf9ed'
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $BuildRoot 'Popyachsa-AirPlay'
$repo = 'https://github.com/Recluse/Popyachsa-AirPlay.git'
$msys = if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { 'C:\msys64' }
$bash = Join-Path $msys 'usr\bin\bash.exe'
if (-not (Test-Path -LiteralPath $bash)) { throw "MSYS2 was not found at $msys" }
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $source)) {
  git clone --recurse-submodules --depth 1 $repo $source
}
git -C $source fetch --depth 1 origin $Revision
git -C $source checkout --detach $Revision
$unixSource = (& $bash -lc "cygpath -u '$source'").Trim()
$packages = 'mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-gstreamer mingw-w64-ucrt-x86_64-gst-plugins-base mingw-w64-ucrt-x86_64-gst-plugins-good mingw-w64-ucrt-x86_64-gst-plugins-bad mingw-w64-ucrt-x86_64-gst-plugins-ugly mingw-w64-ucrt-x86_64-gst-libav mingw-w64-ucrt-x86_64-openssl mingw-w64-ucrt-x86_64-libplist'
& $bash -lc "pacman --noconfirm -S --needed $packages"
& $bash -lc "cd '$unixSource/third_party/uxplay' && cmake -S . -B build -G Ninja -DBUILD_CORE_DLL=ON -DNO_MARCH_NATIVE=ON && ninja -C build uxplay-core"
Push-Location $source
try { cargo build --release } finally { Pop-Location }
& $bash -lc "cd '$unixSource' && powershell.exe -NoProfile -ExecutionPolicy Bypass -File app/make-dist.ps1"
$dist = Join-Path $source 'dist'
if (-not (Test-Path -LiteralPath $dist)) { throw "Popyachsa did not produce $dist" }
Write-Output (ConvertTo-Json @{ repository = $repo; revision = $Revision; bundle = $dist })
