param(
  [string]$BackendSource = $env:BAAS_ANDROID_BACKEND_SRC
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $BackendSource) {
  $BackendSource = Join-Path (Split-Path -Parent $repoRoot) "baas-dev"
}

$sourceRoot = Resolve-Path -LiteralPath $BackendSource -ErrorAction SilentlyContinue
if (-not $sourceRoot) {
  throw "BAAS Android backend source not found: $BackendSource. Set BAAS_ANDROID_BACKEND_SRC to the baas-dev path."
}

$required = @("main.service.py", "service", "core", "module", "src", "deploy")
foreach ($item in $required) {
  $path = Join-Path $sourceRoot.Path $item
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Backend source is missing required item: $path"
  }
}

$backendSha = ""
try {
  $backendSha = (& git -C $sourceRoot.Path rev-parse HEAD 2>$null).Trim()
} catch {
  $backendSha = ""
}

$destination = Join-Path $repoRoot "src-tauri\gen\android\app\src\main\python\baas_backend_bundle"
$resolvedRepo = (Resolve-Path -LiteralPath $repoRoot).Path
$parent = Split-Path -Parent $destination
New-Item -ItemType Directory -Force -Path $parent | Out-Null

if (Test-Path -LiteralPath $destination) {
  $resolvedDestination = (Resolve-Path -LiteralPath $destination).Path
  if (-not $resolvedDestination.StartsWith($resolvedRepo)) {
    throw "Refusing to delete destination outside repo: $resolvedDestination"
  }
  Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $destination | Out-Null

$files = @(
  "main.py",
  "main.service.py",
  "pyproject.toml",
  "requirements.txt",
  "requirements-linux.txt",
  "README.md",
  "LICENSE"
)

foreach ($file in $files) {
  $source = Join-Path $sourceRoot.Path $file
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $destination $file) -Force
  }
}

$directories = @("core", "module", "service", "src", "deploy")
foreach ($directory in $directories) {
  $source = Join-Path $sourceRoot.Path $directory
  $target = Join-Path $destination $directory
  robocopy $source $target /E /XD ".git" ".venv" "__pycache__" ".pytest_cache" ".mypy_cache" "node_modules" "dist" "build" "tests" "docs" "output" /XF "*.pyc" "*.pyo" "*.exe" "*.dll" ".DS_Store" | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed for $directory with exit code $LASTEXITCODE"
  }
}

$configTarget = Join-Path $destination "config"
New-Item -ItemType Directory -Force -Path $configTarget | Out-Null
foreach ($configItem in @("default_config", "static.json")) {
  $source = Join-Path $sourceRoot.Path "config\$configItem"
  if (Test-Path -LiteralPath $source) {
    if ((Get-Item -LiteralPath $source).PSIsContainer) {
      robocopy $source (Join-Path $configTarget $configItem) /E /XF "*.pyc" "*.pyo" | Out-Null
      if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed for config\$configItem with exit code $LASTEXITCODE"
      }
    } else {
      Copy-Item -LiteralPath $source -Destination (Join-Path $configTarget $configItem) -Force
    }
  }
}

$androidSetup = @"
[general]
channel = "dev"
mirrorc_cdk = ""
no_update = false
launch = true
git_backend = "auto"
current_baas_sha = "$backendSha"

[paths]
baas_root_path = "."

[python]
runtime_path = "embedded-python-3.9"
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $destination "setup.toml"), $androidSetup, $utf8NoBom)

$stamp = @{
  source = $sourceRoot.Path
  sha = $backendSha
  syncedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 2
Set-Content -LiteralPath (Join-Path $destination "android-backend-source.json") -Value $stamp -Encoding UTF8

$zipPath = Join-Path $repoRoot "src-tauri\gen\android\app\src\main\python\android_backend\baas_backend_bundle.zip"
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $destination -Recurse -File | ForEach-Object {
    $entryName = $_.FullName.Substring($destination.Length).TrimStart("\", "/").Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $_.FullName,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $zip.Dispose()
}

Write-Host "Synced Android backend from $($sourceRoot.Path) to $destination"
Write-Host "Packed Android backend zip at $zipPath"
