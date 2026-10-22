param(
    [string]$Root = 'docs/public/media',
    [string]$Output = '.cache/docs-privacy/media-ocr.json'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Wait-WinRT($Operation, [type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

$language = New-Object Windows.Globalization.Language('zh-Hans-CN')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) { throw 'Install the Windows Simplified Chinese OCR language pack first.' }
$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
$destination = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Output))
$records = New-Object System.Collections.Generic.List[object]
$files = @(Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse | Where-Object {
    $_.Extension.ToLowerInvariant() -in @('.png', '.jpg', '.jpeg', '.gif', '.webp')
} | Sort-Object FullName)

foreach ($file in $files) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $stream = $null
    $frames = New-Object System.Collections.Generic.List[object]
    $failure = $null
    try {
        $storageFile = Wait-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file.FullName)) ([Windows.Storage.StorageFile])
        $stream = Wait-WinRT ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Wait-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        for ($index = 0; $index -lt $decoder.FrameCount; $index++) {
            $frame = Wait-WinRT ($decoder.GetFrameAsync($index)) ([Windows.Graphics.Imaging.BitmapFrame])
            $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
            $scale = [Math]::Min(1.0, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [double][Math]::Max($frame.PixelWidth, $frame.PixelHeight))
            $transform.ScaledWidth = [Math]::Max(1, [uint32]($frame.PixelWidth * $scale))
            $transform.ScaledHeight = [Math]::Max(1, [uint32]($frame.PixelHeight * $scale))
            $bitmap = Wait-WinRT ($frame.GetSoftwareBitmapAsync(
                [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
                $transform,
                [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
                [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
            )) ([Windows.Graphics.Imaging.SoftwareBitmap])
            try {
                $result = Wait-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
                $frames.Add([pscustomobject]@{
                    frame = $index
                    text = $result.Text
                    lines = @($result.Lines | ForEach-Object { $_.Text })
                })
            } finally { $bitmap.Dispose() }
        }
    } catch {
        $failure = $_.Exception.Message
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
        $failure = 'Image changed during OCR; scan it again.'
    }
    $records.Add([pscustomobject]@{
        file = $file.FullName.Substring($resolvedRoot.Length + 1).Replace('\', '/')
        sha256 = $hash
        frames = @($frames.ToArray())
        failure = $failure
    })
    if ($records.Count % 20 -eq 0) { Write-Output ('OCR reviewed {0}/{1} files' -f $records.Count, $files.Count) }
}

$parent = [IO.Path]::GetDirectoryName($destination)
[IO.Directory]::CreateDirectory($parent) | Out-Null
$payload = [pscustomobject]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    engine = 'Local Windows OCR, zh-Hans-CN; all image/GIF frames; heuristic review aid only'
    files = @($records.ToArray())
}
$payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $destination -Encoding UTF8
Write-Output ('Files: {0}; failed: {1}; frames: {2}' -f $records.Count,
    @($records | Where-Object failure).Count,
    ($records | ForEach-Object { $_.frames.Count } | Measure-Object -Sum).Sum)
