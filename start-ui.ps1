# Start the Session sheet (http://localhost:8765).
# Cognee must already be up on port 8000: docker compose up -d
if (-not (Test-Path .env)) {
    Write-Error ".env not found (copy .env.example .env and set it first)"
    exit 1
}

Get-Content .env | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $parts = $line.Split('=', 2)
        $key = $parts[0].Trim()
        $val = $parts[1].Trim().Trim('"').Trim("'")
        if ($key) {
            [Environment]::SetEnvironmentVariable($key, $val, 'Process')
        }
    }
}

if (-not $env:LLM_API_KEY) {
    Write-Error "LLM_API_KEY not found in .env"
    exit 1
}

if (-not $env:SESSION_UI_HOST) {
    $env:SESSION_UI_HOST = "0.0.0.0"
}

python ui/serve.py
