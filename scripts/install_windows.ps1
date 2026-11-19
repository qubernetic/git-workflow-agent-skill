<#
.SYNOPSIS
    Install or uninstall the git-workflow skill for Claude Code (Windows).

.DESCRIPTION
    Creates a symlink so the skill stays in sync with the repo.
    Symlinks on Windows require either Developer Mode enabled or an
    elevated (Administrator) terminal.
    Also registers the optional workflow guard hooks (hooks\guard.mjs)
    when node is available.

.PARAMETER Uninstall
    Remove the skill symlink and the agent hooks. Per-repository git hooks
    from "enable --git-hooks" and the user config stay.

.PARAMETER NoHooks
    Do not touch the guard hooks.

.PARAMETER Scope
    Guard scope: opt-in (default) or all.

.EXAMPLE
    .\scripts\install_windows.ps1
    .\scripts\install_windows.ps1 -Scope all
    .\scripts\install_windows.ps1 -NoHooks
    .\scripts\install_windows.ps1 -Uninstall
#>

param(
    [switch]$Uninstall,
    [switch]$NoHooks,
    [ValidateSet("opt-in", "all")]
    [string]$Scope = ""
)

$ErrorActionPreference = "Stop"

$SkillDir = Join-Path $env:USERPROFILE ".claude\skills\git-workflow"
$SkillFile = Join-Path $SkillDir "SKILL.md"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Source = Join-Path $RepoRoot "SKILL.md"
$Guard = Join-Path $RepoRoot "hooks\guard.mjs"

function Write-Info  { param($Msg) Write-Host "  i " -ForegroundColor Blue -NoNewline; Write-Host $Msg }
function Write-Pass  { param($Msg) Write-Host "  $([char]0x2713) " -ForegroundColor Green -NoNewline; Write-Host $Msg }
function Write-Fail  { param($Msg) Write-Host "  $([char]0x2717) " -ForegroundColor Red -NoNewline; Write-Host $Msg }

function Test-SymlinkSupport {
    $testDir = Join-Path $env:TEMP "symlink_test_$(Get-Random)"
    $testLink = Join-Path $env:TEMP "symlink_test_link_$(Get-Random)"
    try {
        New-Item -ItemType Directory -Path $testDir -Force | Out-Null
        New-Item -ItemType SymbolicLink -Path $testLink -Target $testDir -ErrorAction Stop | Out-Null
        Remove-Item $testLink -Force
        Remove-Item $testDir -Force
        return $true
    } catch {
        Remove-Item $testDir -Force -ErrorAction SilentlyContinue
        return $false
    }
}

# Run the guard subcommand (plus any extra args) unless hooks are skipped or
# node is missing. A guard failure is reported but does not abort.
function Invoke-Guard {
    param([string]$Sub, [string[]]$GuardArgs = @())
    if ($NoHooks) {
        Write-Info "Skipping guard hooks (-NoHooks)"
    } elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Info "Skipping guard hooks - node not found (the skill works without them)"
    } elseif (-not (Test-Path $Guard)) {
        Write-Info "Skipping guard hooks - $Guard not found"
    } else {
        & node $Guard $Sub @GuardArgs
        if ($LASTEXITCODE -eq 0) {
            Write-Pass "Guard hooks: $Sub done"
        } else {
            Write-Fail "Guard hooks: $Sub failed (the skill itself is unaffected)"
        }
    }
}

function Invoke-Uninstall {
    Invoke-Guard "uninstall"
    $item = Get-Item $SkillFile -ErrorAction SilentlyContinue
    if ($item -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Remove-Item $SkillFile -Force
        Write-Pass "Removed symlink: $SkillFile"
        # Remove directory if empty
        if ((Get-ChildItem $SkillDir -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
            Remove-Item $SkillDir -Force
            Write-Info "Removed empty directory: $SkillDir"
        }
    } elseif ($item) {
        Write-Fail "$SkillFile exists but is not a symlink - remove it manually to avoid data loss"
        exit 1
    } else {
        Write-Info "Nothing to uninstall - $SkillFile does not exist"
    }
}

function Invoke-Install {
    # Verify source exists
    if (-not (Test-Path $Source)) {
        Write-Fail "SKILL.md not found at $Source"
        exit 1
    }

    # Check if already installed
    $item = Get-Item $SkillFile -ErrorAction SilentlyContinue
    if ($item -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $currentTarget = $item.Target
        if ($currentTarget -eq $Source) {
            Write-Pass "Already installed (symlink points to $Source)"
            return
        } else {
            Write-Info "Existing symlink points to $currentTarget - replacing"
            Remove-Item $SkillFile -Force
        }
    } elseif ($item) {
        Write-Fail "$SkillFile exists but is not a symlink - remove it manually before installing"
        exit 1
    }

    # Check symlink support
    if (-not (Test-SymlinkSupport)) {
        Write-Fail "Cannot create symlinks. Enable Developer Mode (Settings > For developers) or run as Administrator."
        Write-Info "Falling back to file copy (will not auto-sync with repo)."
        New-Item -ItemType Directory -Path $SkillDir -Force | Out-Null
        Copy-Item $Source $SkillFile
        Write-Pass "Installed (copy): $SkillFile"
        Write-Info "Note: This is a copy, not a symlink. Re-run the installer after updates to sync."
        return
    }

    # Create directory and symlink
    New-Item -ItemType Directory -Path $SkillDir -Force | Out-Null
    New-Item -ItemType SymbolicLink -Path $SkillFile -Target $Source | Out-Null
    Write-Pass "Installed: $SkillFile -> $Source"
    Write-Info "The skill will stay in sync with this repo. Restart Claude Code to activate."
}

# --- Main ---
if ($Uninstall) {
    Invoke-Uninstall
} else {
    Invoke-Install
    if ($Scope) {
        Invoke-Guard "install" @("--scope", $Scope)
    } else {
        Invoke-Guard "install"
    }
}
