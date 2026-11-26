# From desktop, after make:windows:local, using PowerShell 7:
# pwsh -File tests/windows-installed-journey.ps1 -QualificationRoot D:\QA\new-loci-run
# Setup uses the current user's actual LocalAppData, HKCU, and shell folders.
param([string]$QualificationRoot)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
    throw "Windows x64 required."
}
$Hosted = $env:GITHUB_ACTIONS -eq "true" -and $env:LOCI_RUNNER_ENVIRONMENT -eq "github-hosted"
if (-not $QualificationRoot) {
    if (-not $Hosted) { throw "Select an absent absolute directory with -QualificationRoot." }
    $QualificationRoot = Join-Path $env:RUNNER_TEMP "loci-installed-qa"
}
if ($QualificationRoot -notmatch '^[A-Za-z]:[\\/]') { throw "Choose an absolute local drive path." }
$Root = [IO.Path]::GetFullPath($QualificationRoot)
$Drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Root))
if ($Drive.DriveType -notin @("Fixed", "Removable") -or (Test-Path -LiteralPath $Root)) {
    throw "Choose a new qualification directory on a local drive."
}
$Install = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Loci"
$Registration = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Loci"
$App = (Resolve-Path "out/local-unsigned/Loci-win32-x64").Path
$Checkout = (Resolve-Path "..").Path
foreach ($Exclude in @($Checkout, $Install)) {
    if ($Root -eq $Exclude -or $Root.StartsWith("$Exclude\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Choose a qualification root outside the checkout and installation."
    }
}
if (-not $Hosted) {
    $Principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run per-user Setup in a non-elevated shell."
    }
}
$Setup = @(Get-ChildItem -Path "out/local-unsigned/make/squirrel.windows/x64/*Setup.exe" -File)
if ($Setup.Count -ne 1) { throw "Expected exactly one newly built Setup" }
$Package = @(Get-ChildItem -LiteralPath $Setup[0].DirectoryName -Filter "*.nupkg" -File)
if ($Package.Count -ne 1) { throw "Expected exactly one matching full NuGet package" }
$Title = (Get-Item -LiteralPath (Join-Path $App "Loci.exe")).VersionInfo.ProductName
if ($Title -ne "Loci") { throw "Cannot establish the shell shortcut name for this build" }
$Shell = New-Object -ComObject WScript.Shell
$Pinned = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

