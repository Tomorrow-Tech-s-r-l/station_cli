$ErrorActionPreference = "Stop"
$requiredMajor = 20

function Get-NodeMajor {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $version = & node -v
    if ($version -match '^v(\d+)') {
      return [int]$Matches[1]
    }
  }
  return $null
}

$major = Get-NodeMajor
if ($major -ge $requiredMajor) {
  Write-Host "Node.js $major found."
  exit 0
}

if (-not (Get-Command nvm -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installing nvm-windows via winget..."
    winget install -e --id CoreyButler.NVMforWindows --accept-package-agreements --accept-source-agreements
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Host "Installing nvm-windows via choco..."
    choco install nvm -y
  } else {
    Write-Error "nvm is not installed and no package manager was found. Install nvm-windows from https://github.com/coreybutler/nvm-windows/releases and re-run."
    exit 1
  }
}

$nvmPath = $null
if (Get-Command nvm -ErrorAction SilentlyContinue) {
  $nvmPath = "nvm"
} elseif ($env:NVM_HOME -and (Test-Path (Join-Path $env:NVM_HOME "nvm.exe"))) {
  $nvmPath = Join-Path $env:NVM_HOME "nvm.exe"
} elseif (Test-Path "$env:ProgramFiles\nvm\nvm.exe") {
  $nvmPath = "$env:ProgramFiles\nvm\nvm.exe"
}

if (-not $nvmPath) {
  Write-Error "nvm.exe not found after install. Restart VS Code and try again."
  exit 1
}

& $nvmPath install 20
& $nvmPath use 20

$major = Get-NodeMajor
if ($major -lt $requiredMajor) {
  Write-Error "Node.js 20 not available after nvm install. Restart VS Code and try again."
  exit 1
}

Write-Host "Node.js $major ready."
