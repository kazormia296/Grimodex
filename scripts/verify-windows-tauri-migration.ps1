param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$legacyTag = "v0.10.4"
$legacyAsset = "Grimodex_0.10.4_x64-setup.exe"
$legacySha256 = "A44E40BB7C393CC6C656630C15F8729D85E15EE7FE2ACF3B218A7685367A3302"
$legacyUninstallSubKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\Grimodex"
$legacyUninstallKey = "HKCU:\$legacyUninstallSubKey"
$legacyProductSubKey = "Software\miyakey\Grimodex"
$legacyProductKey = "HKCU:\$legacyProductSubKey"
$uninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$legacyDefaultDirectory = Join-Path $env:LOCALAPPDATA "Grimodex"
$electronDirectory = Join-Path $env:LOCALAPPDATA "Programs\grimodex"
$electronExecutable = Join-Path $electronDirectory "Grimodex.exe"
$electronUninstaller = Join-Path $electronDirectory "Uninstall Grimodex.exe"
$roamingDataDirectory = Join-Path $env:APPDATA "com.miyakey.grimodex"
$localDataDirectory = Join-Path $env:LOCALAPPDATA "com.miyakey.grimodex"

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-Installer {
  param(
    [string]$Path,
    [string[]]$Arguments
  )
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer failed with exit code $($process.ExitCode): $Path $($Arguments -join ' ')"
  }
}

function Stop-GrimodexProcesses {
  Get-Process -Name "Grimodex" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

function Get-HkcuValue {
  param(
    [string]$SubKey,
    [string]$Name
  )
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
  if ($null -eq $key) {
    return $null
  }
  try {
    return $key.GetValue($Name)
  }
  finally {
    $key.Dispose()
  }
}

function Get-GrimodexUninstallEntries {
  return @(
    Get-ChildItem -Path $uninstallRoot -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty -Path $_.PSPath } |
      Where-Object { $_.DisplayName -like "Grimodex*" }
  )
}

function Assert-OneElectronRegistration {
  $entries = @(Get-GrimodexUninstallEntries)
  Assert-Condition ($entries.Count -eq 1) "Expected one Grimodex uninstall entry, found $($entries.Count)."
  Assert-Condition (
    [string]$entries[0].UninstallString -like "*$electronDirectory*"
  ) "The remaining uninstall entry does not target the Electron installation."
}

function Assert-SentinelHashes {
  param(
    [string]$RoamingSentinel,
    [string]$RoamingHash,
    [string]$LocalSentinel,
    [string]$LocalHash
  )
  Assert-Condition (Test-Path -LiteralPath $RoamingSentinel) "Roaming Tauri user-data sentinel was deleted."
  Assert-Condition (Test-Path -LiteralPath $LocalSentinel) "Local Tauri user-data sentinel was deleted."
  Assert-Condition (
    (Get-FileHash -LiteralPath $RoamingSentinel -Algorithm SHA256).Hash -eq $RoamingHash
  ) "Roaming Tauri user-data sentinel was modified."
  Assert-Condition (
    (Get-FileHash -LiteralPath $LocalSentinel -Algorithm SHA256).Hash -eq $LocalHash
  ) "Local Tauri user-data sentinel was modified."
}

