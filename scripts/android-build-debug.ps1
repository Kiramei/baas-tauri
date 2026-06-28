param(
  [switch]$SkipWebBuild
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

$targets = @(
  @{ Rust = "aarch64-linux-android"; Abi = "arm64-v8a" },
  @{ Rust = "armv7-linux-androideabi"; Abi = "armeabi-v7a" },
  @{ Rust = "i686-linux-android"; Abi = "x86" },
  @{ Rust = "x86_64-linux-android"; Abi = "x86_64" }
)

Push-Location $repoRoot
try {
  if (-not $SkipWebBuild) {
    bun run build:tauri:android
    if ($LASTEXITCODE -ne 0) {
      throw "Frontend Android build failed with exit code $LASTEXITCODE"
    }
  } else {
    powershell -ExecutionPolicy Bypass -File "scripts\sync-android-backend.ps1"
    if ($LASTEXITCODE -ne 0) {
      throw "Android backend sync failed with exit code $LASTEXITCODE"
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

  foreach ($target in $targets) {
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

    $destinationDir = Join-Path $jniRoot $target.Abi
    New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDir "libbaas_tauri_lib.so") -Force
  }

  Push-Location $androidRoot
  try {
    .\gradlew.bat `
      :app:assembleUniversalDebug `
      -x rustBuildUniversalDebug `
      -x rustBuildArm64Debug `
      -x rustBuildArmDebug `
      -x rustBuildX86Debug `
      -x rustBuildX86_64Debug
    if ($LASTEXITCODE -ne 0) {
      throw "Gradle Android build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
