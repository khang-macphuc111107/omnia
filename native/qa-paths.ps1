# Shared path contract for native QA. Dot sourcing defines functions only.
function Assert-OmniaQaLiteralBoundary {
    param([Parameter(Mandatory)][string]$Path)
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "QA path crosses a reparse point: $cursor"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Test-OmniaQaContainedPath {
    param([string]$Parent, [string]$Candidate)
    $relative = [IO.Path]::GetRelativePath($Parent, $Candidate)
    return ($relative -eq '.' -or (-not [IO.Path]::IsPathRooted($relative) -and
        $relative -ne '..' -and -not $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)))
}

function Resolve-OmniaQaExternalPath {
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    if (-not [IO.Path]::IsPathFullyQualified($RepositoryRoot) -or
        -not [IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Label and RepositoryRoot must be absolute paths."
    }
    $repository = [IO.Path]::GetFullPath($RepositoryRoot)
    Assert-OmniaQaLiteralBoundary $repository
    if (-not (Test-Path -LiteralPath $repository -PathType Container)) {
        throw 'RepositoryRoot must be an existing directory.'
    }
    $resolved = [IO.Path]::GetFullPath($Path)
    if ((Test-OmniaQaContainedPath $repository $resolved) -or
        (Test-OmniaQaContainedPath $resolved $repository)) {
        throw "$Label must be external to, and must not contain, the repository."
    }
    Assert-OmniaQaLiteralBoundary $resolved
    return $resolved
}

function Resolve-OmniaQaExecutable {
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [string]$Executable,
        [ValidateSet('debug', 'release')][string]$Profile = 'release'
    )
    if (-not $Executable) {
        $targetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else {
            $dataRoot = if ($env:OMNIA_DATA_ROOT) { $env:OMNIA_DATA_ROOT } else {
                Join-Path ([IO.Path]::GetDirectoryName($RepositoryRoot)) 'OmniaData'
            }
            if (-not [IO.Path]::IsPathFullyQualified($dataRoot)) {
                throw 'OMNIA_DATA_ROOT must be an absolute path.'
            }
            Join-Path $dataRoot 'build/native'
        }
        if (-not [IO.Path]::IsPathFullyQualified($targetRoot)) {
            throw 'CARGO_TARGET_DIR must be absolute for native QA; or pass -Executable.'
        }
        $Executable = Join-Path $targetRoot "$Profile/omnia-native.exe"
    }
    if (-not [IO.Path]::IsPathFullyQualified($Executable)) {
        throw 'Executable must be an absolute path.'
    }
    $resolved = Resolve-OmniaQaExternalPath $RepositoryRoot $Executable 'Executable'
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Native executable missing: $resolved. Build first or pass -Executable."
    }
    return $resolved
}

function Resolve-OmniaQaDatabase {
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$Database,
        [switch]$MustExist,
        [string[]]$ReservedOutputPaths = @()
    )
    $resolved = Resolve-OmniaQaExternalPath $RepositoryRoot $Database 'Database'
    if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($resolved)) -PathType Container)) {
        throw 'Create the isolated fixture parent directory before running QA.'
    }
    # SQLite may write these adjacent files, including on an existing fixture.
    foreach ($candidate in @($resolved, "$resolved-wal", "$resolved-shm", "$resolved-journal")) {
        Assert-OmniaQaLiteralBoundary $candidate
        if ($ReservedOutputPaths -contains $candidate) {
            throw "Database or SQLite sidecar collides with evidence: $candidate"
        }
        if ((Test-Path -LiteralPath $candidate) -and
            -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Database and SQLite sidecars must be files: $candidate"
        }
        if (-not $MustExist -and (Test-Path -LiteralPath $candidate)) {
            throw "Database must be a new isolated fixture without existing SQLite sidecars: $candidate"
        }
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Seeded fixture database missing: $resolved"
    }
    return $resolved
}

function Initialize-OmniaQaPaths {
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [string]$Executable,
        [string]$OutputDirectory,
        [ValidateSet('debug', 'release')][string]$Profile = 'release'
    )
    if (-not [IO.Path]::IsPathFullyQualified($RepositoryRoot)) {
        throw 'RepositoryRoot must be an absolute path.'
    }
    $repository = [IO.Path]::GetFullPath($RepositoryRoot)
    $dataRoot = if ($env:OMNIA_DATA_ROOT) { $env:OMNIA_DATA_ROOT } else {
        Join-Path ([IO.Path]::GetDirectoryName($repository)) 'OmniaData'
    }
    if (-not [IO.Path]::IsPathFullyQualified($dataRoot)) {
        throw 'OMNIA_DATA_ROOT must be an absolute path.'
    }
    $dataRoot = [IO.Path]::GetFullPath($dataRoot)
    $Executable = Resolve-OmniaQaExecutable $repository $Executable $Profile
    if (-not $OutputDirectory) {
        $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N')
        $OutputDirectory = Join-Path $dataRoot "qa/native/$runId"
    }
    $OutputDirectory = Resolve-OmniaQaExternalPath $repository $OutputDirectory 'OutputDirectory'
    if (Test-Path -LiteralPath $OutputDirectory) {
        throw "QA output already exists; refusing to replace it: $OutputDirectory"
    }
    $parent = [IO.Path]::GetDirectoryName($OutputDirectory)
    [void][IO.Directory]::CreateDirectory($parent)
    Assert-OmniaQaLiteralBoundary $parent
    $null = New-Item -ItemType Directory -Path $OutputDirectory -ErrorAction Stop
    return @{ Executable = $Executable; OutputDirectory = $OutputDirectory }
}
