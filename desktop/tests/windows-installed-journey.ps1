# Run from the desktop directory, only in package-windows on a fresh hosted VM.
# Squirrel uses the real user profile, shell folders and HKCU of that disposable VM.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne "true" -or
    $env:LOCI_RUNNER_ENVIRONMENT -ne "github-hosted" -or $env:RUNNER_ARCH -ne "X64") {
    throw "The Setup/uninstall journey requires a disposable GitHub-hosted Windows x64 runner."
}
$Install = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Loci"
$Registration = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Loci"
if ((Test-Path -LiteralPath $Install) -or (Test-Path -LiteralPath $Registration)) {
    throw "Expected a clean per-user installation root and registration."
}
$Root = Join-Path $env:RUNNER_TEMP "loci-installed-qa"
New-Item -ItemType Directory -Path $Root | Out-Null
$Setup = @(Get-ChildItem -Path "out/local-unsigned/make/squirrel.windows/x64/*Setup.exe" -File)
if ($Setup.Count -ne 1) { throw "Expected exactly one newly built Setup" }
$Receipt = [ordered]@{
    commit = $env:GITHUB_SHA
    setup_name = $Setup[0].Name
    setup_sha256 = (Get-FileHash -LiteralPath $Setup[0].FullName).Hash
    installed_verified = $false
    app_passed = $false
    files_retired = $false
}
function Save-Receipt {
    $Receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root "installer.json")
}
function Invoke-Installer([string]$File, [string[]]$Options) {
    $Process = Start-Process -FilePath $File -ArgumentList $Options -PassThru -Wait
    if ($Process.ExitCode -ne 0) { throw "$File exited with code $($Process.ExitCode)" }
}
Save-Receipt
$env:LOCI_QA_OUTPUT_ROOT = $Root
$env:LOCI_QA_IMAGE = Join-Path $Root "cell.ome.tif"
$env:LOCI_QA_CELL_ORACLE = "1"
& ../engine/.venv/Scripts/python.exe tests/windows-cell-fixture.py $env:LOCI_QA_IMAGE
if ($LASTEXITCODE -ne 0) { throw "Creating pinned offline microscopy input failed" }

Invoke-Installer ($Setup[0].FullName) @("--silent")
# An elevated Setup may delegate to Explorer and return before registration.
$Deadline = [DateTime]::UtcNow.AddMinutes(3)
while (-not (Test-Path -LiteralPath $Registration)) {
    if ([DateTime]::UtcNow -ge $Deadline) { throw "Timed out waiting for per-user registration" }
    Start-Sleep -Milliseconds 500
}
$Updater = Join-Path $Install "Update.exe"
if (-not (Test-Path -LiteralPath $Updater -PathType Leaf)) { throw "Missing per-user Squirrel updater" }
try {
    $Versions = @(Get-ChildItem -LiteralPath $Install -Directory -Filter "app-*")
    if ($Versions.Count -ne 1) { throw "Expected a single installed version" }
    $env:LOCI_PACKAGED_APP = $Versions[0].FullName
    foreach ($Member in @("Loci.exe", "resources/app.asar", "resources/loci-engine/loci-engine.exe")) {
        $Expected = Get-FileHash -LiteralPath (Join-Path "out/local-unsigned/Loci-win32-x64" $Member)
        $Actual = Get-FileHash -LiteralPath (Join-Path $env:LOCI_PACKAGED_APP $Member)
        if ($Expected.Hash -ne $Actual.Hash) { throw "Installed file differs from built payload: $Member" }
    }
    $Receipt.installed_verified = $true
    node tests/windows-image-first.smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw "Installed Electron journey failed" }
    $Receipt.app_passed = $true
} finally {
    Save-Receipt
    Invoke-Installer $Updater @("--uninstall", "--silent")
    if ((Test-Path -Path "$Install/app-*/Loci.exe") -or
        (Test-Path -LiteralPath $Registration)) { throw "Installed payload or registration remains after uninstall" }
    $Receipt.files_retired = $true
    Save-Receipt
}
