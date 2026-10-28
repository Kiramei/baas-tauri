param([Parameter(Mandatory = $true)][string]$NemuSdkPath)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$recordPath = Join-Path $root 'docs/public/benchmarks/device-current.json'
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$sdk = Get-Item -LiteralPath $NemuSdkPath
if ($sdk.Name -ne 'external_renderer_ipc.dll') { throw 'Expected the SDK library used by NemuClient.' }
$os = Get-CimInstance Win32_OperatingSystem
$payload = [ordered]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    scope = 'Post-run host and MuMu SDK inventory; collected separately from the before-run source snapshots.'
    rawRecordSha256 = (Get-FileHash -LiteralPath $recordPath -Algorithm SHA256).Hash.ToLowerInvariant()
    processors = @(Get-CimInstance Win32_Processor | ForEach-Object {
        [ordered]@{ name = $_.Name.Trim(); logicalProcessors = $_.NumberOfLogicalProcessors }
    })
    totalVisibleMemoryKiB = [long]$os.TotalVisibleMemorySize
    windowsVersion = $os.Version
    nemuSdk = [ordered]@{
        file = $sdk.Name
        sha256 = (Get-FileHash -LiteralPath $sdk.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = $sdk.Length
        fileVersion = $(if ($sdk.VersionInfo.FileVersion) { $sdk.VersionInfo.FileVersion } else { $null })
        productVersion = $(if ($sdk.VersionInfo.ProductVersion) { $sdk.VersionInfo.ProductVersion } else { $null })
        lastWriteUtc = $sdk.LastWriteTimeUtc.ToString('o')
        lastWritePredatesSampling = $sdk.LastWriteTimeUtc -lt [DateTime]::Parse($record.startedAt).ToUniversalTime()
    }
    limits = 'File timestamps alone do not prove that a binary stayed unchanged throughout sampling. The SDK digest was collected after the run; its PE version fields may be unavailable.'
}
$destination = Join-Path $root 'docs/public/benchmarks/device-environment-audit.json'
[IO.File]::WriteAllText($destination, ($payload | ConvertTo-Json -Depth 6) + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false)))
Write-Output 'Saved post-run host/SDK inventory without host paths or machine identifiers.'
