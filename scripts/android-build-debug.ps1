param(
  [switch]$SkipWebBuild,
  [ValidateSet("arm64", "arm", "x86", "x86_64")]
  [string]$Abi = "x86_64"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $repoRoot "src-tauri\gen\android"
$jniRoot = Join-Path $androidRoot "app\src\main\jniLibs"
$webDist = Join-Path $repoRoot "dist"
$androidAssets = Join-Path $androidRoot "app\src\main\assets"

if (-not $env:JAVA_HOME) {
  $jdkRoot = "C:\Program Files\Eclipse Adoptium"
  if (Test-Path -LiteralPath $jdkRoot) {
    $jdk = Get-ChildItem -LiteralPath $jdkRoot -Directory -Filter "jdk-*" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($jdk) {
      $env:JAVA_HOME = $jdk.FullName
    }
  }
}

if (-not $env:JAVA_HOME) {
  throw "JAVA_HOME is not set. Install JDK 17+ or set JAVA_HOME before building Android."
}

$env:Path = "$(Join-Path $env:JAVA_HOME "bin");$env:Path"

if (-not $env:ANDROID_HOME) {
  $defaultSdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  if (Test-Path -LiteralPath $defaultSdk) {
    $env:ANDROID_HOME = $defaultSdk
  }
}

if (-not $env:ANDROID_HOME) {
  throw "ANDROID_HOME is not set. Install Android SDK or set ANDROID_HOME before building Android."
}

$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$localProperties = Join-Path $androidRoot "local.properties"
$sdkDir = $env:ANDROID_HOME.Replace("\", "/")
Set-Content -LiteralPath $localProperties -Value "sdk.dir=$sdkDir" -Encoding ASCII

$targets = @{
  "arm64" = @{ Rust = "aarch64-linux-android"; AndroidAbi = "arm64-v8a"; Gradle = "Arm64"; NdkLibcxx = "aarch64-linux-android" }
  "arm" = @{ Rust = "armv7-linux-androideabi"; AndroidAbi = "armeabi-v7a"; Gradle = "Arm"; NdkLibcxx = "arm-linux-androideabi" }
  "x86" = @{ Rust = "i686-linux-android"; AndroidAbi = "x86"; Gradle = "X86"; NdkLibcxx = "i686-linux-android" }
  "x86_64" = @{ Rust = "x86_64-linux-android"; AndroidAbi = "x86_64"; Gradle = "X86_64"; NdkLibcxx = "x86_64-linux-android" }
}
$target = $targets[$Abi]

Push-Location $repoRoot
try {
  if (-not $SkipWebBuild) {
    bun run build:tauri:android
    if ($LASTEXITCODE -ne 0) {
      throw "Frontend Android build failed with exit code $LASTEXITCODE"
    }
  } else {
    powershell -ExecutionPolicy Bypass -File "scripts\prepare-android-runtime.ps1"
    if ($LASTEXITCODE -ne 0) {
      throw "Android runtime preparation failed with exit code $LASTEXITCODE"
    }
  }

  if (-not (Test-Path -LiteralPath (Join-Path $webDist "index.html"))) {
    throw "Missing frontend dist. Run without -SkipWebBuild at least once: $webDist"
  }

  $resolvedRepo = (Resolve-Path -LiteralPath $repoRoot).Path
  if (Test-Path -LiteralPath $androidAssets) {
    $resolvedAssets = (Resolve-Path -LiteralPath $androidAssets).Path
    if (-not $resolvedAssets.StartsWith($resolvedRepo)) {
      throw "Refusing to delete Android assets outside repo: $resolvedAssets"
    }
    Remove-Item -LiteralPath $resolvedAssets -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $androidAssets | Out-Null
  Copy-Item -Path (Join-Path $webDist "*") -Destination $androidAssets -Recurse -Force

  if (Test-Path -LiteralPath $jniRoot) {
    $resolvedJni = (Resolve-Path -LiteralPath $jniRoot).Path
    if (-not $resolvedJni.StartsWith($resolvedRepo)) {
      throw "Refusing to delete JNI libraries outside repo: $resolvedJni"
    }
    Remove-Item -LiteralPath $resolvedJni -Recurse -Force
  }

  cargo build `
    --package baas-tauri `
    --manifest-path "src-tauri\Cargo.toml" `
    --target $target.Rust `
    --features "tauri/custom-protocol"
  if ($LASTEXITCODE -ne 0) {
    throw "Rust Android build failed for $($target.Rust) with exit code $LASTEXITCODE"
  }

  $source = Join-Path $repoRoot "target\$($target.Rust)\debug\libbaas_tauri_lib.so"
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing Rust Android library: $source"
  }

  $destinationDir = Join-Path $jniRoot $target.AndroidAbi
  New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
  Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDir "libbaas_tauri_lib.so") -Force

  $ndkRoot = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME "ndk") -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if (-not $ndkRoot) {
    throw "Android NDK is required to package libc++_shared.so."
  }
  $libcxx = Join-Path $ndkRoot.FullName "toolchains\llvm\prebuilt\windows-x86_64\sysroot\usr\lib\$($target.NdkLibcxx)\libc++_shared.so"
  if (-not (Test-Path -LiteralPath $libcxx)) {
    throw "Missing Android libc++ runtime: $libcxx"
  }
  Copy-Item -LiteralPath $libcxx -Destination (Join-Path $destinationDir "libc++_shared.so") -Force

  Push-Location $androidRoot
  try {
    $assembleTask = ":app:assemble$($target.Gradle)Debug"
    $skipRustTask = "rustBuild$($target.Gradle)Debug"
    .\gradlew.bat `
      $assembleTask `
      -x `
      $skipRustTask
    if ($LASTEXITCODE -ne 0) {
      throw "Gradle Android build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
