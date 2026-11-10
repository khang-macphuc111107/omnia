param(
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][string]$OutputPrefix,
    [string]$Executable
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'qa-paths.ps1')
. (Join-Path $PSScriptRoot 'qa-capture.ps1')
$repository = Split-Path -Parent $PSScriptRoot
$OutputPrefix = Resolve-OmniaQaExternalPath $repository $OutputPrefix 'OutputPrefix'
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($OutputPrefix)) -PathType Container)) {
    throw 'OutputPrefix parent directory must already exist.'
}
if (Test-Path -LiteralPath $OutputPrefix) { throw 'OutputPrefix must be a fresh file prefix.' }
$imagePath = $OutputPrefix + '-window.png'
$receiptPath = $OutputPrefix + '-runtime.json'
$failurePath = $OutputPrefix + '-failure.json'
foreach ($path in @($imagePath, $receiptPath, $failurePath)) {
    Assert-OmniaQaLiteralBoundary $path
    if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite evidence: $path" }
}
$Database = Resolve-OmniaQaDatabase -RepositoryRoot $repository -Database $Database `
    -ReservedOutputPaths @($imagePath, $receiptPath, $failurePath)
$exe = Resolve-OmniaQaExecutable $repository $Executable 'debug'
$exeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientsideProviders
$null = [Windows.Automation.AutomationElement]::RootElement
[Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
    [Reflection.AssemblyName]::new('UIAutomationClientsideProviders'))
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniaOwnershipQa {
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(
   IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp,uint flags,uint timeout,out IntPtr result);
}
'@
$cases = [Collections.Generic.List[object]]::new()
$windows = [Collections.Generic.List[object]]::new()
$success = $false
function Write-NewJson([string]$Path, [object]$Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 10))
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
function Wait-For([scriptblock]$Condition, [string]$Failure) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 40
    } while ($timer.Elapsed.TotalSeconds -lt 10)
    throw $Failure
}
function Open-App([string]$Role) {
    # These are the visible interactive QA windows requested for observation.
    $process = Start-Process -FilePath $exe -ArgumentList @('--session-db', "`"$Database`"") -WindowStyle Normal -PassThru
    $window = [pscustomobject]@{ role=$Role; process=$process; root=$null; hwnd=[IntPtr]::Zero; closed=$false; exitCode=$null }
    $windows.Add($window)
    Wait-For {
        $process.Refresh()
        if ($process.HasExited) { throw "$Role exited before native window discovery." }
        $process.MainWindowHandle -ne [IntPtr]::Zero
    } "$Role window discovery timed out."
    $window.hwnd = $process.MainWindowHandle
    $window.root = [Windows.Automation.AutomationElement]::FromHandle($window.hwnd)
    return $window
}
function Control([object]$Window, [int]$Id) {
    $element = $Window.root.FindFirst([Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$Id))
    if ($null -eq $element) { throw "Missing UIA control $Id in $($Window.role)." }
    return $element
}
function Status([object]$Window) { return (Control $Window 126).Current.Name }
function Title([object]$Window) {
    return (Control $Window 122).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
}
function Rows([object]$Window) {
    return @((Control $Window 120).FindAll([Windows.Automation.TreeScope]::Children,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,
            [Windows.Automation.ControlType]::ListItem)) | ForEach-Object { $_.Current.Name })
}
function Command-Control([object]$Window, [int]$Id) {
    $element = Control $Window $Id
    if (-not $element.Current.IsEnabled) { throw "Control $Id is disabled in $($Window.role)." }
    $handle = [IntPtr]$element.Current.NativeWindowHandle
    $result = [IntPtr]::Zero
    # Bounded synchronous handler acknowledgement precedes asynchronous worker observation.
    if ([OmniaOwnershipQa]::SendMessageTimeout(
        [OmniaOwnershipQa]::GetParent($handle), 0x111, [IntPtr]$Id, $handle,
        2, 2000, [ref]$result) -eq [IntPtr]::Zero) {
        throw "Command $Id did not acknowledge within 2 seconds."
    }
}
function Close-App([object]$Window) {
    if ($Window.closed) { return }
    $Window.process.Refresh()
    if ($Window.process.HasExited) { throw "$($Window.role) exited before requested clean close." }
    if (-not $Window.process.CloseMainWindow() -or -not $Window.process.WaitForExit(5000)) {
        throw "$($Window.role) did not close cleanly within 5 seconds; window preserved."
    }
    $Window.closed = $true
    $Window.exitCode = $Window.process.ExitCode
    if ($Window.exitCode -ne 0) { throw "$($Window.role) closed with exit $($Window.exitCode)." }
}
function Window-Records {
    return @($windows | ForEach-Object {
        $_.process.Refresh()
        @{role=$_.role;pid=$_.process.Id;hwnd=$_.hwnd.ToInt64();closed=$_.closed;
          hasExited=$_.process.HasExited;exitCode=$_.exitCode}
    })
}
try {
    $first = Open-App 'first-owner'
    Wait-For { (Status $first).StartsWith('No active session.') -and (Control $first 121).Current.IsEnabled } 'Initial empty store did not load.'
    if (@(Rows $first).Count -ne 0) { throw 'New database unexpectedly contains sessions.' }
    $cases.Add(@{case='new-isolated-store-empty';passed=$true})
    Command-Control $first 121
    Wait-For { (Status $first).StartsWith('Settings revision 1') -and @(Rows $first).Count -eq 1 } 'New projectless chat action did not persist/select a session.'
    $baselineTitle = Title $first
    $baselineRows = @(Rows $first)
    if ($baselineTitle -ne 'New chat' -or $baselineRows[0] -ne $baselineTitle) {
        throw 'Created session title/list mismatch.'
    }
    $cases.Add(@{case='new-projectless-action-selects-durable-session';passed=$true;title=$baselineTitle;
        scopeEvidence='UI action only; projectless storage type is covered separately by Rust tests.'})
    $second = Open-App 'rejected-second-owner'
    Wait-For { (Status $second).StartsWith('harness_store_busy:') } 'Second native window did not show explicit store ownership conflict.'
    if ((Title $first) -ne $baselineTitle -or
        ((@(Rows $first)) -join "`n") -ne ($baselineRows -join "`n") -or
        -not (Status $first).StartsWith('Settings revision 1')) {
        throw 'Second open changed first owner metadata.'
    }
    $cases.Add(@{case='second-instance-rejected-first-state-preserved';passed=$true;secondStatus=(Status $second)})
    Command-Control $first 127
    Wait-For { (Status $first).StartsWith('Settings revision 1') -and (Control $first 127).Current.IsEnabled } 'First owner refresh failed after competing open.'
    if ((Title $first) -ne $baselineTitle -or ((@(Rows $first)) -join "`n") -ne ($baselineRows -join "`n")) {
        throw 'First owner refresh changed persisted title/list.'
    }
    $cases.Add(@{case='first-owner-refresh-remains-responsive';passed=$true})
    $capture = Save-OmniaQaWindowCapture -WindowHandle $first.hwnd -Process $first.process -Path $imagePath
    Close-App $second
    Close-App $first
    $cases.Add(@{case='both-instances-clean-close';passed=$true})
    $third = Open-App 'successor-owner'
    Wait-For { (Status $third).StartsWith('Settings revision 1') -and @(Rows $third).Count -eq 1 } 'Successor did not reopen persisted session.'
    if ((Title $third) -ne $baselineTitle -or ((@(Rows $third)) -join "`n") -ne ($baselineRows -join "`n")) {
        throw 'Persisted session title/list did not survive owner release/reopen.'
    }
    $cases.Add(@{case='successor-owner-reopens-same-session';passed=$true;title=(Title $third)})
    Close-App $third
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $exeHash) { throw 'Executable changed during QA.' }
    Write-NewJson $receiptPath @{
        recordedAt=[DateTime]::UtcNow.ToString('o');scope='Actual debug native Windows UIA ownership/metadata evaluation';
        database=@{path=$Database;initialState='nonexistent isolated fixture';retained=$true};
        executable=@{path=$exe;sha256=$exeHash};
        script=@{path=$PSCommandPath;sha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash};
        capture=$capture;
        cases=$cases.ToArray();passedCases=$cases.Count;requiredCases=6;windows=(Window-Records);
        limits=@('Metadata/evaluation shell only; no Send/provider/coordinator/effect-fencing claim',
            'UI strings/list/title prove displayed behavior; Rust tests separately establish stored scope and journal invariants',
            'No power-loss, Unix/network-filesystem, keyboard/IME/Narrator, final visual design or performance evidence')
    }
    $success = $true
    Get-Content -LiteralPath $receiptPath
} catch {
    $failure = $_
    Write-NewJson $failurePath @{
        recordedAt=[DateTime]::UtcNow.ToString('o');error=$failure.ToString();cases=$cases.ToArray();
        windows=(Window-Records);database=$Database;
        recovery='Failed windows/drafts retained for diagnosis. Close only listed test-owned PIDs after inspection; no automatic kill.'
    }
    throw $failure
} finally {
    # Successful cases close each owned window explicitly before the receipt.
    # On failure keep the live UI/draft, with PIDs in the failure receipt.
    if ($success) {
        foreach ($window in $windows) {
            if (-not $window.closed) { Close-App $window }
        }
    }
}
