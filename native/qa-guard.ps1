param([Parameter(Mandatory)][string]$Database, [switch]$KeepOpen)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientsideProviders
$null = [Windows.Automation.AutomationElement]::RootElement
[Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly(
    [Reflection.AssemblyName]::new('UIAutomationClientsideProviders'))
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniaGuardQa {
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
}
'@
$exe = Join-Path $PSScriptRoot 'target/debug/omnia-native.exe'
$out = Join-Path (Split-Path $PSScriptRoot) 'docs/rebuild/receipts'
$cases = [Collections.Generic.List[object]]::new()
function Wait-For([scriptblock]$condition, [string]$failure) {
    $end = [DateTime]::UtcNow.AddSeconds(8)
    do {
        if (& $condition) { return }
        Start-Sleep -Milliseconds 40
    } while ([DateTime]::UtcNow -lt $end)
    throw $failure
}
function Control([int]$id) {
    $found = $root.FindFirst([Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,[string]$id))
    if ($null -eq $found) { throw "Missing control $id" }
    return $found
}
function Value([int]$id) { return (Control $id).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value }
function Set-Value([int]$id,[string]$value) { (Control $id).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($value) }
function Click([int]$id) {
    $item = Control $id
    if (-not $item.Current.IsEnabled) { throw "Disabled control $id" }
    $handle = [IntPtr]$item.Current.NativeWindowHandle
    $null = [OmniaGuardQa]::PostMessage([OmniaGuardQa]::GetParent($handle),0x111,[IntPtr]$id,$handle)
}
function Refresh-Clean {
    # Synchronous handler acknowledgement closes the PostMessage/enabled race.
    # A surprise modal fails this bounded call instead of being counted as a pass.
    $handle = [IntPtr](Control 127).Current.NativeWindowHandle
    $result = [IntPtr]::Zero
    if ([OmniaGuardQa]::SendMessageTimeout([OmniaGuardQa]::GetParent($handle),0x111,[IntPtr]127,$handle,2,2000,[ref]$result) -eq [IntPtr]::Zero) {
        throw 'Clean refresh handler acknowledgement failed'
    }
    Wait-For { (Control 127).Current.IsEnabled -and (Control 126).Current.Name.StartsWith('Settings revision') } 'Clean refresh completion failed'
}
function Dialog {
    return [Windows.Automation.AutomationElement]::RootElement.FindFirst(
        [Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.AndCondition]::new(
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$process.Id),
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ClassNameProperty,'#32770')))
}
function Answer([bool]$discard) {
    Wait-For { $null -ne (Dialog) } 'Unsaved metadata dialog missing'
    $dialog = Dialog
    $id = if ($discard) { '6' } else { '7' }
    $button = $dialog.FindFirst([Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,$id))
    if ($null -eq $button) { throw "Missing dialog response $id" }
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    Wait-For { $null -eq (Dialog) } 'Dialog did not close'
}
function Open-App {
    $script:process = Start-Process $exe -ArgumentList @('--session-db',"`"$Database`"") -WindowStyle Normal -PassThru
    Wait-For { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero } 'Window missing'
    $script:root = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    Wait-For { (Control 126).Current.Name.StartsWith('Settings revision') } 'Session load failed'
}
try {
    Open-App
    $baseline = Value 122
    # Clean default effort must not prompt during refresh.
    Refresh-Clean
    if ($null -ne (Dialog)) { throw 'Unchanged form prompted' }
    $cases.Add(@{case='unchanged-rendered-baseline';passed=$true})
    foreach ($id in @(129,127,121)) {
        Set-Value 122 'Unsaved Unicode 🦀'
        Click $id
        Answer $false
        if ((Value 122) -ne 'Unsaved Unicode 🦀') { throw "Cancel $id lost title" }
        $cases.Add(@{case="cancel-$id";passed=$true})
    }
    # Off-page active means list selection must be cleared after cancellation.
    $list = [IntPtr](Control 120).Current.NativeWindowHandle
    $null = [OmniaGuardQa]::SendMessage($list,0x186,[IntPtr]0,[IntPtr]0)
    $null = [OmniaGuardQa]::PostMessage([OmniaGuardQa]::GetParent($list),0x111,[IntPtr](120 -bor (1 -shl 16)),$list)
    Answer $false
    if ([OmniaGuardQa]::SendMessage($list,0x188,[IntPtr]0,[IntPtr]0).ToInt64() -ne -1 -or (Value 122) -ne 'Unsaved Unicode 🦀') {
        throw 'Cancelled selection lost fields or off-page selection'
    }
    $cases.Add(@{case='cancel-session-selection';passed=$true})
    $null = [OmniaGuardQa]::PostMessage($process.MainWindowHandle,0x10,[IntPtr]0,[IntPtr]0)
    Answer $false
    if ($process.HasExited -or (Value 122) -ne 'Unsaved Unicode 🦀') { throw 'Close cancellation lost edits' }
    $cases.Add(@{case='cancel-close';passed=$true})
    Click 127
    Answer $true
    Wait-For { (Value 122) -eq $baseline -and (Control 127).Current.IsEnabled } 'Discard refresh failed'
    $cases.Add(@{case='explicit-discard-refresh';passed=$true})
    # Effort-only edit prompts, and cancel preserves the combo selection.
    $combo = Control 124
    $options = $combo.FindAll([Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,
            [Windows.Automation.ControlType]::ListItem))
    $options[$options.Count-1].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
    Click 127
    Answer $false
    $selected = $combo.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()[0].Current.Name
    if ($selected -ne 'max') { throw 'Effort cancel lost selection' }
    Set-Value 122 'Saved guard title'
    Click 125
    Wait-For { (Control 126).Current.Name.StartsWith('invalid_input:') } 'Invalid empty model not rejected'
    if ((Value 122) -ne 'Saved guard title' -or -not (Control 122).Current.IsEnabled) { throw 'Save error lost or disabled draft' }
    Click 127
    Answer $false
    $cases.Add(@{case='invalid-save-keeps-dirty-form';passed=$true})
    Set-Value 123 'qa/guard'
    Click 125
    Wait-For { (Control 126).Current.Name.StartsWith('Settings revision 2') } 'Save failed'
    Refresh-Clean
    if ((Value 122) -ne 'Saved guard title') { throw 'Saved baseline refresh failed' }
    if ($null -ne (Dialog)) { throw 'Saved baseline still dirty' }
    $cases.Add(@{case='effort-cancel-save-clean-refresh';passed=$true})
    if (-not $process.CloseMainWindow() -or -not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Clean close failed' }
    Open-App
    if ((Value 122) -ne 'Saved guard title') { throw 'Reopen lost saved title' }
    $cases.Add(@{case='saved-state-reopen';passed=$true})
    $list = [IntPtr](Control 120).Current.NativeWindowHandle
    $priorSelection = [OmniaGuardQa]::SendMessage($list,0x188,[IntPtr]0,[IntPtr]0).ToInt64()
    $listed = @((Control 120).FindAll([Windows.Automation.TreeScope]::Children,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,
            [Windows.Automation.ControlType]::ListItem)))
    $targetIndex = -1
    for ($i=0; $i -lt $listed.Count; $i++) { if ($listed[$i].Current.Name -eq 'Synthetic session 0000') { $targetIndex=$i; break } }
    if ($targetIndex -lt 0) { throw 'Failed-select target absent from visible rows' }
    # Simulate a target removed by another writer after the list was loaded.
    # Python is fixture mutation tooling, never an application dependency.
    & python -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DELETE FROM agent_sessions WHERE id=?',('paging-fixture-0000',)); c.commit(); c.close()" $Database
    if ($LASTEXITCODE -ne 0) { throw 'Failed-select fixture mutation failed' }
    Set-Value 123 'Unsaved model after reopen'
    $null = [OmniaGuardQa]::SendMessage($list,0x186,[IntPtr]$targetIndex,[IntPtr]0)
    $null = [OmniaGuardQa]::PostMessage([OmniaGuardQa]::GetParent($list),0x111,[IntPtr](120 -bor (1 -shl 16)),$list)
    Answer $true
    Wait-For { (Control 126).Current.Name.Contains('No automatic retry') } 'Failed Select response not observed'
    if ([OmniaGuardQa]::SendMessage($list,0x188,[IntPtr]0,[IntPtr]0).ToInt64() -ne $priorSelection -or
        (Value 123) -ne 'Unsaved model after reopen' -or (Value 122) -ne 'Saved guard title') {
        throw 'Failed Select mismatched active selection or discarded fields'
    }
    $cases.Add(@{case='failed-select-restores-selection-preserves-form';passed=$true})
    $null = [OmniaGuardQa]::PostMessage($process.MainWindowHandle,0x10,[IntPtr]0,[IntPtr]0)
    Answer $true
    if (-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Explicit discard close failed' }
    Open-App
    if ((Value 123) -ne 'qa/guard') { throw 'Discarded model was persisted' }
    $cases.Add(@{case='explicit-discard-close-reopen';passed=$true})
    $receipt = @{
        recordedAt=[DateTime]::UtcNow.ToString('o');scope='debug native executable; disposable synthetic database; UIA metadata discard guards';
        cases=$cases.ToArray();executable=@{path=$exe;sha256=(Get-FileHash $exe).Hash};
        scriptSha256=(Get-FileHash $PSCommandPath).Hash;pid=$process.Id;
        limits=@('No physical keyboard/IME/Narrator coverage','Not release build/performance evidence','No provider or full-product claim')
    }
    if ($KeepOpen) { $receipt.teardown='left-visible' } else {
        if (-not $process.CloseMainWindow() -or -not $process.WaitForExit(5000)) { throw 'Final close failed' }
        $receipt.teardown=@{exitCode=$process.ExitCode}
    }
    $receipt | ConvertTo-Json -Depth 7 | Set-Content (Join-Path $out 'native-guard-cycle27-runtime.json')
    $receipt | ConvertTo-Json -Depth 7
} catch {
    @{error=$_.ToString();cases=$cases.ToArray()} | ConvertTo-Json -Depth 6 |
        Set-Content (Join-Path $out ('native-guard-cycle27-failure-'+[DateTime]::UtcNow.ToString('HHmmss')+'.json'))
    # Preserve the failed live window and its draft for diagnosis.
    throw
}
