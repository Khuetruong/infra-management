<#
  Installs / removes the Infra agent on Windows. Dot-source or pipe into iex, then call a function:
    iwr https://infra.example.com/agent/install.ps1 -UseBasicParsing | iex
    Install-InfraAgent -Server 'https://infra.example.com' -Token 'enr_xxx'
    Uninstall-InfraAgent [-Purge]

  The agent runs as a named scheduled task "InfraAgent" under SYSTEM, started at boot — a
  visible, listed, consent-based service with full logging. It opens no inbound port.
#>
Set-StrictMode -Version 2.0
$script:InfraBase = Join-Path $env:ProgramData 'infra-agent'
$script:InfraTask = 'InfraAgent'
$script:InfraScript = Join-Path $script:InfraBase 'infra_agent.ps1'
$script:InfraConfig = Join-Path $script:InfraBase 'config.json'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Hãy chạy PowerShell với quyền Administrator.'
  }
}

function Install-InfraAgent {
  param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$CaFile,
    [switch]$InsecureHttp
  )
  Assert-Admin
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocol]::Tls12 -bor [Net.SecurityProtocol]::Tls11
  if (-not (Test-Path $script:InfraBase)) { New-Item -ItemType Directory -Force -Path $script:InfraBase | Out-Null }

  # download the agent script
  $src = ($Server.TrimEnd('/')) + '/agent/infra_agent.ps1'
  Write-Host "Tải agent từ $src"
  Invoke-WebRequest -Uri $src -OutFile $script:InfraScript -UseBasicParsing

  # enroll (only if not already enrolled)
  if (Test-Path $script:InfraConfig) {
    Write-Host "Đã có cấu hình tại $($script:InfraConfig); giữ nguyên (xoá file này để enroll lại)."
  } else {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:InfraScript, '-Command', 'enroll',
      '-Server', $Server, '-Token', $Token, '-Config', $script:InfraConfig)
    if ($CaFile) { $args += @('-CaFile', $CaFile) }
    if ($InsecureHttp) { $args += '-InsecureHttp' }
    & powershell.exe @args
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $script:InfraConfig)) { throw 'Enroll thất bại.' }
  }

  # register (or refresh) the scheduled task running the agent loop as SYSTEM at startup
  $runArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($script:InfraScript)`" -Command run -Config `"$($script:InfraConfig)`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $runArgs
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero)
  if (Get-ScheduledTask -TaskName $script:InfraTask -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $script:InfraTask -Confirm:$false
  }
  Register-ScheduledTask -TaskName $script:InfraTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Infra management agent (outbound-only control plane agent)' | Out-Null
  Start-ScheduledTask -TaskName $script:InfraTask
  Write-Host 'infra-agent đã cài và đang chạy (Task Scheduler -> InfraAgent).'
  Write-Host 'Shell tự do bị TẮT mặc định. Để bật: đặt "allow_shell": true trong config.json rồi khởi động lại task.'
}

function Uninstall-InfraAgent {
  param([switch]$Purge)
  Assert-Admin
  if (Get-ScheduledTask -TaskName $script:InfraTask -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $script:InfraTask -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $script:InfraTask -Confirm:$false
    Write-Host 'Đã gỡ task InfraAgent.'
  }
  # stop any lingering agent loop process
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'infra_agent\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Test-Path $script:InfraScript) { Remove-Item $script:InfraScript -Force -ErrorAction SilentlyContinue }
  if ($Purge) {
    if (Test-Path $script:InfraBase) { Remove-Item $script:InfraBase -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host 'infra-agent đã gỡ hoàn toàn (kèm cấu hình).'
  } else {
    Write-Host "infra-agent đã gỡ. Cấu hình giữ tại $($script:InfraBase) (dùng -Purge để xoá hẳn)."
  }
}
