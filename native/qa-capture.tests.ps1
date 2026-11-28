param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'qa-paths.ps1')
. (Join-Path $PSScriptRoot 'qa-capture.ps1')
$paths = Initialize-OmniaQaPaths -RepositoryRoot (Split-Path -Parent $PSScriptRoot) `
    -Executable $Executable -OutputDirectory $OutputDirectory -Profile debug
$cases = [Collections.Generic.List[string]]::new()
$process = $null
$mainHwnd = [IntPtr]::Zero
function Assert-Case([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "Assertion failed: $Name" }
    $cases.Add($Name)
}
function Assert-Refused([scriptblock]$Action, [string]$Message, [string]$Name) {
    $observed = $null
    try { & $Action | Out-Null } catch { $observed = $_.Exception.Message }
    Assert-Case ($null -ne $observed -and $observed -match $Message) $Name
}
try {
    # Visible QA is requested; this fixture opens no personal session database.
    $process = Start-Process -FilePath $paths.Executable -PassThru -WindowStyle Normal
    Initialize-OmniaQaCaptureInterop
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'Capture fixture exited during launch.' }
        $mainHwnd = Find-OmniaQaMainWindow -Process $process -PreferredClass 'OmniaNativeShellClass'
        if ($mainHwnd -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 40
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($mainHwnd -eq [IntPtr]::Zero) { throw 'Capture fixture discovery timed out.' }
    $before = [OmniaQaCapture]::GetThreadDpiAwarenessContext()
    $imagePath = Join-Path $paths.OutputDirectory 'capture.png'
    $capture = Save-OmniaQaWindowCapture -WindowHandle $mainHwnd -Process $process -Path $imagePath
    Assert-Case ([OmniaQaCapture]::GetThreadDpiAwarenessContext() -eq $before) 'success restores caller DPI'
    $image = [Drawing.Bitmap]::new($imagePath)
    try {
        Assert-Case ($image.Width -eq $capture.width -and $image.Height -eq $capture.height) 'PNG dimensions match capture receipt'
    } finally { $image.Dispose() }
    Assert-Case ($capture.processId -eq $process.Id -and
        $capture.processStartedUtc -eq $process.StartTime.ToUniversalTime().ToString('o')) 'receipt binds target PID and creation time'
    $hash = (Get-FileHash -LiteralPath $imagePath).Hash
    Assert-Refused { Save-OmniaQaWindowCapture $mainHwnd $process $imagePath } 'overwrite' 'existing capture refused'
    Assert-Case ((Get-FileHash -LiteralPath $imagePath).Hash -eq $hash) 'existing capture preserved'
    $rejectedPath = Join-Path $paths.OutputDirectory 'must-not-exist.png'
    Assert-Refused { Save-OmniaQaWindowCapture ([IntPtr]::Zero) $process $rejectedPath } 'invalid' 'invalid HWND refused'
    Assert-Case (-not (Test-Path -LiteralPath $rejectedPath)) 'invalid HWND creates no image'
    $observer = Get-Process -Id $PID
    Assert-Refused { Save-OmniaQaWindowCapture $mainHwnd $observer $rejectedPath } 'expected process' 'wrong process owner refused'
    Assert-Refused { Save-OmniaQaWindowCapture $mainHwnd $process 'relative.png' } 'absolute' 'relative path refused'
    Assert-Refused { Save-OmniaQaWindowCapture $mainHwnd $process $rejectedPath -MaximumDimension 1 } 'bounds invalid' 'dimension limit refused'
    Assert-Case ([OmniaQaCapture]::GetThreadDpiAwarenessContext() -eq $before) 'bounds failure restores caller DPI'
    Assert-Case (-not (Test-Path -LiteralPath $rejectedPath)) 'bounds failure creates no image'
    $badExtensionPath = Join-Path $paths.OutputDirectory 'directory.png'
    $null = New-Item -ItemType Directory -Path $badExtensionPath
    Assert-Refused { Save-OmniaQaWindowCapture $mainHwnd $process $badExtensionPath } 'overwrite' 'existing directory refused'
    if (-not (Close-OmniaQaWindow -WindowHandle $mainHwnd -Process $process -TimeoutMs 5000) -or $process.ExitCode -ne 0) {
        throw 'Capture fixture did not close cleanly.'
    }
    Assert-Refused { Save-OmniaQaWindowCapture $capture.windowHandle $process $rejectedPath } 'has exited' 'exited process refused'
    [ordered]@{
        scope = 'actual native window capture helper; no hidden/minimized/multimonitor qualification'
        passed = $cases.Count
        cases = $cases.ToArray()
        capture = $capture
        pixelReview = 'Separate manual inspection is required.'
        teardown = @{ exitCode=$process.ExitCode; verifiedAfterWait=$true }
    } | ConvertTo-Json -Depth 8
} finally {
    if ($process -and -not $process.HasExited) {
        $closed = Close-OmniaQaWindow -WindowHandle $mainHwnd -Process $process -TimeoutMs 5000
        if (-not $closed) {
            throw "Capture fixture still open: PID $($process.Id). Preserve for diagnosis."
        }
    }
}
