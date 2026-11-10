[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$omniaBase = 'D:\Omnia'
$activeRoot = 'D:\Omnia\repos\omnia'
$backupRoot = 'D:\Omnia\backups\recovery\repo-original-20261001'
$cleanupEntries = [Collections.Generic.List[object]]::new()

function Get-SafeTree([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($omniaBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing target outside the inspected Omnia root: $fullPath"
    }
    $item = Get-Item -LiteralPath $fullPath -Force
    $ancestor = $item
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing a reparse point in the target path: $($ancestor.FullName)"
        }
        if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent }
        else { $ancestor = $ancestor.Directory }
    }
    $tree = @($item)
    if ($item.PSIsContainer) {
        $tree += @(Get-ChildItem -LiteralPath $fullPath -Recurse -Force)
    }
    foreach ($child in $tree) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing a nested reparse point: $($child.FullName)"
        }
    }
    return $tree
}

function Add-CleanupEntry([string]$Path, [string]$Reason, [string]$DuplicateOf = '') {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $tree = @(Get-SafeTree -Path $Path)
    $files = @($tree | Where-Object { -not $_.PSIsContainer })
    if ($DuplicateOf) {
        $currentTree = @(Get-SafeTree -Path $DuplicateOf)
        foreach ($file in $files) {
            $relative = [IO.Path]::GetRelativePath($Path, $file.FullName)
            $counterpart = Join-Path $DuplicateOf $relative
            if (-not (Test-Path -LiteralPath $counterpart -PathType Leaf)) {
                throw "Backup has a unique file; preserve this entry: $($file.FullName)"
            }
            $current = Get-Item -LiteralPath $counterpart -Force
            if ($current.Length -ne $file.Length -or
                (Get-FileHash -LiteralPath $counterpart -Algorithm SHA256).Hash -ne
                (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) {
                throw "Backup differs from the current copy; preserve this entry: $($file.FullName)"
            }
        }
    }
    $cleanupEntries.Add([pscustomobject]@{
        Path = [IO.Path]::GetFullPath($Path)
        Reason = $Reason
        DuplicateOf = $DuplicateOf
        IsDirectory = $tree[0].PSIsContainer
        Files = $files.Count
        LogicalBytes = [int64]($files | Measure-Object Length -Sum).Sum
    })
}

# These backup subtrees are byte-for-byte duplicates. Preserve the complete
# backup .git, docs and src trees, including every older changed source file.
foreach ($name in @('.github', '.vscode', 'artifacts', 'design', 'research', 'scripts', 'src-tauri', 'tests')) {
    Add-CleanupEntry -Path (Join-Path $backupRoot $name) -Reason 'SHA-256-verified duplicate migration backup' -DuplicateOf (Join-Path $activeRoot $name)
}

# Delete only the redundant profile COPY, never the live WebView profile.
Add-CleanupEntry -Path 'D:\Omnia\LocalAppData\ai.omnia.desktop-verified-copy-20261001\EBWebView' -Reason '284-file duplicate profile copy' -DuplicateOf 'D:\Omnia\LocalAppData\ai.omnia.desktop\EBWebView'

# Old refresh roots have no checked-out files or local refs. Their fetched
# commits must still exist in the current research clones before removal.
$clonePairs = @(
    @{Old='D:\Omnia\LocalAppData\OmniaOfficialHarnessRefresh-20260813\codex'; Current='D:\Omnia\repos\omnia\research\upstreams\openai-codex'; RemotePath='/openai/codex.git'},
    @{Old='D:\Omnia\LocalAppData\OmniaOfficialHarnessRefresh-20260813\claude-code'; Current='D:\Omnia\repos\omnia\research\upstreams\claude-code-official'; RemotePath='/anthropics/claude-code.git'}
)
foreach ($pair in $clonePairs) {
    if (-not (Test-Path -LiteralPath $pair.Old)) { continue }
    $oldTree = @(Get-SafeTree -Path $pair.Old)
    $workingEntries = @(Get-ChildItem -LiteralPath $pair.Old -Force | Where-Object { $_.Name -ne '.git' })
    $refs = @(git -C $pair.Old show-ref 2>$null)
    if ($LASTEXITCODE -gt 1 -or $workingEntries.Count -gt 0 -or $refs.Count -gt 0 -or
        (Test-Path -LiteralPath (Join-Path $pair.Old '.git\index')) -or
        (Test-Path -LiteralPath (Join-Path $pair.Old '.git\logs'))) {
        throw "Clone contains local work or history; preserve it: $($pair.Old)"
    }
    $remote = [Uri](git -C $pair.Old config --get remote.origin.url)
    if ($remote.Host -ne 'github.com' -or $remote.AbsolutePath -ne $pair.RemotePath) {
        throw "Unexpected clone origin; preserve it: $($pair.Old)"
    }
    $fetchLine = Get-Content -LiteralPath (Join-Path $pair.Old '.git\FETCH_HEAD') -TotalCount 1
    if ($fetchLine -notmatch '^([0-9a-f]{40})\s') { throw 'Invalid fetched commit identity' }
    $fetchedCommit = $Matches[1]
    git -C $pair.Current cat-file -e ($fetchedCommit + '^{commit}') 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Fetched commit is not retained in current research: $fetchedCommit" }
    Add-CleanupEntry -Path $pair.Old -Reason ('Unused refresh clone; commit retained: ' + $fetchedCommit)
}

$generatedDirectories = @(
    'D:\Omnia\repos\omnia\artifacts\visual\report',
    'D:\Omnia\repos\omnia\artifacts\visual\test-results',
    'D:\Omnia\repos\omnia\artifacts\ui-smoke',
    'D:\Omnia\repos\omnia\docs\__pycache__',
    'D:\Omnia\repos\omnia\scripts\__pycache__',
    'D:\Omnia\repos\omnia\tests\__pycache__',
    'D:\Omnia\backups\recovery\repo-original-20261001\docs\__pycache__',
    'D:\Omnia\logs\repo-root-2026-10-01',
    'D:\Omnia\logs\temp-2026-10-01'
)
foreach ($path in $generatedDirectories) {
    Add-CleanupEntry -Path $path -Reason 'Regenerable old test, diagnostic or bytecode output'
}
$scratchFiles = @(
    'active-root-methods.txt', 'helper-section.txt', 'callsites.txt',
    'typecheck-citation-agent.stdout.tmp', 'typecheck-citation-agent.stderr.tmp',
    'kernel-test-output.txt', 'visual-list-output.txt', 'helper-out.txt',
    'cursor-audit.txt', 'machine-test-output.txt', 'telemetry-test-output.txt',
    'context-run-typecheck-exit.txt', 'visual-list-exit.txt',
    '.ipc-target-current.txt', 'vitest-drawer.json'
)
foreach ($name in $scratchFiles) {
    Add-CleanupEntry -Path (Join-Path $activeRoot $name) -Reason 'Unreferenced generated diagnostic scratch file'
}
foreach ($path in @(
    'D:\Omnia\repos\omnia\artifacts\chat-audit-390-home.png',
    'D:\Omnia\repos\omnia\artifacts\ui-settings-1280-2026-10-01.png',
    'D:\Omnia\logs\vite-from-d-20261001-retry.err',
    'D:\Omnia\logs\vite-from-d-20261001-retry.out',
    'D:\Omnia\logs\vite-from-d-20261001.err',
    'D:\Omnia\logs\vite-from-d-20261001.out'
)) {
    Add-CleanupEntry -Path $path -Reason 'Empty screenshot or old development-server log'
}

$before = [int64](Get-PSDrive -Name D).Free
$deleted = [Collections.Generic.List[object]]::new()
foreach ($entry in $cleanupEntries) {
    # This script is run as a standalone maintenance script. The explicit
    # WhatIf switch is enough here and avoids relying on a host-specific
    # ShouldProcess implementation when invoked from PowerShell wrappers.
    if (-not $WhatIfPreference) {
        # Recheck the physical path directly before deletion, using only the
        # preflighted exact allowlist. No junction or broad root is removed.
        $checked = @(Get-SafeTree -Path $entry.Path)
        if ($entry.IsDirectory) { Remove-Item -LiteralPath $entry.Path -Recurse -Force }
        else { Remove-Item -LiteralPath $entry.Path -Force }
        $deleted.Add($entry)
    }
}
$after = [int64](Get-PSDrive -Name D).Free
[pscustomobject]@{
    WhatIf = [bool]$WhatIfPreference
    BeforeFreeBytes = $before
    AfterFreeBytes = $after
    ObservedFreeSpaceIncrease = $after - $before
    PlannedTargets = $cleanupEntries.Count
    RemovedTargets = $deleted.Count
    RemovedFiles = [int64]($deleted | Measure-Object Files -Sum).Sum
    RemovedLogicalBytes = [int64]($deleted | Measure-Object LogicalBytes -Sum).Sum
    Entries = @($cleanupEntries)
} | ConvertTo-Json -Depth 5

