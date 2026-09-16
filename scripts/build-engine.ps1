$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList
    )
    & $Command @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Command exited with status $LASTEXITCODE"
    }
}

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDirectory
$EngineRoot = Join-Path $ProjectRoot "engine"
$Bundle = Join-Path $EngineRoot "dist\loci-engine"
$Executable = Join-Path $Bundle "loci-engine.exe"
$QaRoot = Join-Path ([IO.Path]::GetTempPath()) ("loci-frozen-qa-" + [guid]::NewGuid().ToString("N"))
$ImsFixture = Join-Path $QaRoot "modern-overview.ims"
$UvRun = @("run", "--frozen", "--extra", "dev", "--extra", "bundle", "--extra", "cellpose", "--extra", "onnx")

Push-Location $EngineRoot
try {
    # Keep developer verification tools available after the build; PyInstaller
    # includes only the runtime imports and explicitly collected package data.
    Invoke-Native uv @(
        "sync", "--python", "3.12", "--frozen",
        "--extra", "dev", "--extra", "bundle", "--extra", "cellpose", "--extra", "onnx"
    )
    Invoke-Native uv @($UvRun + @(
        "python", "-c",
        "import platform,sys; assert sys.version_info[:2] == (3, 12), sys.version; assert platform.machine().lower() in {'amd64','x86_64'}, platform.machine()"
    ))
    Invoke-Native uv @($UvRun + @(
        "python", "-c",
        "import SimpleITK, mcp, numcodecs, onnx, onnxruntime, openslide, roifile, yaml, zarr"
    ))
    $OnnxRuntimeRoot = & uv @($UvRun + @(
        "python", "-c",
        "from importlib.util import find_spec; spec = find_spec('onnxruntime'); assert spec and spec.submodule_search_locations; print(next(iter(spec.submodule_search_locations)))"
    ))
    if ($LASTEXITCODE -ne 0) {
        throw "uv exited with status $LASTEXITCODE"
    }
    $OnnxRuntimeRoot = ([string]$OnnxRuntimeRoot).Trim()
    $OnnxRuntimeLicense = Join-Path $OnnxRuntimeRoot "LICENSE"
    $OnnxRuntimeNotices = Join-Path $OnnxRuntimeRoot "ThirdPartyNotices.txt"
    foreach ($Notice in @($OnnxRuntimeLicense, $OnnxRuntimeNotices)) {
        if (-not (Test-Path -LiteralPath $Notice -PathType Leaf)) {
            throw "ONNX Runtime notice is missing: $Notice"
        }
    }

    # ONNX and ONNX Runtime are statically imported by the bounded model-package
    # path. Normal analysis and the contributed ONNX Runtime hook retain the
    # runtime modules and provider libraries. Avoid --collect-all because it
    # bundles thousands of upstream conformance fixtures and conversion tools.
    $PyInstallerArguments = @(
        $UvRun + @("pyinstaller",
        "--noconfirm", "--clean", "--onedir", "--name", "loci-engine",
        "--distpath", (Join-Path $EngineRoot "dist"),
        "--workpath", (Join-Path $EngineRoot "build\pyinstaller"),
        "--specpath", (Join-Path $EngineRoot "build\pyinstaller"),
        "--additional-hooks-dir", (Join-Path $ScriptDirectory "pyinstaller_hooks"),
        "--collect-all", "imagecodecs",
        "--collect-all", "SimpleITK",
        "--collect-all", "openslide",
        "--collect-all", "openslide_bin",
        "--collect-all", "zarr",
        "--collect-all", "numcodecs",
        "--hidden-import", "onnx",
        "--hidden-import", "onnxruntime",
        "--add-data", "$OnnxRuntimeLicense;onnxruntime",
        "--add-data", "$OnnxRuntimeNotices;onnxruntime",
        "--collect-all", "yaml",
        "--collect-all", "roifile",
        "--copy-metadata", "cellpose",
        "--copy-metadata", "h5py",
        "--copy-metadata", "SimpleITK",
        "--copy-metadata", "openslide-python",
        "--copy-metadata", "openslide-bin",
        "--copy-metadata", "zarr",
        "--copy-metadata", "numcodecs",
        "--copy-metadata", "roifile",
        "--copy-metadata", "onnx",
        "--copy-metadata", "onnxruntime",
        "--copy-metadata", "PyYAML",
        "--copy-metadata", "mcp",
        "--exclude-module", "matplotlib",
        "--exclude-module", "pandas",
        "--exclude-module", "tkinter",
        (Join-Path $EngineRoot "loci_engine_entry.py")))
    Invoke-Native uv $PyInstallerArguments

    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw "Frozen Windows worker is missing: $Executable"
    }

    New-Item -ItemType Directory -Path $QaRoot | Out-Null
    Invoke-Native uv @($UvRun + @(
        "python",
        (Join-Path $ScriptDirectory "create-ims-qa-fixture.py"), $ImsFixture
    ))
    Invoke-Native uv @($UvRun + @(
        "python",
        (Join-Path $ScriptDirectory "verify_frozen_engine_bundle.py"),
        "--bundle", $Bundle,
        "--lock", (Join-Path $EngineRoot "uv.lock"),
        "--platform", "win32",
        "--arch", "x64"
    ))
    Invoke-Native uv @($UvRun + @(
        "python",
        (Join-Path $ScriptDirectory "qa-frozen-engine.py"),
        $Executable, $ImsFixture
    ))
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $QaRoot) {
        Remove-Item -LiteralPath $QaRoot -Recurse -Force
    }
}
