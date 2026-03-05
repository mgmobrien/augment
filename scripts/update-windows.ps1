# Augment plugin updater for Windows
# Pulls latest from git and copies the pre-built plugin files into your Obsidian vault.
# On first run it asks for your vault path and saves it to update.cfg next to this script.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$ConfigFile = "$ScriptDir\update.cfg"

# ── Vault path ──────────────────────────────────────────────────────────────
if (Test-Path $ConfigFile) {
    $VaultPath = (Get-Content $ConfigFile -Raw).Trim()
    Write-Host "Using saved vault path: $VaultPath"
} else {
    Write-Host ""
    Write-Host "First run — vault path not configured."
    Write-Host "Example: C:\Users\Angus\Documents\ObsidianVault"
    Write-Host ""
    $VaultPath = (Read-Host "Enter your Obsidian vault path").Trim().Trim('"')
    $VaultPath | Out-File -FilePath $ConfigFile -NoNewline -Encoding utf8
    Write-Host "Saved to $ConfigFile"
}

$PluginDir = "$VaultPath\.obsidian\plugins\augment-terminal"

# ── Git pull ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Pulling latest..."
Push-Location $RepoRoot
try {
    git pull
} finally {
    Pop-Location
}

# ── Copy files ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installing to $PluginDir ..."
New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
Copy-Item "$RepoRoot\main.js"       -Destination $PluginDir -Force
Copy-Item "$RepoRoot\manifest.json" -Destination $PluginDir -Force
Copy-Item "$RepoRoot\styles.css"    -Destination $PluginDir -Force

Write-Host ""
Write-Host "Done. Reload the plugin in Obsidian (Settings -> Community plugins -> toggle off/on)."
