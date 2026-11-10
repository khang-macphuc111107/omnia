param(
    [switch]$KeepOpen,
    [string]$Executable,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qa-paths.ps1')
. (Join-Path $PSScriptRoot 'qa-capture.ps1')
$qaPaths = Initialize-OmniaQaPaths -RepositoryRoot (Split-Path -Parent $PSScriptRoot) `
    -Executable $Executable -OutputDirectory $OutputDirectory -Profile 'release'
$out = $qaPaths.OutputDirectory
$exe = $qaPaths.Executable
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientsideProviders
# Initialize the observer's proxy manager before explicit registration.
$null = [Windows.Automation.AutomationElement]::RootElement
[Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
    [Reflection.AssemblyName]::new('UIAutomationClientsideProviders'))
$sandbox = Join-Path $out 'fixture'
$null = New-Item -ItemType Directory -Path $sandbox
$db = Join-Path $sandbox 'sessions.sqlite3'
$cases = [Collections.Generic.List[object]]::new()
$process = $null
function Open-App {
    # A visible app was explicitly requested for live progress.
    $script:process = Start-Process -FilePath $exe -ArgumentList @('--session-db', "`"$db`"") -PassThru -WindowStyle Normal
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "App exited during launch: $($process.ExitCode)" }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Window discovery timed out' }
    $script:root = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}
function Control([int]$id) {
    $condition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$id)
    $item = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $item) { throw "Missing UIA control $id" }
    return $item
}
function Invoke-Control([int]$id) {
    $pattern = (Control $id).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
}
function Set-Value([int]$id, [string]$value) {
    $pattern = (Control $id).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $pattern.SetValue($value)
    if ($pattern.Current.Value -ne $value) { throw "Value readback failed: $id" }
}
function Wait-Status([string]$expected) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $status = (Control 126).Current.Name
        if ($status.Contains($expected)) { return $status }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Status timeout expecting '$expected': $status"
}
function Close-App {
    if (-not $process.CloseMainWindow()) { throw 'CloseMainWindow failed' }
    if (-not $process.WaitForExit(5000)) { throw 'Clean close timeout' }
    if ($process.ExitCode -ne 0) { throw "Unexpected exit: $($process.ExitCode)" }
}
try {
    Open-App
    $null = Wait-Status 'No active session'
    $draft = Control 112
    if ($draft.Current.ControlType -ne [Windows.Automation.ControlType]::Document) {
        throw 'Multiline draft must expose Document'
    }
    $null = $draft.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)
    $cases.Add(@{case='multiline-uia';passed=$true;method='Document + TextPattern'})
    Invoke-Control 121
    $null = Wait-Status 'Settings revision'
    Set-Value 122 'Native QA — phiên lưu bền'
    Set-Value 123 'qa/model-native'
    $combo = Control 124
    $expand = $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expand.Expand()
    $max = $combo.FindFirst([Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'max'))
    if ($null -eq $max) { throw 'Effort max item missing' }
    $max.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
    $expand.Collapse()
    Invoke-Control 125
    $saved = Wait-Status 'Settings revision 2'
    $cases.Add(@{case='create-save';passed=$true;method='UIA Invoke/Value/SelectionItem';status=$saved})
    Close-App
    $cases.Add(@{case='clean-close';passed=$true;exitCode=$process.ExitCode})
    Open-App
    $null = Wait-Status 'Settings revision 2'
    foreach ($pair in @(@(122,'Native QA — phiên lưu bền'), @(123,'qa/model-native'))) {
        if ((Control $pair[0]).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value -ne $pair[1]) {
            throw "Persisted field mismatch: $($pair[0])"
        }
    }
    $selection = (Control 124).GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
    if ($selection.Count -ne 1 -or $selection[0].Current.Name -ne 'max') { throw 'Persisted effort mismatch' }
    $tabs = (Control 120).GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
    if ($tabs.Count -ne 1 -or $tabs[0].Current.Name -ne 'Native QA — phiên lưu bền') { throw 'Persisted active LISTBOX selection mismatch' }
    $cases.Add(@{case='reopen-same-database';passed=$true;title=$true;model=$true;effort='max';activeSelection=$true})
    Invoke-Control 102
    if (-not (Control 110).Current.Name.StartsWith("Browser`n")) { throw 'Browser heading mismatch' }
    Invoke-Control 103
    if (-not (Control 110).Current.Name.StartsWith("IDE`n")) { throw 'IDE heading mismatch' }
    Invoke-Control 101
    if (-not (Control 110).Current.Name.StartsWith("Chat / No project`n")) { throw 'Chat heading mismatch' }
    $cases.Add(@{case='mode-buttons-uia';passed=$true;method='InvokePattern + heading readback; no keyboard/IME claim'})
    $image = Join-Path $out 'native-session-cycle25-window.png'
    $capture = Save-OmniaQaWindowCapture -WindowHandle $process.MainWindowHandle -Process $process -Path $image
    $process.Refresh()
    $receipt = @{
        schemaVersion=1;recordedAt=[DateTime]::UtcNow.ToString('o');scope='native session metadata; not provider execution';
        cases=$cases.ToArray();database=$db;
        executable=@{sha256=(Get-FileHash $exe).Hash;bytes=(Get-Item $exe).Length};
        observer=@{scriptSha256=(Get-FileHash $PSCommandPath).Hash;clientSideProvidersRegistered=$true};
        capture=$capture;
        process=@{pid=$process.Id;responding=$process.Responding;workingSetBytes=$process.WorkingSet64};
        limitations=@('UIA is not physical keyboard/IME or Narrator verification','No provider/profile execution','No final theme, browser engine or IDE editor','Isolated synthetic database only','Single sample is not a performance benchmark')
    }
    if ($KeepOpen) { $receipt.teardown='left-visible' } else { Close-App; $receipt.teardown=@{exitCode=$process.ExitCode;verifiedAfterWait=$true} }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $out 'native-session-cycle25-runtime.json')
    $receipt | ConvertTo-Json -Depth 6
} catch {
    @{recordedAt=[DateTime]::UtcNow.ToString('o');error=$_.ToString();cases=$cases.ToArray();database=$db} |
        ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out ("native-session-cycle25-qa-failure-" + [DateTime]::UtcNow.ToString('HHmmss') + '.json'))
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
    throw
}
