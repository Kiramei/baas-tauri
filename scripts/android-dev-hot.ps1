param(
  [string]$Device = $env:BAAS_ANDROID_DEVICE,
  [string]$BackendSource = $env:BAAS_ANDROID_BACKEND_SRC,
  [string]$DevUrl = "http://127.0.0.1:8191",
  [ValidateSet("arm64", "arm", "x86", "x86_64")]
  [string]$Abi = "x86_64",
  [switch]$InstallShell,
  [switch]$NoLaunch,
  [switch]$KeepMarker,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $repoRoot "src-tauri\gen\android"
Set-Location $repoRoot

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
  throw "JAVA_HOME is not set. Install JDK 17+ or set JAVA_HOME before running Android hot dev."
}
$env:Path = "$(Join-Path $env:JAVA_HOME "bin");$env:Path"

if (-not $env:ANDROID_HOME) {
  $defaultSdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  if (Test-Path -LiteralPath $defaultSdk) {
    $env:ANDROID_HOME = $defaultSdk
  }
}
if (-not $env:ANDROID_HOME) {
  throw "ANDROID_HOME is not set. Install Android SDK or set ANDROID_HOME before running Android hot dev."
}
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$localProperties = Join-Path $androidRoot "local.properties"
$sdkDir = $env:ANDROID_HOME.Replace("\", "/")
Set-Content -LiteralPath $localProperties -Value "sdk.dir=$sdkDir" -Encoding ASCII

$adb = "adb"
$deviceLines = @(& $adb devices | Select-String "`tdevice$")
if (-not $Device) {
  $preferred = $deviceLines | Where-Object { $_.Line.StartsWith("emulator-5556`t") } | Select-Object -First 1
  if ($preferred) {
    $Device = "emulator-5556"
  } elseif ($deviceLines.Count -gt 0) {
    $Device = ($deviceLines[0].Line -split "`t")[0]
  }
}
if (-not $Device) {
  throw "No Android device is connected. Start an emulator or pass -Device <serial>."
}

& $adb -s $Device reverse tcp:8191 tcp:8191 | Out-Null
Write-Host "Android frontend HMR: device $Device -> host http://127.0.0.1:8191"
if ($DryRun) {
  Write-Host "Dry run complete."
  exit 0
}

if ($InstallShell) {
  if ($BackendSource) {
    $env:BAAS_ANDROID_BACKEND_SRC = $BackendSource
  }
  powershell -ExecutionPolicy Bypass -File "scripts\android-build-debug.ps1" -SkipWebBuild -Abi $Abi
  $apk = Resolve-Path "src-tauri\gen\android\app\build\outputs\apk\$Abi\debug\app-$Abi-debug.apk"
  & $adb -s $Device install -r -d $apk
}

$packageName = "io.github.kiramei.baas_tauri"
$logDir = Join-Path $repoRoot ".cache"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$marker = Join-Path $logDir "baas-tauri-dev-url.txt"

function Set-AndroidDevUrlMarker {
  Set-Content -LiteralPath $marker -Value $DevUrl -NoNewline -Encoding ASCII
  & $adb -s $Device push $marker /data/local/tmp/baas-tauri-dev-url.txt | Out-Null
  & $adb -s $Device shell run-as $packageName cp /data/local/tmp/baas-tauri-dev-url.txt files/baas-tauri-dev-url.txt
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to write dev URL marker. Install a debug APK first, or rerun with -InstallShell."
  }
}

function Clear-AndroidDevUrlMarker {
  & $adb -s $Device shell run-as $packageName rm -f files/baas-tauri-dev-url.txt 2>$null | Out-Null
}

$viteOut = Join-Path $logDir "android-vite-hot.log"
$viteErr = Join-Path $logDir "android-vite-hot.err"
Remove-Item -LiteralPath $viteOut, $viteErr -Force -ErrorAction SilentlyContinue

$vite = Start-Process `
  -FilePath "powershell" `
  -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "bun dev:android") `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $viteOut `
  -RedirectStandardError $viteErr `
  -PassThru

try {
  $ready = $false
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $DevUrl -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {
      if ($vite.HasExited) {
        break
      }
    }
  }

  if (-not $ready) {
    $stdout = Get-Content -LiteralPath $viteOut -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content -LiteralPath $viteErr -Raw -ErrorAction SilentlyContinue
    throw "Vite Android dev server did not become ready.`n$stdout`n$stderr"
  }

  if (-not $NoLaunch) {
    Set-AndroidDevUrlMarker
    & $adb -s $Device shell am force-stop $packageName | Out-Null
    & $adb -s $Device shell monkey -p $packageName -c android.intent.category.LAUNCHER 1 | Out-Null
    if (-not $KeepMarker) {
      Start-Sleep -Seconds 3
      Clear-AndroidDevUrlMarker
    }
  } elseif ($KeepMarker) {
    Set-AndroidDevUrlMarker
  }

  Write-Host "Hot dev is running at $DevUrl."
  Write-Host "Vite logs: $viteOut"
  Write-Host "Press Ctrl+C to stop the dev server."
  Wait-Process -Id $vite.Id
} finally {
  if ($vite -and -not $vite.HasExited) {
    taskkill /PID $vite.Id /T /F | Out-Null
  }
  if (-not $KeepMarker) {
    Clear-AndroidDevUrlMarker
  }
}
