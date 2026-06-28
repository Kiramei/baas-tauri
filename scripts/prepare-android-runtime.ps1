param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonRoot = Join-Path $repoRoot "src-tauri\gen\android\app\src\main\python"
$bundleDir = Join-Path $pythonRoot "baas_backend_bundle"
$bundleZip = Join-Path $pythonRoot "android_backend\baas_backend_bundle.zip"
$pycache = Join-Path $pythonRoot "android_backend\__pycache__"

$resolvedRepo = (Resolve-Path -LiteralPath $repoRoot).Path
foreach ($path in @($bundleDir, $bundleZip, $pycache)) {
  if (-not (Test-Path -LiteralPath $path)) {
    continue
  }
  $resolved = (Resolve-Path -LiteralPath $path).Path
  if (-not $resolved.StartsWith($resolvedRepo)) {
    throw "Refusing to delete Android runtime artifact outside repo: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

Write-Host "Prepared lightweight Android runtime. Backend repository will be installed at first run."
