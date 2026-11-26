param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$AppRoot,
    [Parameter(Mandatory)][string]$WorkRoot,
    [string]$PythonPath,
    [string]$SourcePath,
    [string]$MaskPath,
    [string]$ModelPath,
    [string]$OutputRoot,
    [string]$ExpectedAsarSha256
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot)
if (Test-Path -LiteralPath $WorkRoot) { throw "Choose a new WorkRoot: $WorkRoot" }
if (-not $PythonPath) { $PythonPath = Join-Path $RepoRoot 'engine/.venv/Scripts/python.exe' }
$PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path

$BuildConfig = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'desktop/development-build.json') | ConvertFrom-Json
if ($BuildConfig.buildNumber -ne 76) { throw 'Pick the public build 76 checkout.' }
$Identities = [ordered]@{}
foreach ($File in @('Loci.exe', 'resources/loci-engine/loci-engine.exe', 'resources/app.asar')) {
    $Path = Join-Path $AppRoot $File
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Extracted package is missing $File" }
    $Identities[$File] = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ($ExpectedAsarSha256 -and $Identities['resources/app.asar'] -ne $ExpectedAsarSha256) {
    throw 'The packaged app.asar does not match the supplied build 76 identity.'
}
$Commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE) { throw "Could not identify the checkout commit: $LASTEXITCODE" }
$FixtureOverrides = @($SourcePath, $MaskPath, $ModelPath).Where({ $_ })
if ($FixtureOverrides.Count -and $FixtureOverrides.Count -ne 3) {
    throw 'Supply SourcePath, MaskPath, and ModelPath together.'
}

New-Item -ItemType Directory -Path $WorkRoot | Out-Null
$BuildReceipt = @{
    checkout_commit = $Commit
    checkout_development_build = $BuildConfig.buildNumber
    binaries_sha256 = $Identities
    offline_coverage = 'electron-session-and-proxy-guard-only'
}
$BuildReceipt | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $WorkRoot 'package-identity.json')
if (-not $FixtureOverrides.Count) {
    $Fixture = Join-Path $WorkRoot 'fixture'
    & $PythonPath (Join-Path $PSScriptRoot 'prepare_windows_onnx_fixture.py') --repo $RepoRoot --output $Fixture
    if ($LASTEXITCODE) { throw "Public fixture preparation failed: $LASTEXITCODE" }
    $Field = 'IXMtest_A06_s6_w1B9577918-4973-4A87-BA73-A168AA755527'
    $SourcePath = Join-Path $Fixture "$Field.ome.tif"
    $MaskPath = Join-Path $Fixture "$Field.png"
    $ModelPath = Join-Path $Fixture 'model'
}
if (-not $OutputRoot) { $OutputRoot = Join-Path $WorkRoot 'qa' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw "Choose a new OutputRoot: $OutputRoot" }
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($OutputRoot)) -Force | Out-Null

$Environment = @{
    LOCI_PACKAGED_APP = $AppRoot
    LOCI_QA_OUTPUT_ROOT = $OutputRoot
    LOCI_QA_MODEL_SOURCE = (Resolve-Path -LiteralPath $SourcePath).Path
    LOCI_QA_MODEL_MASK = (Resolve-Path -LiteralPath $MaskPath).Path
    LOCI_QA_MODEL_PACKAGE = (Resolve-Path -LiteralPath $ModelPath).Path
    LOCI_QA_PYTHON = $PythonPath
    LOCI_QA_EXPECTED_SOURCE_SHA256 = '502822d7b7f4a7164b6f7e1c2b35807724e1f755efba4678b60b4ea492db3ad9'
    LOCI_QA_EXPECTED_MASK_SHA256 = 'e0737550efe11dc9969971947d9095ac0971bf77cfd0f448eeb7592cea7969b3'
    LOCI_QA_OFFLINE_EXECUTABLE = $null
}
$Previous = @{}
foreach ($Entry in $Environment.GetEnumerator()) {
    $Previous[$Entry.Key] = [Environment]::GetEnvironmentVariable($Entry.Key, 'Process')
    [Environment]::SetEnvironmentVariable($Entry.Key, $Entry.Value, 'Process')
}
try {
    & node (Join-Path $RepoRoot 'desktop/tests/bioimageio-nuclei-install.qa.mjs')
    if ($LASTEXITCODE) { throw "BioImage.IO install QA failed: $LASTEXITCODE" }
}
finally {
    foreach ($Entry in $Previous.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($Entry.Key, $Entry.Value, 'Process')
    }
}