function Get-ShortcutState {
    # Squirrel manages a desktop link and a publisher subdirectory of Programs.
    # It also edits taskbar pins matching the installation path by string prefix.
    $Links = @()
    foreach ($Folder in @("DesktopDirectory", "CommonDesktopDirectory", "Programs", "CommonPrograms")) {
        $Base = [Environment]::GetFolderPath($Folder)
        if ($Base -and (Test-Path -LiteralPath $Base)) {
            $Links += @(Get-ChildItem -LiteralPath $Base -Force -Filter "$Title.lnk" -Recurse:($Folder -like "*Programs"))
        }
    }
    if (Test-Path -LiteralPath $Pinned) {
        foreach ($Link in Get-ChildItem -LiteralPath $Pinned -Force -Filter "*.lnk") {
            $Target = $Shell.CreateShortcut($Link.FullName).TargetPath
            if ($Link.Name -eq "$Title.lnk" -or
                ($Target -and [Environment]::ExpandEnvironmentVariables($Target).StartsWith($Install, [StringComparison]::OrdinalIgnoreCase))) {
                throw "Conflicting taskbar pin: $($Link.FullName)"
            }
        }
    }
    foreach ($Link in $Links | Sort-Object FullName -Unique) {
        if ($Link.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked shell entry: $($Link.FullName)" }
        [pscustomobject]@{ path = $Link.FullName; target = $Shell.CreateShortcut($Link.FullName).TargetPath
            sha256 = (Get-FileHash -LiteralPath $Link.FullName).Hash }
    }
}

function Assert-CleanProfile {
    foreach ($Hive in @("HKLM:", "HKCU:")) {
        foreach ($View in @("Software", "Software\WOW6432Node")) {
            if (Test-Path -LiteralPath "$Hive\$View\Microsoft\Windows\CurrentVersion\Uninstall\Loci") {
                throw "An existing Loci uninstall registration is present."
            }
        }
    }
    if ((Test-Path -LiteralPath $Install) -or @(Get-Process -Name Loci -ErrorAction SilentlyContinue).Count -or
        @(Get-ShortcutState).Count) {
        throw "Existing installation, registration or shell shortcut. Use a clean Windows profile."
    }
}

function Get-InstallIdentity {
    if (((Get-Item -LiteralPath $Install -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        @(Get-ChildItem -LiteralPath $Install -Force -Recurse -Attributes ReparsePoint).Count) {
        throw "Unexpected reparse point in installed payload."
    }
    $Versions = @(Get-ChildItem -LiteralPath $Install -Directory -Filter "app-*")
    if ($Versions.Count -ne 1) { throw "Expected one installed version" }
    $ExpectedCommand = ('"{0}" --uninstall' -f $Updater)
    if ((Get-ItemPropertyValue -LiteralPath $Registration -Name UninstallString) -ne $ExpectedCommand) {
        throw "Unexpected per-user uninstall registration"
    }
    $VersionRoot = $Versions[0].FullName
    foreach ($Member in @("Loci.exe", "resources/app.asar", "resources/loci-engine/loci-engine.exe")) {
        $Expected = Get-FileHash -LiteralPath (Join-Path $App $Member)
        $Actual = Get-FileHash -LiteralPath (Join-Path $VersionRoot $Member)
        if ($Expected.Hash -ne $Actual.Hash) { throw "Unexpected installed payload: $Member" }
    }
    $InstalledPackage = Join-Path $Install ("packages/" + $Package[0].Name)
    if ((Get-FileHash -LiteralPath $InstalledPackage).Hash -ne $Receipt.package_sha256) { throw "Installed package changed" }
    $Links = @(Get-ShortcutState)
    foreach ($Link in $Links) {
        if ($Link.target -ne (Join-Path $Install "Loci.exe")) { throw "Unowned shell shortcut: $($Link.path)" }
    }
    [ordered]@{ version = $VersionRoot; updater = (Get-FileHash -LiteralPath $Updater).Hash; shortcuts = $Links }
}

function Save-Receipt {
    $Receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Root "installer.json")
}
function Invoke-Installer([string]$File, [string[]]$Options) {
    $Process = Start-Process -FilePath $File -ArgumentList $Options -PassThru -Wait
    if ($Process.ExitCode -ne 0) { throw "$File exited with code $($Process.ExitCode)" }
}

Assert-CleanProfile
New-Item -ItemType Directory -Path $Root | Out-Null
$Commit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Cannot identify the source commit" }
$Receipt = [ordered]@{
    commit = $Commit
    setup_name = $Setup[0].Name
    setup_sha256 = (Get-FileHash -LiteralPath $Setup[0].FullName).Hash
    package_sha256 = (Get-FileHash -LiteralPath $Package[0].FullName).Hash
    installed_verified = $false
    app_passed = $false
    files_retired = $false
}
Save-Receipt
function Invoke-Journey {
    $Cache = (New-Item -ItemType Directory -Path (Join-Path $Root "cache")).FullName
    foreach ($Key in @("TEMP", "TMP", "SQUIRREL_TEMP")) { [Environment]::SetEnvironmentVariable($Key, $Cache) }
    $env:XDG_CACHE_HOME = $Cache
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $env:LOCI_QA_OUTPUT_ROOT = $Root
    $env:LOCI_QA_IMAGE = Join-Path $Root "cell.ome.tif"
    $env:LOCI_QA_CELL_ORACLE = "1"
    & ../engine/.venv/Scripts/python.exe tests/windows-cell-fixture.py $env:LOCI_QA_IMAGE
    if ($LASTEXITCODE -ne 0) { throw "Creating pinned offline microscopy input failed" }

    Assert-CleanProfile
    Invoke-Installer ($Setup[0].FullName) @("--silent")
    $Deadline = [DateTime]::UtcNow.AddMinutes(3)
    while (-not (Test-Path -LiteralPath $Registration)) {
        if ([DateTime]::UtcNow -ge $Deadline) { throw "Timed out waiting for per-user registration" }
        Start-Sleep -Milliseconds 500
    }
    $Updater = Join-Path $Install "Update.exe"
    $Owned = Get-InstallIdentity
    $Marker = Join-Path $Install (".loci-qa-" + [guid]::NewGuid())
    New-Item -ItemType File -Path $Marker | Out-Null
    $env:LOCI_PACKAGED_APP = $Owned.version
    $Receipt.installed_verified = $true
    $Receipt.installed = $Owned
    Save-Receipt
    try {
        node tests/windows-image-first.smoke.mjs
        if ($LASTEXITCODE -ne 0) { throw "Installed Electron journey failed" }
        $Receipt.app_passed = $true
    } finally {
        Save-Receipt
        if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) { throw "Owned installation was replaced" }
        $Current = Get-InstallIdentity
        if (($Current | ConvertTo-Json -Depth 6) -cne ($Owned | ConvertTo-Json -Depth 6)) {
            throw "Installation or shell shortcuts changed during qualification. Skipping uninstall."
        }
        Invoke-Installer $Updater @("--uninstall", "--silent")
        if ((Test-Path -LiteralPath (Join-Path $Install "Loci.exe")) -or (Test-Path -Path "$Install/app-*/Loci.exe") -or
            (Test-Path -LiteralPath $Registration) -or @(Get-ShortcutState).Count) {
            throw "Installed payload, registration or shell shortcut remains after uninstall"
        }
        $Receipt.files_retired = $true
        Save-Receipt
    }
}

$EnvironmentKeys = @("TEMP", "TMP", "SQUIRREL_TEMP", "XDG_CACHE_HOME", "PYTHONDONTWRITEBYTECODE",
    "LOCI_QA_OUTPUT_ROOT", "LOCI_QA_IMAGE", "LOCI_QA_CELL_ORACLE", "LOCI_PACKAGED_APP")
$Previous = @{}
foreach ($Key in $EnvironmentKeys) { $Previous[$Key] = [Environment]::GetEnvironmentVariable($Key) }
# Serialize qualification runs that would operate on the same Windows profile.
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Lock = [Threading.Mutex]::new($false, "Global\LociQualification-$Sid")
$Locked = $false
try {
    $Locked = $Lock.WaitOne(0)
    if (-not $Locked) { throw "Another qualification run owns this profile" }
    Invoke-Journey
} finally {
    if ($Locked) { $Lock.ReleaseMutex() }
    $Lock.Dispose()
    foreach ($Key in $EnvironmentKeys) {
        [Environment]::SetEnvironmentVariable($Key, $Previous[$Key])
    }
}
