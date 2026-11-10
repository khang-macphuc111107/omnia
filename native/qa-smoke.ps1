param([switch]$KeepOpen)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OmniaShellQa {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowTextW(IntPtr hwnd, string text);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, UIntPtr wp, StringBuilder lp, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendText(IntPtr hwnd, uint msg, UIntPtr wp, string lp, uint flags, uint timeout, out UIntPtr result);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
}
'@
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo 'docs/rebuild/receipts'
$exe = Join-Path $PSScriptRoot 'target/release/omnia-native.exe'
$timer = [Diagnostics.Stopwatch]::StartNew()
# Visible window is expressly requested by the user for live progress.
$process = Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Normal
$cases = [Collections.Generic.List[object]]::new()
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "Native executable exited before showing a window." }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Window discovery timeout.' }
    $mainHwnd = $process.MainWindowHandle
    $discoveryMs = $timer.Elapsed.TotalMilliseconds
    $root = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $scope = [Windows.Automation.TreeScope]::Descendants
    function Find-Control([string]$type, [string]$name) {
        $controlDeadline = [DateTime]::UtcNow.AddSeconds(3)
        do {
            $controls = $root.FindAll($scope, [Windows.Automation.Condition]::TrueCondition)
            foreach ($control in $controls) {
                if ($control.Current.ControlType.ProgrammaticName -eq "ControlType.$type" -and
                    ($name -eq '' -or $control.Current.Name -eq $name)) { return $control }
            }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $controlDeadline)
        $controls | ForEach-Object { Write-Output "$($_.Current.ControlType.ProgrammaticName): $($_.Current.Name)" } |
            Set-Content (Join-Path $out 'native-shell-cycle24-uia-failure.txt')
        throw "Missing UIA control: $type $name"
    }
    # Keep UIA failures visible; native control-message smoke is a separate
    # interaction method and cannot certify accessibility or physical input.
    $uiaIssue = $null
    try { $null = Find-Control 'Edit' '' } catch { $uiaIssue = $_.Exception.Message }
    $edit = [OmniaShellQa]::GetDlgItem($process.MainWindowHandle, 112)
    if ($edit -eq [IntPtr]::Zero) { throw 'Native edit HWND missing.' }
    function Read-Text([IntPtr]$hwnd) {
        $buffer = [Text.StringBuilder]::new(70000)
        $result = [UIntPtr]::Zero
        $ok = [OmniaShellQa]::SendMessageTimeoutW($hwnd, 0x000D, [UIntPtr]$buffer.Capacity, $buffer, 2, 2000, [ref]$result)
        if ($ok -eq [IntPtr]::Zero) { throw 'WM_GETTEXT timed out or failed.' }
        return $buffer.ToString()
    }
    $draft = 'Omnia native QA — tiếng Việt: dự án, toán học; 日本語; ∑ x²'
    $setResult = [UIntPtr]::Zero
    if ([OmniaShellQa]::SendText($edit, 0x000C, [UIntPtr]::Zero, $draft, 2, 2000, [ref]$setResult) -eq [IntPtr]::Zero -or $setResult -eq [UIntPtr]::Zero) { throw 'WM_SETTEXT failed.' }
    if ((Read-Text $edit) -ne $draft) { throw 'Initial WM_SETTEXT readback failed.' }
    foreach ($entry in @(@('Browser',102), @('IDE',103), @('Chat',101))) {
        $mode = $entry[0]
        $button = [OmniaShellQa]::GetDlgItem($process.MainWindowHandle, $entry[1])
        [void][OmniaShellQa]::SendMessageW($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 100
        $expected = if ($mode -eq 'Chat') { 'Chat / No project' } else { $mode }
        $heading = Read-Text ([OmniaShellQa]::GetDlgItem($process.MainWindowHandle, 110))
        if (-not $heading.StartsWith($expected + "`n")) {
            throw "Mode header did not change to $mode"
        }
        $actualDraft = Read-Text $edit
        if ($actualDraft -ne $draft) { throw "Draft mismatch after $mode. Expected $($draft.Length) chars; actual $($actualDraft.Length): $actualDraft" }
        $cases.Add(@{case="switch-$mode";method='Win32 BM_CLICK + HWND text readback';passed=$true;unicodeDraftPreserved=$true})
    }
    [void][OmniaShellQa]::PostMessageW($mainHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    $dialogDeadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $dialog = [OmniaShellQa]::GetLastActivePopup($mainHwnd)
        $no = [OmniaShellQa]::GetDlgItem($dialog, 7)
        if ($no -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $dialogDeadline)
    if ($no -eq [IntPtr]::Zero) { throw 'Unsaved-close No button missing from stable root HWND.' }
    [void][OmniaShellQa]::SendMessageW($no, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
    if ((Read-Text $edit) -ne $draft) { throw 'Cancel close lost draft.' }
    $cases.Add(@{case='cancel-unsaved-close';passed=$true;method='stable HWND modal BM_CLICK and WM_GETTEXT'})
    $setResult = [UIntPtr]::Zero
    if ([OmniaShellQa]::SendText($edit, 0x000C, [UIntPtr]::Zero, '', 2, 2000, [ref]$setResult) -eq [IntPtr]::Zero) { throw 'Draft clear failed.' }
    if ((Read-Text $edit) -ne '') { throw 'Draft clear readback failed.' }
    $process.Refresh()
    $cpuStart = $process.TotalProcessorTime.TotalMilliseconds
    $sampleStart = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds 2
    $process.Refresh()
    $cpuEnd = $process.TotalProcessorTime.TotalMilliseconds
    $cpuWall = $sampleStart.Elapsed.TotalMilliseconds
    $rect = New-Object OmniaShellQa+Rect
    if (-not [OmniaShellQa]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) { throw 'GetWindowRect failed.' }
    $bitmap = [Drawing.Bitmap]::new($rect.Right-$rect.Left, $rect.Bottom-$rect.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $dc = $graphics.GetHdc()
    try {
        if (-not [OmniaShellQa]::PrintWindow($process.MainWindowHandle, $dc, 2)) {
            throw 'PrintWindow failed; screenshot not accepted.'
        }
    } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
    $imageName = if ($KeepOpen) { 'native-shell-cycle24-window.png' } else { 'native-shell-cycle24-clean-close-window.png' }
    $imagePath = Join-Path $out $imageName
    try { $bitmap.Save($imagePath, [Drawing.Imaging.ImageFormat]::Png) }
    finally { $bitmap.Dispose() }
    $controls = @($root.FindAll($scope, [Windows.Automation.Condition]::TrueCondition) |
        ForEach-Object { @{type=$_.Current.ControlType.ProgrammaticName;name=$_.Current.Name;enabled=$_.Current.IsEnabled} })
    $receipt = @{
        schemaVersion=1;recordedAt=(Get-Date -Format o);scope='standalone Win32 shell, not full Omnia';
        executable=@{path=$exe;sha256=(Get-FileHash $exe).Hash.ToLower();bytes=(Get-Item $exe).Length};
        process=@{pid=$process.Id;title=$process.MainWindowTitle;responding=$process.Responding;
            workingSetBytes=$process.WorkingSet64;peakWorkingSetBytes=$process.PeakWorkingSet64;
            windowDiscoveryMilliseconds=$discoveryMs;cpuMilliseconds=($cpuEnd-$cpuStart);sampleWallMilliseconds=$cpuWall;
            cpuPercentOneCore=(100*($cpuEnd-$cpuStart)/$cpuWall)};
        cases=$cases.ToArray();controls=$controls;uiaIssue=$uiaIssue;capture=@{path=$imagePath;sha256=(Get-FileHash $imagePath).Hash.ToLower()};
        limitations=@('Window discovery is not first-interactive latency','Single warm smoke run, not comparative benchmark',
            'Win32 control messages are not physical keyboard/IME or UIA accessibility validation','No provider, durable sessions, IDE or browser engine',
            'Dark mode, DPI matrix, GPU and input p95 not verified')
    }
    if (-not $KeepOpen) {
        [void][OmniaShellQa]::PostMessageW($mainHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        if (-not $process.WaitForExit(3000)) { throw 'Clean close timeout.' }
        $receipt.teardown = @{state='exited';exitCode=$process.ExitCode;verifiedAfterWait=$true}
    } else {
        $receipt.teardown = @{state='left-visible';verifiedAfterWait=$false}
    }
    $receiptFile = if ($KeepOpen) { 'native-shell-cycle24-runtime.json' } else { 'native-shell-cycle24-clean-close.json' }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $out $receiptFile)
    $receipt | ConvertTo-Json -Depth 5
} catch {
    # Stop only the disposable process created by this script on QA failure.
    if (-not $process.HasExited) { Stop-Process -Id $process.Id }
    throw
}