function Wait-ForElectronRestart {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $launched = @(
      Get-Process -Name "Grimodex" -ErrorAction SilentlyContinue |
        Where-Object {
          [StringComparer]::OrdinalIgnoreCase.Equals($_.Path, $electronExecutable)
        }
    )
    if ($launched.Count -gt 0) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Tauri /R was not translated into an Electron restart."
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$migrationDirectory = Join-Path $env:RUNNER_TEMP "grimodex-tauri-v1-migration"
Remove-Item -LiteralPath $migrationDirectory -Force -Recurse -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $migrationDirectory | Out-Null

Assert-Condition (
  -not [string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY)
) "GITHUB_REPOSITORY is required to resolve the pinned public Tauri release."

# Exercise the exact final Tauri package that users could actually install.
# Both the release tag and SHA-256 are pinned so a replaced asset fails closed.
$legacyInstaller = Join-Path $migrationDirectory $legacyAsset
$legacyUrl = "https://github.com/$env:GITHUB_REPOSITORY/releases/download/$legacyTag/$legacyAsset"
Invoke-WebRequest -Uri $legacyUrl -OutFile $legacyInstaller
Assert-Condition (Test-Path -LiteralPath $legacyInstaller) "Pinned public Tauri v0.10.4 installer is missing."
Assert-Condition (
  (Get-FileHash -LiteralPath $legacyInstaller -Algorithm SHA256).Hash -eq $legacySha256
) "Pinned public Tauri v0.10.4 installer SHA-256 does not match."

# Install the exact final public Tauri package, then place content-bearing
# sentinels in both Tauri data roots. Neither directory is part of the payload.
Invoke-Installer $legacyInstaller @("/P")
Stop-GrimodexProcesses
Assert-Condition (Test-Path -LiteralPath $legacyUninstallKey) "Tauri v1 uninstall registration is missing."
Assert-Condition (Test-Path -LiteralPath $legacyProductKey) "Tauri v1 product registration is missing."
$registeredLegacyDirectory = [string](Get-HkcuValue $legacyProductSubKey "")
Assert-Condition (
  [StringComparer]::OrdinalIgnoreCase.Equals($registeredLegacyDirectory, $legacyDefaultDirectory)
) "Tauri v1 registered an unexpected installation directory: $registeredLegacyDirectory"
Assert-Condition (Test-Path -LiteralPath (Join-Path $registeredLegacyDirectory "grimodex.exe")) "Tauri v1 executable is missing."
Assert-Condition (Test-Path -LiteralPath (Join-Path $registeredLegacyDirectory "uninstall.exe")) "Tauri v1 uninstaller is missing."

New-Item -ItemType Directory -Path $roamingDataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $localDataDirectory -Force | Out-Null
$roamingSentinel = Join-Path $roamingDataDirectory "electron-migration-roaming.sentinel"
$localSentinel = Join-Path $localDataDirectory "electron-migration-local.sentinel"
Set-Content -LiteralPath $roamingSentinel -Value "preserve roaming user data" -NoNewline -Encoding UTF8
Set-Content -LiteralPath $localSentinel -Value "preserve local user data" -NoNewline -Encoding UTF8
$roamingHash = (Get-FileHash -LiteralPath $roamingSentinel -Algorithm SHA256).Hash
$localHash = (Get-FileHash -LiteralPath $localSentinel -Algorithm SHA256).Hash

# Reproduce tauri-plugin-updater's Windows invocation contract. /P becomes
# silent, /R relaunches the new executable, and /UPDATE is passed through only
# as a compatibility marker.
Invoke-Installer $resolvedInstaller @("/P", "/R", "/UPDATE", "/ARGS", "--tauri-bridge-e2e")
Wait-ForElectronRestart
Stop-GrimodexProcesses

Assert-Condition (Test-Path -LiteralPath $electronExecutable) "Electron executable was not installed."
$signature = Get-AuthenticodeSignature -LiteralPath $electronExecutable
Assert-Condition ($signature.Status.ToString() -eq "NotSigned") "Electron executable is expected to remain unsigned."
Assert-Condition (-not (Test-Path -LiteralPath $legacyUninstallKey)) "Tauri v1 uninstall registration remains."
Assert-Condition (-not (Test-Path -LiteralPath $legacyProductKey)) "Tauri v1 product registration remains."
Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $registeredLegacyDirectory "grimodex.exe"))) "Tauri v1 executable remains."
Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $registeredLegacyDirectory "uninstall.exe"))) "Tauri v1 uninstaller remains."
Assert-OneElectronRegistration
Assert-SentinelHashes $roamingSentinel $roamingHash $localSentinel $localHash

$programsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
$startMenuShortcut = Join-Path $programsDirectory "Grimodex.lnk"
Assert-Condition (Test-Path -LiteralPath $startMenuShortcut) "Electron Start Menu shortcut is missing."
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startMenuShortcut)
Assert-Condition (
  [StringComparer]::OrdinalIgnoreCase.Equals($shortcut.TargetPath, $electronExecutable)
) "Electron Start Menu shortcut targets the wrong executable: $($shortcut.TargetPath)"

# A second bridge-style invocation must behave as a normal Electron update and
# must not recreate either legacy registration.
Invoke-Installer $resolvedInstaller @("/P", "/R", "/UPDATE")
Wait-ForElectronRestart
Stop-GrimodexProcesses
Assert-OneElectronRegistration
Assert-Condition (-not (Test-Path -LiteralPath $legacyUninstallKey)) "Idempotent update recreated the Tauri uninstall key."
Assert-SentinelHashes $roamingSentinel $roamingHash $localSentinel $localHash

# Remove Electron, reinstall the public Tauri fixture, then corrupt only the
# legacy uninstaller. The new installer must fail closed before side-by-side.
Assert-Condition (Test-Path -LiteralPath $electronUninstaller) "Electron uninstaller is missing."
Invoke-Installer $electronUninstaller @("/S", "/currentuser")
Assert-Condition (-not (Test-Path -LiteralPath $electronExecutable)) "Electron uninstall did not remove its executable."
Assert-Condition (@(Get-GrimodexUninstallEntries).Count -eq 0) "Electron uninstall registration remains."

Invoke-Installer $legacyInstaller @("/P")
Stop-GrimodexProcesses
$brokenUninstaller = Join-Path $legacyDefaultDirectory "uninstall.exe.disabled"
Move-Item -LiteralPath (Join-Path $legacyDefaultDirectory "uninstall.exe") -Destination $brokenUninstaller
$failedMigration = Start-Process -FilePath $resolvedInstaller -ArgumentList @("/P", "/UPDATE") -Wait -PassThru
Assert-Condition ($failedMigration.ExitCode -ne 0) "Migration unexpectedly accepted an unverifiable Tauri installation."
Assert-Condition (-not (Test-Path -LiteralPath $electronExecutable)) "Fail-closed migration created an Electron side-by-side install."
Assert-Condition (Test-Path -LiteralPath (Join-Path $legacyDefaultDirectory "grimodex.exe")) "Fail-closed migration removed the Tauri executable."
Assert-Condition (Test-Path -LiteralPath $legacyUninstallKey) "Fail-closed migration removed the Tauri registration."
Assert-SentinelHashes $roamingSentinel $roamingHash $localSentinel $localHash

# Leave the ephemeral runner clean enough for artifact upload diagnostics.
Move-Item -LiteralPath $brokenUninstaller -Destination (Join-Path $legacyDefaultDirectory "uninstall.exe")
Invoke-Installer (Join-Path $legacyDefaultDirectory "uninstall.exe") @("/P", "/UPDATE")
