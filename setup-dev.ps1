# RaccoonHouse Studio — Dev environment setup
# Run once: .\setup-dev.ps1

Write-Host "=== RaccoonHouse Studio — Dev Setup ===" -ForegroundColor Cyan

# Check Node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "Node: $(node --version)" -ForegroundColor Green

# Check Python
$python = $null
foreach ($p in @("python", "python3", "py")) {
    if (Get-Command $p -ErrorAction SilentlyContinue) {
        $python = $p
        break
    }
}
if (-not $python) {
    Write-Host "ERROR: Python not found. Install from https://python.org (3.10+)" -ForegroundColor Red
    exit 1
}
Write-Host "Python: $($python) $(& $python --version)" -ForegroundColor Green

# Install npm deps
Write-Host "`nInstalling npm dependencies..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }

# Create and activate Python venv
Write-Host "`nCreating Python virtual environment..." -ForegroundColor Cyan
if (-not (Test-Path ".venv")) {
    & $python -m venv .venv
}

$pip = ".venv\Scripts\pip.exe"
Write-Host "Installing Python dependencies (this may take a while for torch/audio-separator)..." -ForegroundColor Cyan

# Install PyTorch CPU first (lighter, for development)
& $pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

# Install rest
& $pip install -r backend\requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host "To run in development mode:" -ForegroundColor Cyan
Write-Host "  1. Start backend: .venv\Scripts\python backend\run.py" -ForegroundColor White
Write-Host "  2. Start app:     npm run electron:dev" -ForegroundColor White
Write-Host "`nOr use the combined script:" -ForegroundColor Cyan
Write-Host "  npm run dev:full" -ForegroundColor White
