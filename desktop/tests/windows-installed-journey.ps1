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
# Squirrel can retry extraction under CommonApplicationData when LocalAppData is unwritable.
$FallbackInstall = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) ([Environment]::UserName + "\Loci")
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
    # In the bundled Squirrel eef37460, Setup stages Update.exe in SquirrelTemp,
    # and UpdateManager derives the install parent from that executable's path.
    if ($env:SQUIRREL_TEMP) { throw "SQUIRREL_TEMP overrides the per-user installation root. Run with this variable unset." }
    if (Test-Path -LiteralPath $FallbackInstall) { throw "Existing Loci installation at Squirrel's fallback location." }
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

function Get-RegisteredUpdater {
    $Entry = Get-ItemProperty -LiteralPath $Registration -Name @("InstallLocation", "UninstallString")
    if ($Entry.InstallLocation -ne $Install) {
        throw "Registered InstallLocation is outside the allowed per-user Loci directory."
    }
    $Command = [regex]::Match($Entry.UninstallString, '^"([^"]+)" --uninstall$')
    $Registered = $Command.Groups[1].Value
    if (-not $Command.Success -or $Registered -ne (Join-Path $Install "Update.exe")) {
        throw "Unexpected per-user uninstall command."
    }
    if (-not (Test-Path -LiteralPath $Registered -PathType Leaf)) { throw "Registered updater is missing." }
    return $Registered
}

function Get-InstallIdentity {
    $Binary = Get-RegisteredUpdater
    if (((Get-Item -LiteralPath $Install -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        @(Get-ChildItem -LiteralPath $Install -Force -Recurse -Attributes ReparsePoint).Count) {
        throw "Unexpected reparse point in installed payload."
    }
    $Versions = @(Get-ChildItem -LiteralPath $Install -Directory -Filter "app-*")
    if ($Versions.Count -ne 1) { throw "Expected one installed version" }
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
    [ordered]@{ version = $VersionRoot; updater_path = $Binary; updater = (Get-FileHash -LiteralPath $Binary).Hash; shortcuts = $Links }
}

function Save-Receipt {
    $Receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Root "installer.json")
}
function Invoke-Installer([string]$File, [string[]]$Options) {
    $Process = Start-Process -FilePath $File -ArgumentList $Options -PassThru
    if (-not $Process.WaitForExit(300000)) { throw "Installer process exceeded five minutes. Inspect this run before retrying." }
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
    stage = "prepare fixture"
    installed_verified = $false
    app_passed = $false
    files_retired = $false
}
Save-Receipt
function Invoke-Journey {
    $Cache = (New-Item -ItemType Directory -Path (Join-Path $Root "cache")).FullName
    foreach ($Key in @("TEMP", "TMP")) { [Environment]::SetEnvironmentVariable($Key, $Cache) }
    $env:XDG_CACHE_HOME = $Cache
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $env:LOCI_QA_OUTPUT_ROOT = $Root
    $env:LOCI_QA_IMAGE = Join-Path $Root "cell.ome.tif"
    $env:LOCI_QA_CELL_ORACLE = "1"
    & ../engine/.venv/Scripts/python.exe tests/windows-cell-fixture.py $env:LOCI_QA_IMAGE
    if ($LASTEXITCODE -ne 0) { throw "Creating pinned offline microscopy input failed" }

    $Receipt.stage = "clean profile and Setup"
    Assert-CleanProfile
    Invoke-Installer ($Setup[0].FullName) @("--silent")
    $Deadline = [DateTime]::UtcNow.AddMinutes(3)
    $Receipt.stage = "per-user registration"
    # An elevated Setup can delegate to Explorer. Wait for both registry values.
    while (-not ((Get-ItemPropertyValue -LiteralPath $Registration -Name InstallLocation -ErrorAction SilentlyContinue) -and
        (Get-ItemPropertyValue -LiteralPath $Registration -Name UninstallString -ErrorAction SilentlyContinue))) {
        if ([DateTime]::UtcNow -ge $Deadline) { throw "Timed out waiting for per-user registration" }
        Start-Sleep -Milliseconds 500
    }
    $Receipt.stage = "installed identity"
    $Owned = Get-InstallIdentity
    $Marker = Join-Path $Install (".loci-qa-" + [guid]::NewGuid())
    New-Item -ItemType File -Path $Marker | Out-Null
    $env:LOCI_PACKAGED_APP = $Owned.version
    $Receipt.installed_verified = $true
    $Receipt.stage = "installed app"
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
        $Receipt.stage = "uninstall"
        Invoke-Installer $Current.updater_path @("--uninstall", "--silent")
        if ((Test-Path -LiteralPath (Join-Path $Install "Loci.exe")) -or (Test-Path -Path "$Install/app-*/Loci.exe") -or
            (Test-Path -LiteralPath $Registration) -or @(Get-ShortcutState).Count) {
            throw "Installed payload, registration or shell shortcut remains after uninstall"
        }
        $Receipt.files_retired = $true
        $Receipt.stage = if ($Receipt.app_passed) { "complete" } else { "installed app" }
        Save-Receipt
    }
}

$EnvironmentKeys = @("TEMP", "TMP", "XDG_CACHE_HOME", "PYTHONDONTWRITEBYTECODE",
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
} catch {
    $Failure = $_
    $Location = Get-ItemPropertyValue -LiteralPath $Registration -Name InstallLocation -ErrorAction SilentlyContinue
    $Receipt.failure = [ordered]@{
        error_type = $Failure.Exception.GetType().Name
        source_line = $Failure.InvocationInfo.ScriptLineNumber
        expected_root_exists = Test-Path -LiteralPath $Install -PathType Container
        expected_updater_exists = Test-Path -LiteralPath (Join-Path $Install "Update.exe") -PathType Leaf
        registered_root = if (-not $Location) { "absent" } elseif ($Location -eq $Install) {
            "per-user default"
        } elseif ($Location -eq (Join-Path $Root "cache/Loci")) {
            "qualification cache"
        } elseif ($Location -eq $FallbackInstall) { "Squirrel fallback" } else { "outside allowlist" }
    }
    Save-Receipt
    throw
} finally {
    if ($Locked) { $Lock.ReleaseMutex() }
    $Lock.Dispose()
    foreach ($Key in $EnvironmentKeys) {
        [Environment]::SetEnvironmentVariable($Key, $Previous[$Key])
    }
}
