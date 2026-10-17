# Allow inbound traffic on ports 8765 and 8766 through Windows Defender Firewall.
# Run this once on the Windows host to make the UI accessible to phones and other devices on the LAN.

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Elevation required to configure Windows Firewall. Prompting for administrator access..." -ForegroundColor Yellow
    $scriptPath = $MyInvocation.MyCommand.Path
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
    exit
}

Write-Host "Configuring Windows Defender Firewall rules for ports 8765 and 8766..." -ForegroundColor Cyan

# Remove any old rules with the same name
netsh advfirewall firewall delete rule name="ChatWithBooks-UI" 2>$null | Out-Null

# Add inbound rule for ports 8765 and 8766 across all profiles (Domain, Private, Public)
$result = netsh advfirewall firewall add rule name="ChatWithBooks-UI" dir=in action=allow protocol=TCP localport=8765,8766 profile=any
Write-Host $result

# Detect LAN IP
$lanIp = "127.0.0.1"
try {
    $ipObj = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { 
        $_.InterfaceAlias -notmatch "vEthernet|Loopback|WSL|VMnet|tun" -and $_.IPAddress -notlike "169.254*" -and $_.IPAddress -notlike "127.*"
    } | Select-Object -First 1
    if ($ipObj) {
        $lanIp = $ipObj.IPAddress
    }
} catch {
    # fallback
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Firewall configured successfully!" -ForegroundColor Green
Write-Host "Frontend is now reachable from the local network:" -ForegroundColor Green
Write-Host "  Main UI:        http://$lanIp`:8765/" -ForegroundColor Cyan
Write-Host "  Mobile UI:      http://$lanIp`:8765/mobile/" -ForegroundColor Cyan
Write-Host "  Worktree UI:    http://$lanIp`:8766/mobile/" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
