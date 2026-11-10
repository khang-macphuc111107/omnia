$ErrorActionPreference = 'Stop'

$sourceRoot = 'C:\Users\khang\source\repos\omnia'
$canonicalRoot = 'D:\Omnia\repos\omnia'
$sourceParent = Split-Path -Path $sourceRoot -Parent
$stagingName = 'omnia-root-migration-staging'
$stagingRoot = Join-Path $sourceParent $stagingName
$logPath = 'D:\Omnia\logs\omnia-c-to-d-finalize.log'
$maxAttempts = 600

function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') $Message"
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path (Split-Path -Path $logPath -Parent) | Out-Null
Write-Log 'FINALIZER_STARTED'

if (-not (Test-Path -LiteralPath $canonicalRoot -PathType Container)) {
    Write-Log "FAILED canonical root missing: $canonicalRoot"
    exit 20
}
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    Write-Log 'SOURCE_ROOT_ALREADY_ABSENT'
    exit 0
}
if (Test-Path -LiteralPath $stagingRoot) {
    Write-Log "FAILED staging path already exists: $stagingRoot"
    exit 21
}

function Test-RootHashesMatch {
    $sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Force | Sort-Object Name)
    $canonicalFiles = @(Get-ChildItem -LiteralPath $canonicalRoot -File -Force | Sort-Object Name)
    if ($sourceFiles.Count -ne $canonicalFiles.Count) { return $false }
    $canonicalNames = @($canonicalFiles.Name)
    foreach ($sourceFile in $sourceFiles) {
        if ($sourceFile.Name -notin $canonicalNames) { return $false }
        $canonicalFile = Join-Path $canonicalRoot $sourceFile.Name
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
        $canonicalHash = (Get-FileHash -LiteralPath $canonicalFile -Algorithm SHA256).Hash
        if ($sourceHash -ne $canonicalHash) { return $false }
    }
    return $true
}

if (-not (Test-RootHashesMatch)) {
    Write-Log 'FAILED root-file hash comparison before cutover'
    exit 22
}

$renamed = $false
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        Rename-Item -LiteralPath $sourceRoot -NewName $stagingName -ErrorAction Stop
        $renamed = $true
        Write-Log "RENAMED_SOURCE_TO_STAGING attempt=$attempt path=$stagingRoot"
        break
    } catch {
        if (($attempt % 20) -eq 0) { Write-Log "WAITING_FOR_SOURCE_LOCK attempt=$attempt error=$($_.Exception.Message)" }
        Start-Sleep -Seconds 3
    }
}
if (-not $renamed) {
    Write-Log 'FAILED source root remained locked after timeout'
    exit 23
}

try {
    $mklinkOutput = & cmd.exe /d /c "mklink /J `"$sourceRoot`" `"$canonicalRoot`"" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "FAILED junction creation exit=$LASTEXITCODE output=$($mklinkOutput -join ' ')"
        exit 24
    }
    Write-Log "JUNCTION_CREATED source=$sourceRoot target=$canonicalRoot"

    $stagingChildren = @(Get-ChildItem -LiteralPath $stagingRoot -Force)
    $regularDirectories = @($stagingChildren | Where-Object { $_.PSIsContainer -and -not $_.LinkType })
    if ($regularDirectories.Count -gt 0) {
        Write-Log "STAGING_PRESERVED regular directories found: $($regularDirectories.FullName -join '; ')"
        exit 25
    }

    foreach ($file in @($stagingChildren | Where-Object { -not $_.PSIsContainer })) {
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
    }
    foreach ($link in @($stagingChildren | Where-Object { $_.PSIsContainer -and $_.LinkType })) {
        & cmd.exe /d /c "rmdir `"$($link.FullName)`"" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "STAGING_LINK_REMOVE_FAILED path=$($link.FullName) exit=$LASTEXITCODE"
            exit 26
        }
    }
    Remove-Item -LiteralPath $stagingRoot -Force -ErrorAction Stop
    Write-Log 'STAGING_REMOVED redundant-C-root-copy'

    $linkItem = Get-Item -LiteralPath $sourceRoot -Force
    $target = ($linkItem.Target -join ',')
    if ($linkItem.LinkType -ne 'Junction' -or $target -notmatch [regex]::Escape($canonicalRoot)) {
        Write-Log "FAILED post-cutover junction verification linkType=$($linkItem.LinkType) target=$target"
        exit 27
    }
    Write-Log "FINALIZED_OK linkType=$($linkItem.LinkType) target=$target"
    exit 0
} catch {
    Write-Log "FAILED_AFTER_RENAME error=$($_.Exception.Message)"
    exit 28
}
