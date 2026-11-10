[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$IncludeBackupBuilds,
    [switch]$IncludeActiveGeneratedOutputs,
    [switch]$IncludeBuildCache
)

$ErrorActionPreference = 'Stop'

function Get-FreeBytes {
    return [int64](Get-PSDrive -Name D).Free
}

function Assert-SafeDirectory([string]$Path, [string]$BasePath) {
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside base: $full"
    }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Expected directory: $full" }
    if ([bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing reparse-point directory: $full"
    }
    return $item
}

function Remove-DirectoryContents([string]$Path, [string]$BasePath) {
    $dir = Assert-SafeDirectory -Path $Path -BasePath $BasePath
    $children = @(Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction Stop)
    foreach ($child in $children) {
        if ([bool]($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing reparse-point child: $($child.FullName)"
        }
        if ($WhatIfPreference) {
            Write-Host "What if: Remove rebuildable Omnia artefact '$($child.FullName)'"
        } else {
            Remove-Item -LiteralPath $child.FullName -Recurse -Force -ErrorAction Stop
        }
    }
    return $children.Count
}

function Remove-ExactDirectory([string]$Path, [string]$BasePath) {
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside base: $full"
    }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Expected directory: $full" }
    if ([bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing reparse-point directory: $full"
    }
    if ($WhatIfPreference) {
        Write-Host "What if: Remove rebuildable Omnia artefact directory '$full'"
    } else {
        Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    }
}

$before = Get-FreeBytes
$removedRoots = [Collections.Generic.List[string]]::new()
$removedExact = [Collections.Generic.List[string]]::new()

if ($IncludeBuildCache) {
    $cacheRoot = 'D:\OmniaBuildCache'
    foreach ($child in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -Force -ErrorAction Stop)) {
        if ([bool]($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing cache reparse point: $($child.FullName)"
        }
        Remove-ExactDirectory -Path $child.FullName -BasePath $cacheRoot
        $removedExact.Add($child.FullName)
    }
}

$localRoot = 'D:\Omnia\LocalAppData'
$protected = @(
    'ai.omnia.desktop',
    'ai.omnia.desktop-verified-copy-20261001',
    'OmniaResearch',
    'OmniaGitResearch',
    'OmniaOfficialHarnessRefresh-20260813',
    'OmniaIconPreview'
)

# The generated roots are identified only by their immediate Cargo/Vite output
# shape. The root folders remain in place so C: junctions stay valid.
foreach ($dir in @(Get-ChildItem -LiteralPath $localRoot -Directory -Force -ErrorAction Stop)) {
    if ($protected -contains $dir.Name) { continue }
    if ([bool]($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing LocalAppData reparse point: $($dir.FullName)"
    }
    $children = @(Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction Stop)
    $names = [Collections.Generic.List[string]]::new()
    foreach ($child in $children) { [void]$names.Add([string]$child.Name) }
    $hasBuildShape = $false
    foreach ($name in $names) {
        if ($name -match '^(target($|-)|debug$|dist$|audit-target$)') {
            $hasBuildShape = $true
            break
        }
    }
    $generated = $hasBuildShape -or
        ($names -contains '.rustc_info.json') -or
        ($names -contains 'CACHEDIR.TAG') -or
        ($dir.Name -eq 'OmniaSecurityRegression')
    if (-not $generated) { continue }
    Remove-DirectoryContents -Path $dir.FullName -BasePath $localRoot | Out-Null
    $removedRoots.Add($dir.FullName)
}

if ($IncludeActiveGeneratedOutputs) {
    $activeRoot = 'D:\Omnia\repos\omnia'
    $activeGenerated = @(
        'src-tauri\target', 'dist', '.cargo-target-test', '.cargo-target-verify', 'dist-analyze',
        'dist-budget-audit', 'dist-esbuild', 'dist-icon-auto',
        'dist-icon-boundary-audit', 'dist-icon-direct-audit',
        'dist-icon-shell-audit', 'dist-icon-shell-audit2',
        'dist-shared-audit', 'test-results'
    )
    foreach ($name in $activeGenerated) {
        $path = Join-Path $activeRoot $name
        if (Test-Path -LiteralPath $path) {
            Remove-DirectoryContents -Path $path -BasePath $activeRoot | Out-Null
            $removedRoots.Add($path)
        }
    }
}

if ($IncludeBackupBuilds) {
    $backupRoot = 'D:\Omnia\repo-original-20261001'
    $backupGenerated = @(
        '.cargo-target-test', '.cargo-target-verify', 'dist', 'src-tauri\target',
        'dist-analyze', 'dist-budget-audit', 'dist-esbuild',
        'dist-icon-auto', 'dist-icon-boundary-audit',
        'dist-icon-direct-audit', 'dist-icon-shell-audit',
        'dist-icon-shell-audit2', 'dist-shared-audit',
        'test-results', 'node_modules'
    )
    foreach ($name in $backupGenerated) {
        $path = Join-Path $backupRoot $name
        if (Test-Path -LiteralPath $path) {
            Remove-ExactDirectory -Path $path -BasePath $backupRoot
            $removedExact.Add($path)
        }
    }
}

$after = Get-FreeBytes
[pscustomobject]@{
    BeforeFreeBytes = $before
    AfterFreeBytes = $after
    RecoveredBytes = ($after - $before)
    LocalAppDataRootsEmptied = $removedRoots.Count
    ExactDirectoriesRemoved = $removedExact.Count
    PreservedProfileRoots = ($protected -join ',')
} | Format-List

Write-Output 'REMOVED_LOCAL_ROOTS:'
$removedRoots | ForEach-Object { Write-Output $_ }
Write-Output 'REMOVED_EXACT_DIRECTORIES:'
$removedExact | ForEach-Object { Write-Output $_ }
