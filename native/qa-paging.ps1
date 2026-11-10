param([Parameter(Mandatory)][string]$Database, [switch]$KeepOpen)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientsideProviders
Add-Type -AssemblyName System.Drawing
$null = [Windows.Automation.AutomationElement]::RootElement
[Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
    [Reflection.AssemblyName]::new('UIAutomationClientsideProviders'))
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniaPagingQa {
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
}
'@
$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs/rebuild/receipts'
$exe = Join-Path $PSScriptRoot 'target/release/omnia-native.exe'
$cases = [Collections.Generic.List[object]]::new()
function Open-App {
    # Visible live progress was explicitly requested.
    $script:process = Start-Process -FilePath $exe -ArgumentList @('--session-db', "`"$Database`"") -PassThru -WindowStyle Normal
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'App exited before window discovery' }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Window discovery timed out' }
    $script:root = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}
function Control([int]$id) {
    $item = $root.FindFirst([Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,[string]$id))
    if ($null -eq $item) { throw "Missing UIA ID$id" }
    return $item
}
function Invoke-Control([int]$id) {
    if (-not (Control $id).Current.IsEnabled) { throw "Control $id disabled" }
    (Control $id).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function Rows {
    return @((Control 120).FindAll([Windows.Automation.TreeScope]::Children,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,
            [Windows.Automation.ControlType]::ListItem)) | ForEach-Object { $_.Current.Name })
}
function Wait-Page([int]$count,[string]$first,[bool]$hasPrevious,[bool]$hasNext) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $rows = @(Rows)
        $status = (Control 126).Current.Name
        if ($rows.Count -eq $count -and $rows[0] -eq $first -and
            (Control 128).Current.IsEnabled -eq $hasPrevious -and
            (Control 129).Current.IsEnabled -eq $hasNext -and
            $status.StartsWith('Settings revision')) {
            $title = (Control 122).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
            if ($title -ne 'Off-page active') { throw 'Paging lost active session metadata' }
            $cases.Add(@{case="page-$first";passed=$true;rows=$count;previous=$hasPrevious;next=$hasNext;activeTitlePreserved=$true;observedWaitMilliseconds=$timer.Elapsed.TotalMilliseconds})
            return
        }
        Start-Sleep -Milliseconds 50
    } while ($timer.Elapsed.TotalSeconds -lt 10)
    throw "Page timeout: count=$($rows.Count), first=$($rows[0]), status=$status"
}
function Close-App {
    if (-not $process.CloseMainWindow() -or -not $process.WaitForExit(5000)) { throw 'Clean close failed' }
    if ($process.ExitCode -ne 0) { throw "Nonzero close $($process.ExitCode)" }
}
try {
    Open-App
    Wait-Page 50 'Synthetic session 0000' $false $true
    if (-not (Control 126).Current.Name.Contains('outside this page')) { throw 'Off-page active explanation missing' }
    Invoke-Control 129
    Wait-Page 50 'Synthetic session 0050' $true $true
    Invoke-Control 129
    Wait-Page 25 'Synthetic session 0100' $true $false
    $lastRows = @(Rows)
    if ($lastRows[-1] -ne 'Off-page active') { throw 'Stable last-row ordering mismatch' }
    Invoke-Control 128
    Wait-Page 50 'Synthetic session 0050' $true $true
    Invoke-Control 127
    Wait-Page 50 'Synthetic session 0000' $false $true
    Close-App
    $cases.Add(@{case='clean-close';passed=$true;exitCode=$process.ExitCode})
    Open-App
    Wait-Page 50 'Synthetic session 0000' $false $true
    # Hold a real writer lock so pending controls can be observed reliably.
    # Python is QA tooling only, not a product dependency.
    (Control 123).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('qa/native')
    $lockInfo = [Diagnostics.ProcessStartInfo]::new('python')
    $lockInfo.UseShellExecute = $false
    $lockInfo.CreateNoWindow = $true
    $lockInfo.RedirectStandardInput = $true
    $lockInfo.RedirectStandardOutput = $true
    $lockInfo.ArgumentList.Add('-c')
    $lockInfo.ArgumentList.Add("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); print('locked',flush=True); sys.stdin.readline(); c.rollback(); c.close()")
    $lockInfo.ArgumentList.Add($Database)
    $locker = [Diagnostics.Process]::Start($lockInfo)
    try {
        $ready = $locker.StandardOutput.ReadLineAsync()
        if (-not $ready.Wait(3000) -or $ready.Result -ne 'locked') { throw 'Writer lock setup failed' }
        Invoke-Control 125
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            $pending = (Control 126).Current.Name.Contains('pending')
            if ($pending) { break }
            Start-Sleep -Milliseconds 20
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $pending) { throw 'Pending worker was not observed' }
        foreach ($id in @(122,123,124,125,128,129)) {
            if ((Control $id).Current.IsEnabled) { throw "Metadata control $id writable while pending" }
        }
        if (-not (Control 112).Current.IsEnabled) { throw 'Scratch blocked by database lock' }
        Invoke-Control 102
        if (-not (Control 110).Current.Name.StartsWith("Browser`n")) { throw 'Mode failed while SQLite worker pending' }
        $cases.Add(@{case='writer-lock-pending';passed=$true;metadataInputsDisabled=$true;scratchEnabled=$true;modeHeadingChanged=$true})
    } finally {
        if ($locker -and -not $locker.HasExited) {
            $locker.StandardInput.WriteLine('release')
            if (-not $locker.WaitForExit(3000)) { $locker.Kill(); throw 'QA locker failed release' }
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        if ((Control 126).Current.Name.StartsWith('Settings revision 2')) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not (Control 126).Current.Name.StartsWith('Settings revision 2') -or -not (Control 123).Current.IsEnabled) {
        throw 'Save did not complete and restore metadata inputs after lock release'
    }
    if ((Control 123).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value -ne 'qa/native') { throw 'Saved model lost after worker response' }
    Invoke-Control 101
    $cases.Add(@{case='writer-lock-release';passed=$true;revision=2;modelReadback=$true;inputsRestored=$true})
    $rect = [OmniaPagingQa+Rect]::new()
    if (-not [OmniaPagingQa]::GetWindowRect($process.MainWindowHandle,[ref]$rect)) { throw 'Capture bounds failed' }
    $bitmap = [Drawing.Bitmap]::new($rect.Right-$rect.Left,$rect.Bottom-$rect.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $dc = $graphics.GetHdc()
    try {
        if (-not [OmniaPagingQa]::PrintWindow($process.MainWindowHandle,$dc,2)) { throw 'Capture failed' }
    } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
    $image = Join-Path $out 'native-paging-cycle26-window.png'
    try { $bitmap.Save($image,[Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
    $process.Refresh()
    $receipt = @{
        schemaVersion=1;recordedAt=[DateTime]::UtcNow.ToString('o');scope='native metadata paging, synthetic125row fixture';
        database=$Database;cases=$cases.ToArray();
        executable=@{sha256=(Get-FileHash $exe).Hash;bytes=(Get-Item $exe).Length};
        script=@{sha256=(Get-FileHash $PSCommandPath).Hash};
        process=@{pid=$process.Id;responding=$process.Responding;workingSetBytes=$process.WorkingSet64};
        capture=@{path=$image;sha256=(Get-FileHash $image).Hash};
        limits=@('Per-page snapshot only; writes between requests may move rows','No physical keyboard/IME or Narrator check','Observed wait includes polling/UIA; not input p95 or a performance benchmark','No provider/final visual/IDE/browser claim')
    }
    if ($KeepOpen) { $receipt.teardown='left-visible' } else { Close-App; $receipt.teardown=@{exitCode=$process.ExitCode;verifiedAfterWait=$true} }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $out 'native-paging-cycle26-runtime.json')
    $receipt | ConvertTo-Json -Depth 6
} catch {
    @{error=$_.ToString();cases=$cases.ToArray();recordedAt=[DateTime]::UtcNow.ToString('o')} |
        ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out ("native-paging-cycle26-qa-failure-"+[DateTime]::UtcNow.ToString('HHmmss')+'.json'))
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
    throw
}
