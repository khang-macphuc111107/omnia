# Focused path-contract tests. Fixture executable bytes are never executed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'qa-paths.ps1')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('omnia-qa-path-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixtureRoot
$oldData = $env:OMNIA_DATA_ROOT
$oldTarget = $env:CARGO_TARGET_DIR
$passed = [Collections.Generic.List[string]]::new()
$link = $null
function Assert-Case([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "Assertion failed: $Name" }
    $passed.Add($Name)
}
function Assert-Refused([scriptblock]$Action, [string]$Message, [string]$Name) {
    $observed = $null
    try { & $Action | Out-Null } catch { $observed = $_.Exception.Message }
    Assert-Case ($null -ne $observed -and $observed -match $Message) $Name
}
try {
    $repo = Join-Path $fixtureRoot 'repo'
    $data = Join-Path $fixtureRoot 'data'
    $null = New-Item -ItemType Directory -Path $repo
    $env:OMNIA_DATA_ROOT = $data
    $env:CARGO_TARGET_DIR = $null
    $release = Join-Path $data 'build/native/release/omnia-native.exe'
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $release)
    Set-Content -LiteralPath $release -Value 'path fixture only; never executed'
    $result = Initialize-OmniaQaPaths -RepositoryRoot $repo
    Assert-Case ($result.Executable -eq $release) 'default external release target'
    Assert-Case (Test-Path -LiteralPath $result.OutputDirectory -PathType Container) 'fresh default run created'
    Assert-Case (-not (Test-OmniaQaContainedPath $repo $result.OutputDirectory)) 'default output outside repo'
    $next = Initialize-OmniaQaPaths -RepositoryRoot $repo
    Assert-Case ($next.OutputDirectory -ne $result.OutputDirectory) 'unique output for repeated invocation'
    $customTarget = Join-Path $fixtureRoot 'custom-target'
    $debug = Join-Path $customTarget 'debug/omnia-native.exe'
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $debug)
    Set-Content -LiteralPath $debug -Value 'path fixture only; never executed'
    $env:CARGO_TARGET_DIR = $customTarget
    $customOutput = Join-Path $fixtureRoot 'explicit-output'
    $explicit = Initialize-OmniaQaPaths -RepositoryRoot $repo -Profile debug -OutputDirectory $customOutput
    Assert-Case ($explicit.Executable -eq $debug -and $explicit.OutputDirectory -eq $customOutput) 'absolute cargo target and explicit output'
    Set-Content -LiteralPath (Join-Path $customOutput 'owner.txt') -Value 'preserve'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable $release -OutputDirectory $customOutput } 'already exists' 'existing output refused'
    Assert-Case ((Get-Content -Raw -LiteralPath (Join-Path $customOutput 'owner.txt')).Trim() -eq 'preserve') 'existing output preserved'
    foreach ($target in @($repo, (Join-Path $repo 'receipts'), $fixtureRoot)) {
        Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable $release -OutputDirectory $target } 'must be external' ('repo containment refused: ' + $target)
    }
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable 'relative.exe' } 'absolute' 'relative executable refused'
    $repoExecutable = Join-Path $repo 'repo-native.exe'
    Set-Content -LiteralPath $repoExecutable -Value 'repository executable fixture; never executed'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable $repoExecutable } 'must be external' 'repository executable refused'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable $release -OutputDirectory 'relative-output' } 'absolute' 'relative output refused'
    $env:CARGO_TARGET_DIR = 'relative-target'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo } 'absolute' 'relative cargo target refused'
    $env:CARGO_TARGET_DIR = $null
    $env:OMNIA_DATA_ROOT = 'relative-data'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo } 'absolute' 'relative data root refused'
    $env:OMNIA_DATA_ROOT = $data
    $missingOutput = Join-Path $fixtureRoot 'must-not-exist'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable (Join-Path $fixtureRoot 'missing.exe') -OutputDirectory $missingOutput } 'executable missing' 'missing executable refused'
    Assert-Case (-not (Test-Path -LiteralPath $missingOutput)) 'missing executable creates no output'
    $link = Join-Path $fixtureRoot 'alias'
    $null = New-Item -ItemType Junction -Path $link -Target $data
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable $release -OutputDirectory (Join-Path $link 'run') } 'reparse' 'junction output refused'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $repo -Executable (Join-Path $link 'build/native/release/omnia-native.exe') } 'reparse' 'junction executable refused'
    Assert-Refused { Initialize-OmniaQaPaths -RepositoryRoot $link -Executable $release } 'reparse' 'junction repository refused'
    Assert-Refused { Resolve-OmniaQaDatabase $repo 'relative.sqlite3' } 'absolute' 'relative database refused'
    Assert-Refused { Resolve-OmniaQaDatabase $repo (Join-Path $repo 'fixture.sqlite3') } 'must be external' 'source database refused'
    Assert-Refused { Resolve-OmniaQaDatabase $repo (Join-Path $link 'fixture.sqlite3') } 'reparse' 'junction database refused'
    Assert-Refused { Resolve-OmniaQaDatabase $repo (Join-Path $data 'missing.sqlite3') -MustExist } 'Seeded fixture database missing' 'missing seeded database refused'
    Assert-Refused { Resolve-OmniaQaDatabase $repo (Join-Path $data 'missing-parent/fixture.sqlite3') } 'parent directory' 'missing database parent refused'
    $database = Join-Path $data 'fixture.sqlite3'
    Assert-Case ((Resolve-OmniaQaDatabase $repo $database) -eq $database) 'new external database accepted without creation'
    Assert-Case (-not (Test-Path -LiteralPath $database)) 'database resolver creates no fixture bytes'
    Set-Content -LiteralPath $database -Value 'database path fixture; never opened'
    Assert-Case ((Resolve-OmniaQaDatabase $repo $database -MustExist) -eq $database) 'existing external seeded path accepted'
    Assert-Refused { Resolve-OmniaQaDatabase $repo $database } 'new isolated fixture' 'existing database refused for ownership QA'
    Assert-Refused { Resolve-OmniaQaDatabase $repo $database -MustExist -ReservedOutputPaths @($database) } 'collides' 'database evidence collision refused'
    Assert-Refused { Resolve-OmniaQaDatabase $repo $database -MustExist -ReservedOutputPaths @("$database-wal") } 'collides' 'sidecar evidence collision refused'
    foreach ($suffix in @('-wal', '-shm', '-journal')) {
        $newDatabase = Join-Path $data ('orphan' + $suffix + '.sqlite3')
        Set-Content -LiteralPath ($newDatabase + $suffix) -Value 'retained SQLite sidecar'
        Assert-Refused { Resolve-OmniaQaDatabase $repo $newDatabase } 'existing SQLite sidecars' ('orphan sidecar refused: ' + $suffix)
        Assert-Case ((Get-Content -LiteralPath ($newDatabase + $suffix) -Raw).Trim() -eq 'retained SQLite sidecar') ('orphan sidecar preserved: ' + $suffix)
    }
    $null = New-Item -ItemType Directory -Path "$database-wal"
    Assert-Refused { Resolve-OmniaQaDatabase $repo $database -MustExist } 'must be files' 'directory sidecar refused'
    Assert-Refused { Resolve-OmniaQaExternalPath $repo $repo 'OutputPrefix' } 'must be external' 'source output prefix refused'
    Assert-Refused { Resolve-OmniaQaExternalPath $repo $fixtureRoot 'OutputPrefix' } 'must be external' 'ancestor output prefix refused'
    [ordered]@{ scope = 'native QA path contract; no product execution'; passed = $passed.Count; cases = $passed.ToArray() } | ConvertTo-Json -Depth 4
} finally {
    $env:OMNIA_DATA_ROOT = $oldData
    $env:CARGO_TARGET_DIR = $oldTarget
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not (Test-OmniaQaContainedPath $temp $resolved) -or
        -not ([IO.Path]::GetFileName($resolved)).StartsWith('omnia-qa-path-test-')) {
        throw 'Refusing cleanup outside the owned test boundary.'
    }
    if ($link -and (Test-Path -LiteralPath $link)) { Remove-Item -LiteralPath $link -Force }
    Assert-OmniaQaLiteralBoundary $resolved
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
