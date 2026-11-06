#Requires -Version 5.1
<#
  Infra agent for Windows. Connects a Windows server to the control plane.
  - Outbound only: polls the control plane over HTTPS; opens no inbound port.
  - Runs only the allowlisted actions below, re-validating every parameter locally.
  - shell.exec is refused unless allow_shell=true in this server's LOCAL config file.

  Usage:
    infra_agent.ps1 -Command enroll -Server https://infra.example.com -Token enr_xxx [-Config PATH] [-CaFile PATH] [-InsecureHttp]
    infra_agent.ps1 -Command run   [-Config PATH]     # long-running loop (scheduled task / service)
    infra_agent.ps1 -Command once  [-Config PATH]     # one heartbeat + run received tasks (testing)
#>
param(
  [string]$Command = 'run',
  [string]$Server,
  [string]$Token,
  [string]$Config = "$env:ProgramData\infra-agent\config.json",
  [string]$CaFile,
  [switch]$InsecureHttp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:VERSION = '0.1.0'
$script:MAX_OUTPUT = 200 * 1024
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Write-Log { param([Parameter(ValueFromRemainingArguments = $true)]$m) Write-Host ((Get-Date).ToString('s') + ' ' + ($m -join ' ')) }

# ----------------------------------------------------------------------------- config & HTTP
function Read-Config { param($Path) Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
function Save-Config {
  param($Path, $Cfg)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ($Cfg | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-ApiJson {
  param($Cfg, $Method, $Path, $Body, $TokenStr, $TimeoutSec = 30)
  $url = ($Cfg.server_url.TrimEnd('/')) + $Path
  $headers = @{ 'Content-Type' = 'application/json; charset=utf-8'; 'User-Agent' = "infra-agent-win/$($script:VERSION)" }
  if ($TokenStr) { $headers['Authorization'] = "Bearer $TokenStr" }
  $json = ($Body | ConvertTo-Json -Depth 12 -Compress)
  # Windows PowerShell 5.1 sends a string -Body as Latin-1, which mangles non-ASCII (Vietnamese).
  # Send explicit UTF-8 bytes so the server receives the text intact.
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  try {
    $resp = Invoke-WebRequest -Uri $url -Method $Method -Headers $headers -Body $bytes -UseBasicParsing -TimeoutSec $TimeoutSec
    if ($resp.Content) { return ($resp.Content | ConvertFrom-Json) } else { return @{} }
  } catch {
    $r = $_.Exception.Response
    if ($r) {
      try {
        $sr = New-Object IO.StreamReader($r.GetResponseStream())
        $errText = $sr.ReadToEnd()
        $msg = ($errText | ConvertFrom-Json).error
      } catch { $msg = $_.Exception.Message }
      throw "HTTP $([int]$r.StatusCode): $msg"
    }
    throw $_.Exception.Message
  }
}

# ----------------------------------------------------------------------------- facts & metrics
function Get-PrimaryIp {
  try {
    $r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
    (Get-NetIPAddress -InterfaceIndex $r.ifIndex -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1).IPAddress
  } catch { try { (Test-Connection -ComputerName $env:COMPUTERNAME -Count 1 -ErrorAction Stop).IPV4Address.IPAddressToString } catch { $null } }
}

function Get-Facts {
  $os = $null; $cs = $null
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {}
  try { $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop } catch {}
  $fw = $null
  try { $fw = (Get-NetFirewallProfile -ErrorAction Stop | Where-Object { $_.Enabled } | Select-Object -First 1).Name } catch {}
  [ordered]@{
    hostname        = $env:COMPUTERNAME
    os              = if ($os) { $os.Caption } else { 'Windows' }
    os_id           = 'windows'
    kernel          = if ($os) { $os.Version } else { [string][Environment]::OSVersion.Version }
    arch            = $env:PROCESSOR_ARCHITECTURE
    cpu_count       = [int]$env:NUMBER_OF_PROCESSORS
    mem_total       = if ($cs) { [int64]$cs.TotalPhysicalMemory } else { $null }
    primary_ip      = Get-PrimaryIp
    package_manager = 'windows-update'
    init            = 'service'
    firewall        = if ($fw) { "windows-firewall ($fw)" } else { 'off' }
    agent_runtime   = "powershell $($PSVersionTable.PSVersion)"
  }
}

function Get-PendingReboot {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($k in $keys) { if (Test-Path $k) { return $true } }
  return $false
}

function Get-Metrics {
  $os = $null
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {}
  $cpu = $null
  try { $cpu = [math]::Round((Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average, 1) } catch {}
  $memPct = $null; $memUsed = $null
  if ($os -and $os.TotalVisibleMemorySize) {
    $total = [int64]$os.TotalVisibleMemorySize * 1024
    $free = [int64]$os.FreePhysicalMemory * 1024
    $memUsed = $total - $free
    $memPct = [math]::Round(100.0 * $memUsed / $total, 1)
  }
  $diskPct = $null; $diskUsed = $null; $diskTotal = $null
  try {
    $sys = ($env:SystemDrive).TrimEnd(':')
    $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($sys):'" -ErrorAction Stop
    if ($d.Size) { $diskTotal = [int64]$d.Size; $diskUsed = $diskTotal - [int64]$d.FreeSpace; $diskPct = [math]::Round(100.0 * $diskUsed / $diskTotal, 1) }
  } catch {}
  $uptime = $null
  if ($os) { try { $uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds } catch {} }
  [ordered]@{
    cpu_percent      = $cpu
    mem_percent      = $memPct
    mem_used         = $memUsed
    disk_percent     = $diskPct
    disk_used        = $diskUsed
    disk_total       = $diskTotal
    uptime_seconds   = $uptime
    reboot_required  = Get-PendingReboot
  }
}

# ----------------------------------------------------------------------------- validation
# spec: @{ param = @{ type='int'|'bool'|'enum'|'string'|'secret'|'shell'; ... } }
$script:ACTIONS = [ordered]@{
  'system.info'               = @{}
  'system.disk_usage'         = @{}
  'system.processes'          = @{ limit = @{ type = 'int'; min = 1; max = 100; default = 15 } }
  'system.users'              = @{}
  'system.update_check'       = @{}
  'system.update_apply'       = @{ security_only = @{ type = 'bool'; default = $true } }
  'system.reboot'             = @{ delay_minutes = @{ type = 'int'; min = 0; max = 60; default = 1 } }
  'service.list'              = @{}
  'service.status'            = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'service.restart'           = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'service.start'             = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'service.stop'              = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'logs.tail'                 = @{ unit = @{ type = 'string'; pattern = '^[A-Za-z0-9@._:/\\ -]{1,128}$' }; lines = @{ type = 'int'; min = 1; max = 2000; default = 200 } }
  'security.audit'            = @{}
  'security.listening_ports'  = @{}
  'security.failed_logins'    = @{ lines = @{ type = 'int'; min = 1; max = 1000; default = 100 } }
  'security.firewall_status'  = @{}
  'security.firewall_allow'   = @{ port = @{ type = 'int'; min = 1; max = 65535; required = $true }; proto = @{ type = 'enum'; values = @('tcp', 'udp'); default = 'tcp' } }
  'security.firewall_deny'    = @{ port = @{ type = 'int'; min = 1; max = 65535; required = $true }; proto = @{ type = 'enum'; values = @('tcp', 'udp'); default = 'tcp' } }
  'security.block_ip'         = @{ ip = @{ type = 'string'; pattern = '^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$'; required = $true } }
  'security.deep_audit'       = @{}
  'security.disable_smb1'     = @{}
  'security.disable_guest'    = @{}
  'shell.exec'                = @{ command = @{ type = 'shell' } }
  'net.scan'                  = @{ targets = @{ type = 'string'; pattern = '^[0-9A-Fa-f:.,/ ]{0,512}$' }; ports = @{ type = 'string'; pattern = '^[0-9, ]{0,256}$' }; deep = @{ type = 'bool'; default = $false }; snmp_community = @{ type = 'secret' } }
  'net.remote_install'        = @{ host = @{ type = 'string'; pattern = '^[0-9A-Za-z._:-]{1,255}$'; required = $true }; os = @{ type = 'enum'; values = @('linux', 'windows'); default = 'linux' }; ssh_user = @{ type = 'string'; pattern = '^[A-Za-z0-9._-]{1,64}$' }; ssh_port = @{ type = 'int'; min = 1; max = 65535; default = 22 }; server_url = @{ type = 'string'; pattern = '^https?://[^\s]{3,256}$'; required = $true }; enroll_token = @{ type = 'string'; pattern = '^[A-Za-z0-9_-]{8,160}$'; required = $true }; ssh_password = @{ type = 'secret' }; ssh_key = @{ type = 'secret' } }
  'net.remote_uninstall'      = @{ host = @{ type = 'string'; pattern = '^[0-9A-Za-z._:-]{1,255}$'; required = $true }; os = @{ type = 'enum'; values = @('linux', 'windows'); default = 'linux' }; ssh_user = @{ type = 'string'; pattern = '^[A-Za-z0-9._-]{1,64}$' }; ssh_port = @{ type = 'int'; min = 1; max = 65535; default = 22 }; server_url = @{ type = 'string'; pattern = '^https?://[^\s]{3,256}$'; required = $true }; purge = @{ type = 'bool'; default = $false }; ssh_password = @{ type = 'secret' }; ssh_key = @{ type = 'secret' } }
}

class Rejected : System.Exception { Rejected([string]$m) : base($m) {} }

function Resolve-Params {
  param($Action, $Params, $Cfg)
  if (-not $script:ACTIONS.Contains($Action)) { throw [Rejected]::new("action not allowed by agent: $Action") }
  $spec = $script:ACTIONS[$Action]
  if ($null -eq $Params) { $Params = @{} }
  $ph = @{}
  foreach ($p in $Params.PSObject.Properties) { $ph[$p.Name] = $p.Value }
  foreach ($k in $ph.Keys) { if (-not $spec.Contains($k)) { throw [Rejected]::new("unknown parameter: $k") } }
  $out = @{}
  foreach ($k in $spec.Keys) {
    $s = $spec[$k]
    $v = if ($ph.Contains($k)) { $ph[$k] } else { $null }
    $skip = $false
    # Use index access ($s['key']) for optional spec keys: under Set-StrictMode -Version 2.0,
    # dot access to an absent key (e.g. $s.required on an optional string param) throws
    # "property cannot be found". Index access returns $null safely.
    switch ($s['type']) {
      'int' {
        if ($null -eq $v) { $v = $s['default'] }
        $iv = 0
        if ($null -eq $v -or -not [int]::TryParse([string]$v, [ref]$iv)) { throw [Rejected]::new("invalid $k") }
        $v = $iv
        if ($v -lt $s['min'] -or $v -gt $s['max']) { throw [Rejected]::new("invalid $k") }
      }
      'bool' { if ($null -eq $v) { $v = $s['default'] }; if ($v -isnot [bool]) { throw [Rejected]::new("invalid $k") } }
      'enum' { if ($null -eq $v -or $v -eq '') { $v = $s['default'] }; if ($s['values'] -notcontains $v) { throw [Rejected]::new("invalid $k") } }
      'string' {
        if ($null -eq $v -or $v -eq '') { if ($s['required']) { throw [Rejected]::new("invalid $k") } else { $skip = $true } }
        elseif ([string]$v -notmatch $s['pattern']) { throw [Rejected]::new("invalid $k") }
        else { $v = [string]$v }
      }
      'secret' { if ($null -eq $v) { $skip = $true } elseif ($v -isnot [string]) { throw [Rejected]::new("invalid $k") } }
      'shell' {
        if (-not $Cfg.allow_shell) { throw [Rejected]::new("shell.exec is disabled in this agent's local config (allow_shell=false)") }
        if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 4000) { throw [Rejected]::new("invalid $k") }
      }
    }
    if (-not $skip) { $out[$k] = $v }
  }
  return $out
}

# ----------------------------------------------------------------------------- action helpers
function New-Result { param($code, $output, $result = $null) [pscustomobject]@{ code = $code; output = $output; result = $result } }
function Clip { param($s) if ($null -eq $s) { '' } else { $t = [string]$s; if ($t.Length -gt $script:MAX_OUTPUT) { $t.Substring($t.Length - $script:MAX_OUTPUT) } else { $t } } }

function Act-SystemInfo {
  $d = @{}; (Get-Facts).GetEnumerator() | ForEach-Object { $d[$_.Key] = $_.Value }; (Get-Metrics).GetEnumerator() | ForEach-Object { $d[$_.Key] = $_.Value }
  New-Result 0 ($d | ConvertTo-Json -Depth 6) $d
}
function Act-DiskUsage {
  $rows = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    "{0}  {1:N1} GB / {2:N1} GB  ({3:N0}% dùng)" -f $_.DeviceID, (($_.Size - $_.FreeSpace) / 1GB), ($_.Size / 1GB), (100.0 * ($_.Size - $_.FreeSpace) / [math]::Max($_.Size, 1))
  }
  New-Result 0 ($rows -join "`n")
}
function Act-Processes { param($p)
  $rows = Get-Process | Sort-Object CPU -Descending | Select-Object -First $p.limit |
    ForEach-Object { "{0,8} {1,6:N1}  {2,8:N0} MB  {3}" -f $_.Id, ([double]$_.CPU), ($_.WorkingSet64 / 1MB), $_.ProcessName }
  New-Result 0 (("   PID    CPU(s)       RAM  NAME`n") + ($rows -join "`n"))
}
function Act-Users {
  $users = @()
  try { $users = Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object { @{ name = $_.Name; enabled = [bool]$_.Enabled; last_logon = [string]$_.LastLogon } } } catch {
    $users = Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True" | ForEach-Object { @{ name = $_.Name; enabled = (-not $_.Disabled) } }
  }
  New-Result 0 (($users | ForEach-Object { $_.name }) -join "`n") @{ users = $users }
}
function Act-UpdateCheck {
  try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $res = $searcher.Search("IsInstalled=0 and Type='Software'")
    $items = @(); foreach ($u in $res.Updates) { $items += $u.Title }
    New-Result 0 (("$($items.Count) bản cập nhật đang chờ:`n") + ($items -join "`n")) @{ count = $items.Count }
  } catch { New-Result 1 "Không truy vấn được Windows Update: $($_.Exception.Message)" }
}
function Act-UpdateApply { param($p)
  try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $q = if ($p.security_only) { "IsInstalled=0 and Type='Software' and AutoSelectOnWebSites=1" } else { "IsInstalled=0 and Type='Software'" }
    $res = $searcher.Search($q)
    if ($res.Updates.Count -eq 0) { return New-Result 0 'Không có bản cập nhật nào cần cài.' @{ installed = 0 } }
    $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $res.Updates) { if ($u.EulaAccepted -eq $false) { $u.AcceptEula() }; [void]$toInstall.Add($u) }
    $dl = $session.CreateUpdateDownloader(); $dl.Updates = $toInstall; [void]$dl.Download()
    $inst = $session.CreateUpdateInstaller(); $inst.Updates = $toInstall; $r = $inst.Install()
    New-Result ([int]($r.ResultCode -ne 2 -and $r.ResultCode -ne 3)) ("Đã cài $($toInstall.Count) bản. ResultCode=$($r.ResultCode), RebootRequired=$($r.RebootRequired)") @{ installed = $toInstall.Count; reboot_required = [bool]$r.RebootRequired }
  } catch { New-Result 1 "Lỗi khi cài cập nhật: $($_.Exception.Message)" }
}
function Act-Reboot { param($p)
  $o = (& shutdown.exe /r /t ([int]$p.delay_minutes * 60) /c 'Reboot requested from control plane' 2>&1 | Out-String)
  New-Result $LASTEXITCODE "$o`nServer sẽ khởi động lại sau $($p.delay_minutes) phút."
}
function Get-SvcOut { param($verb, $name)
  try {
    switch ($verb) {
      'status'  { $s = Get-Service -Name $name -ErrorAction Stop; return New-Result 0 "$($s.DisplayName) [$($s.Name)]: $($s.Status)" @{ active = [string]$s.Status } }
      'restart' { Restart-Service -Name $name -Force -ErrorAction Stop }
      'start'   { Start-Service -Name $name -ErrorAction Stop }
      'stop'    { Stop-Service -Name $name -Force -ErrorAction Stop }
    }
    $s = Get-Service -Name $name -ErrorAction Stop
    New-Result 0 "$($s.Name): $($s.Status)" @{ active = [string]$s.Status }
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-ServiceList {
  $rows = Get-Service | Where-Object { $_.Status -eq 'Running' } | Sort-Object Name | ForEach-Object { "{0}  {1}" -f $_.Name, $_.DisplayName }
  New-Result 0 ($rows -join "`n")
}
function Act-LogsTail { param($p)
  $logName = if ($p.Contains('unit') -and $p.unit) { $p.unit } else { 'System' }
  try {
    $rows = Get-WinEvent -LogName $logName -MaxEvents $p.lines -ErrorAction Stop |
      ForEach-Object { "{0:s} [{1}] {2}: {3}" -f $_.TimeCreated, $_.LevelDisplayName, $_.ProviderName, ($_.Message -replace "`r?`n", ' ') }
    New-Result 0 (($rows | Select-Object -Last $p.lines) -join "`n")
  } catch { New-Result 1 "Không đọc được log '$logName': $($_.Exception.Message)" }
}
function Get-ListeningPorts {
  $ports = @()
  try {
    $conns = Get-NetTCPConnection -State Listen -ErrorAction Stop
    foreach ($c in $conns) {
      $proc = $null; try { $proc = (Get-Process -Id $c.OwningProcess -ErrorAction Stop).ProcessName } catch {}
      $ports += @{ proto = 'tcp'; local = "$($c.LocalAddress):$($c.LocalPort)"; process = $proc }
    }
  } catch {}
  return $ports
}
function Act-ListeningPorts {
  $ports = Get-ListeningPorts
  New-Result 0 (($ports | ForEach-Object { "{0,-5} {1,-28} {2}" -f $_.proto, $_.local, $_.process }) -join "`n") @{ ports = $ports }
}
function Act-FailedLogins { param($p)
  try {
    $evts = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } -MaxEvents $p.lines -ErrorAction Stop
    $counts = @{}
    foreach ($e in $evts) {
      $ip = ($e.Properties | Where-Object { $_.Value -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -First 1).Value
      if ($ip) { if ($counts.Contains($ip)) { $counts[$ip]++ } else { $counts[$ip] = 1 } }
    }
    $top = $counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 20
    $header = if ($top) { 'Top IP: ' + (($top | ForEach-Object { "$($_.Key) ($($_.Value))" }) -join ', ') } else { 'Không có đăng nhập thất bại' }
    New-Result 0 $header @{ top_sources = @($top | ForEach-Object { @{ ip = $_.Key; count = $_.Value } }) }
  } catch { New-Result 0 'Không có sự kiện đăng nhập thất bại (hoặc không đủ quyền đọc Security log).' @{ top_sources = @() } }
}
function Act-FirewallStatus {
  try {
    $rows = Get-NetFirewallProfile | ForEach-Object { "{0}: {1}" -f $_.Name, (@('Tắt', 'Bật')[[int][bool]$_.Enabled]) }
    New-Result 0 ($rows -join "`n")
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-FirewallRule { param($p, $action)
  try {
    $name = "InfraAgent $action $($p.proto)/$($p.port)"
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action (@{ allow = 'Allow'; deny = 'Block' }[$action]) -Protocol $p.proto.ToUpper() -LocalPort $p.port -ErrorAction Stop | Out-Null
    New-Result 0 "Đã tạo luật firewall: $name"
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-BlockIp { param($p)
  try {
    New-NetFirewallRule -DisplayName "InfraAgent block $($p.ip)" -Direction Inbound -Action Block -RemoteAddress $p.ip -ErrorAction Stop | Out-Null
    New-Result 0 "Đã chặn IP: $($p.ip)"
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-SecurityAudit {
  $findings = New-Object System.Collections.ArrayList
  $add = { param($sev, $fid, $title, $detail = '') [void]$findings.Add(@{ id = $fid; severity = $sev; title = $title; detail = $detail }) }
  # firewall
  try { if ((Get-NetFirewallProfile | Where-Object { -not $_.Enabled })) { & $add 'medium' 'firewall_off' 'Có profile firewall đang tắt' '' } } catch {}
  # RDP exposure
  try {
    $rdp = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction Stop).fDenyTSConnections
    if ($rdp -eq 0) { & $add 'medium' 'rdp_on' 'RDP đang bật' 'Giới hạn bằng firewall / NLA nếu không cần truy cập từ ngoài' }
  } catch {}
  # SMBv1
  try { $smb1 = Get-SmbServerConfiguration -ErrorAction Stop; if ($smb1.EnableSMB1Protocol) { & $add 'high' 'smb1' 'SMBv1 đang bật' 'Tắt SMBv1 (giao thức lỗi thời, nhiều lỗ hổng)' } } catch {}
  # Guest account
  try { $g = Get-LocalUser -Name 'Guest' -ErrorAction Stop; if ($g.Enabled) { & $add 'high' 'guest_on' 'Tài khoản Guest đang bật' '' } } catch {}
  # Defender
  try { $av = Get-MpComputerStatus -ErrorAction Stop; if (-not $av.RealTimeProtectionEnabled) { & $add 'high' 'defender_off' 'Windows Defender real-time đang tắt' '' } } catch {}
  # pending updates
  try { $cnt = (Act-UpdateCheck).result.count; if ($cnt -gt 0) { & $add 'medium' 'updates' "$cnt bản cập nhật chưa cài" '' } } catch {}
  if (Get-PendingReboot) { & $add 'low' 'reboot_required' 'Cần khởi động lại để hoàn tất cập nhật' '' }
  $weights = @{ high = 25; medium = 10; low = 3 }
  $penalty = ($findings | ForEach-Object { $weights[$_.severity] } | Measure-Object -Sum).Sum
  $score = [math]::Max(0, 100 - [int]$penalty)
  $lines = @("Điểm bảo mật: $score/100")
  foreach ($f in $findings) { $lines += ("[{0}] {1}{2}" -f $f.severity.ToUpper(), $f.title, $(if ($f.detail) { " - $($f.detail)" } else { '' })) }
  New-Result 0 ($lines -join "`n") @{ score = $score; findings = @($findings) }
}
function Get-InstalledSoftwareCount {
  $n = 0
  foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    try { $n += (Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName }).Count } catch {}
  }
  return $n
}

function Act-DeepAudit {
  $findings = New-Object System.Collections.ArrayList
  $add = { param($sev, $fid, $title, $detail, $remediation, $fix = $null)
    [void]$findings.Add(@{ id = $fid; severity = $sev; category = 'security'; title = $title; detail = $detail; remediation = $remediation; fix = $fix; refs = @() }) }

  $os = $null; try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {}
  $caption = if ($os) { $os.Caption } else { 'Windows' }
  # 1. EOL Windows versions
  if ($caption -match 'Windows 7|Windows 8 |Windows Server 2008|Windows Server 2012(?!\sR2)|Windows XP|Vista') {
    & $add 'critical' 'os_eol' 'Phiên bản Windows đã hết hỗ trợ (EOL)' "$caption không còn nhận bản vá bảo mật." 'Nâng cấp lên phiên bản Windows còn được hỗ trợ.' $null
  }
  # 2. pending updates
  try {
    $cnt = (Act-UpdateCheck).result.count
    if ($cnt -gt 0) { & $add 'high' 'updates' "$cnt bản cập nhật chưa cài" "Có $cnt cập nhật đang chờ." 'Cài cập nhật. Bấm Khắc phục để agent tự cài.' @{ action = 'system.update_apply'; params = @{ security_only = $true }; label = 'Cài cập nhật bảo mật ngay' } }
  } catch {}
  # 3. SMBv1
  try { if ((Get-SmbServerConfiguration -ErrorAction Stop).EnableSMB1Protocol) { & $add 'high' 'smb1' 'SMBv1 đang bật' 'SMBv1 là giao thức lỗi thời, nhiều lỗ hổng (WannaCry/EternalBlue).' 'Tắt SMBv1. Bấm Khắc phục để agent tắt ngay.' @{ action = 'security.disable_smb1'; params = @{}; label = 'Tắt SMBv1' } } } catch {}
  # 4. Guest account
  try { $g = Get-LocalUser -Name 'Guest' -ErrorAction Stop; if ($g.Enabled) { & $add 'high' 'guest_on' 'Tài khoản Guest đang bật' 'Guest cho phép truy cập ẩn danh.' 'Tắt tài khoản Guest. Bấm Khắc phục để agent tắt.' @{ action = 'security.disable_guest'; params = @{}; label = 'Tắt Guest' } } } catch {}
  # 5. Defender
  try { $av = Get-MpComputerStatus -ErrorAction Stop; if (-not $av.RealTimeProtectionEnabled) { & $add 'high' 'defender_off' 'Windows Defender real-time đang tắt' 'Bảo vệ thời gian thực bị tắt.' 'Bật lại Defender real-time: Set-MpPreference -DisableRealtimeMonitoring $false' $null } } catch {}
  # 6. RDP + NLA
  try {
    $rdp = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction Stop).fDenyTSConnections
    if ($rdp -eq 0) {
      $nla = 1; try { $nla = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -ErrorAction Stop).UserAuthentication } catch {}
      $sev = if ($nla -eq 0) { 'high' } else { 'medium' }
      & $add $sev 'rdp_on' ('RDP đang bật' + $(if ($nla -eq 0) { ' và tắt NLA' } else { '' })) 'Cổng 3389 mở ra ngoài là mục tiêu dò mật khẩu phổ biến.' 'Giới hạn RDP bằng firewall/VPN; bật Network Level Authentication (NLA).' $null
    }
  } catch {}
  # 7. firewall off
  try { if ((Get-NetFirewallProfile | Where-Object { -not $_.Enabled })) { & $add 'medium' 'firewall_off' 'Có profile firewall đang tắt' 'Một hoặc nhiều profile Windows Firewall đang tắt.' 'Bật Windows Firewall cho mọi profile: Set-NetFirewallProfile -All -Enabled True' $null } } catch {}
  # 8. exposed risky ports
  $risky = @{ '3389' = 'RDP'; '445' = 'SMB'; '1433' = 'MSSQL'; '3306' = 'MySQL'; '5985' = 'WinRM-HTTP' }
  foreach ($c in (Get-ListeningPorts)) {
    $pnum = ($c.local -split ':')[-1]
    if ($risky.ContainsKey($pnum) -and ($c.local -match '^0\.0\.0\.0|^\[::\]|^::')) {
      & $add 'medium' "exposed_$pnum" "$($risky[$pnum]) lắng nghe trên mọi địa chỉ (cổng $pnum)" "Dịch vụ $($risky[$pnum]) mở ra ngoài." 'Giới hạn bằng Windows Firewall hoặc chỉ bind nội bộ.' $null
    }
  }
  # 9. pending reboot
  if (Get-PendingReboot) { & $add 'low' 'reboot_required' 'Cần khởi động lại' 'Có cập nhật chờ reboot.' 'Lên lịch khởi động lại.' $null }

  $weights = @{ critical = 40; high = 25; medium = 10; low = 3 }
  $penalty = ($findings | ForEach-Object { $weights[$_.severity] } | Measure-Object -Sum).Sum
  $score = [math]::Max(0, 100 - [int]$penalty)
  $counts = @{ critical = 0; high = 0; medium = 0; low = 0 }
  foreach ($f in $findings) { $counts[$f.severity]++ }
  $bios = $null; try { $b = Get-CimInstance Win32_BIOS -ErrorAction Stop; $bios = @{ version = $b.SMBIOSBIOSVersion; vendor = $b.Manufacturer; date = [string]$b.ReleaseDate } } catch {}
  $inventory = @{ os = $caption; os_id = 'windows'; version_id = if ($os) { $os.Version } else { '' }; kernel = if ($os) { $os.Version } else { '' }
    arch = $env:PROCESSOR_ARCHITECTURE; packages_count = (Get-InstalledSoftwareCount); bios = $bios; firewall = 'windows-firewall' }
  $lines = @("Điểm an toàn: $score/100 (nghiêm trọng $($counts.critical), cao $($counts.high), trung bình $($counts.medium), thấp $($counts.low))")
  foreach ($f in $findings) { $lines += "[$($f.severity.ToUpper())] $($f.title)" }
  New-Result 0 ($lines -join "`n") @{ score = $score; counts = $counts; findings = @($findings); inventory = $inventory }
}

function Act-DisableSmb1 {
  try {
    Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force -ErrorAction Stop
    try { Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -NoRestart -ErrorAction SilentlyContinue | Out-Null } catch {}
    New-Result 0 'Đã tắt SMBv1.' @{ disabled = $true }
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-DisableGuest {
  try { Disable-LocalUser -Name 'Guest' -ErrorAction Stop; New-Result 0 'Đã tắt tài khoản Guest.' @{ disabled = $true } }
  catch { New-Result 1 $_.Exception.Message }
}

function Act-Shell { param($p, $cfg)
  try {
    $global:LASTEXITCODE = 0
    $out = (& powershell.exe -NoProfile -NonInteractive -Command $p.command 2>&1 | Out-String)
    New-Result $global:LASTEXITCODE $out
  } catch { New-Result 1 $_.Exception.Message }
}

# ----------------------------------------------------------------------------- network scan (mirrors the Linux agent's net.scan)
$script:OUI = @{
  '000C29'='VMware';'005056'='VMware';'000569'='VMware';'001C14'='VMware';
  '080027'='VirtualBox';'525400'='QEMU/KVM';'00163E'='Xen';'001A4A'='Qumranet/KVM';
  'B827EB'='Raspberry Pi';'DCA632'='Raspberry Pi';'E45F01'='Raspberry Pi';'28CDC1'='Raspberry Pi';
  'F0F61C'='Apple';'A4B197'='Apple';'001451'='Apple';'3C0754'='Apple';'ACBC32'='Apple';'001B63'='Apple';'D0817A'='Apple';'F80377'='Apple';
  '0050BA'='D-Link';'001E58'='D-Link';'001346'='D-Link';
  '0018E7'='Cameo/Netgear';'000FB5'='Netgear';'20E52A'='Netgear';'A040A0'='Netgear';
  '000C42'='MikroTik';'4C5E0C'='MikroTik';'6C3B6B'='MikroTik';'E48D8C'='MikroTik';
  '0015FF'='Cisco-Linksys';'00000C'='Cisco';'001A2F'='Cisco';'0023EB'='Cisco';'F8721C'='Cisco';'00D0F6'='Cisco';'7079B3'='Cisco';'008030'='Cisco';
  'FCECDA'='Ubiquiti';'24A43C'='Ubiquiti';'788A20'='Ubiquiti';'F09FC2'='Ubiquiti';'68D79A'='Ubiquiti';
  '000374'='Huawei';'48435A'='Huawei';'D4616D'='Huawei';'E0247F'='Huawei';
  '001D0F'='TP-Link';'50C7BF'='TP-Link';'C46E1F'='TP-Link';'A42BB0'='TP-Link';
  '001517'='Intel';'3C9709'='Intel';'A0A8CD'='Intel';'A4BF01'='Intel';
  '001A11'='Google';'F4F5E8'='Google';'D83134'='Roku';'B0A737'='Roku';
  'F4CE46'='HP';'3024A9'='HP';'001708'='HP';'009C02'='HP';
  'F8BC12'='Dell';'B083FE'='Dell';'001EC9'='Dell';'D067E5'='Dell';
  '002128'='Zebra/printer';'001BA9'='Brother';'3C2AF4'='Brother';'0080A3'='Lantronix';
  '001599'='Samsung';'5CF9DD'='Samsung';'E8508B'='Samsung'
}
$script:PORT_SERVICE = @{
  22='ssh';23='telnet';25='smtp';53='dns';80='http';110='pop3';111='rpcbind';135='msrpc';139='netbios';143='imap';161='snmp';389='ldap';443='https';445='smb';515='printer';548='afp';554='rtsp';631='ipp';1433='mssql';1521='oracle';2049='nfs';3000='http-alt';3306='mysql';3389='rdp';5000='upnp';5432='postgres';5900='vnc';6379='redis';8006='proxmox';8080='http-alt';8443='https-alt';9100='jetdirect';9200='elasticsearch';27017='mongodb';62078='apple-sync'
}
$script:DEFAULT_PORTS = @(22,23,53,80,135,139,443,445,161,515,631,3306,3389,5432,8080,8443,9100,62078)
$script:DEEP_PORTS = @($script:PORT_SERVICE.Keys | Sort-Object)

function Get-MacVendor($mac) {
  if (-not $mac) { return $null }
  $key = ($mac -replace '[:-]', '').ToUpper()
  if ($key.Length -lt 6) { return $null }
  $key = $key.Substring(0, 6)
  if ($script:OUI.ContainsKey($key)) { return $script:OUI[$key] } else { return $null }
}

function Get-DeviceType($ports, $vendor, $hostname, $isGw) {
  $ps = @{}; foreach ($x in $ports) { $ps[[int]$x] = $true }
  $v = ([string]$vendor).ToLower()
  $hn = ([string]$hostname).ToLower()
  if ($isGw) { return 'gateway/router' }
  if ($ps.ContainsKey(9100) -or $ps.ContainsKey(515) -or $ps.ContainsKey(631) -or $v -match 'printer|brother|zebra') { return 'printer' }
  if ($ps.ContainsKey(62078) -or $hn -match 'iphone|ipad') { return 'mobile/iOS' }
  if (($v -match 'cisco|mikrotik|ubiquiti|tp-link|netgear|d-link|huawei') -and ($ps.ContainsKey(161) -or $ps.ContainsKey(23) -or $ps.ContainsKey(80))) { return 'network device' }
  if ($ps.ContainsKey(3389) -or $ps.ContainsKey(135) -or ($ps.ContainsKey(445) -and $ps.ContainsKey(139))) { return 'Windows host' }
  if ($v -match 'vmware|virtualbox|qemu|xen|kvm') { return 'virtual machine' }
  if ($v -match 'raspberry') { return 'Raspberry Pi' }
  if ($v -match 'apple') { return 'Apple device' }
  if ($ps.ContainsKey(22)) { return 'Linux/Unix host' }
  if ($ps.ContainsKey(80) -or $ps.ContainsKey(443)) { return 'web/appliance' }
  return 'unknown'
}

# Byte-level math only: PowerShell -shl on a [uint32] like (192 -shl 24) overflows Int32 and
# the subsequent [uint32] cast of the negative result THROWS, so the old shift math silently
# failed for any 192.168/172.x address. BitConverter + per-byte masks avoid that entirely.
function ConvertTo-NetworkCidr($cidr) {
  try {
    $parts = ([string]$cidr).Split('/')
    if ($parts.Count -ne 2) { return $null }
    $pfx = [int]$parts[1]
    if ($pfx -lt 0 -or $pfx -gt 32) { return $null }
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$ip)) { return $null }
    $b = $ip.GetAddressBytes()
    if ($b.Length -ne 4) { return $null }
    for ($i = 0; $i -lt 4; $i++) {
      $bits = [Math]::Max(0, [Math]::Min(8, $pfx - ($i * 8)))
      $mask = if ($bits -eq 0) { 0 } else { (0xFF -shl (8 - $bits)) -band 0xFF }
      $b[$i] = [byte]($b[$i] -band $mask)
    }
    return ('{0}.{1}.{2}.{3}/{4}' -f $b[0], $b[1], $b[2], $b[3], $pfx)
  } catch { return $null }
}

function Get-HostsInCidr($cidr, $cap) {
  $norm = ConvertTo-NetworkCidr $cidr
  if (-not $norm) { return @() }
  $parts = $norm.Split('/'); $pfx = [int]$parts[1]
  $ip = $null
  if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$ip)) { return @() }
  $nb = $ip.GetAddressBytes(); [array]::Reverse($nb)
  [uint32]$net = [System.BitConverter]::ToUInt32($nb, 0)
  [uint64]$size = [uint64][math]::Pow(2, 32 - $pfx)
  if ($pfx -le 30) { [uint64]$startOff = 1; [uint64]$count = $size - 2 } else { [uint64]$startOff = 0; [uint64]$count = $size }
  if ($count -gt [uint64]$cap) { return @() }
  $list = New-Object System.Collections.ArrayList
  for ([uint64]$i = 0; $i -lt $count; $i++) {
    [uint32]$a = [uint32]([uint64]$net + $startOff + $i)
    $ab = [System.BitConverter]::GetBytes($a); [array]::Reverse($ab)
    [void]$list.Add(('{0}.{1}.{2}.{3}' -f $ab[0], $ab[1], $ab[2], $ab[3]))
  }
  return $list
}

function Get-LocalSubnets {
  $out = New-Object System.Collections.ArrayList
  try {
    $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixLength -lt 32 }
    foreach ($a in $addrs) {
      $net = ConvertTo-NetworkCidr "$($a.IPAddress)/$($a.PrefixLength)"
      if (-not $net) { continue }
      $alias = [string]$a.InterfaceAlias
      $vlan = $null
      $m = [regex]::Match($alias, '(?:vlan|\.)(\d{1,4})\b', 'IgnoreCase')
      if ($m.Success) { $vlan = $m.Groups[1].Value }
      [void]$out.Add(@{ cidr = $net; vlan = $vlan; iface = $alias; ifIndex = [int]$a.InterfaceIndex })
    }
  } catch {}
  return $out
}

function Get-GatewayMap {
  $byIndex = @{}; $ips = @{}
  try {
    Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | ForEach-Object {
      if ($_.NextHop -and $_.NextHop -ne '0.0.0.0') { $byIndex[[int]$_.ifIndex] = [string]$_.NextHop; $ips[[string]$_.NextHop] = $true }
    }
  } catch {}
  return @{ byIndex = $byIndex; ips = $ips }
}

function Get-NeighborMap {
  $macs = @{}
  try {
    Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.LinkLayerAddress -and @('Reachable','Stale','Permanent','Delay','Probe') -contains ([string]$_.State) } | ForEach-Object {
      $ip = [string]$_.IPAddress
      $mac = (([string]$_.LinkLayerAddress).ToLower() -replace '-', ':')
      if ($mac -and $mac -ne '00:00:00:00:00:00' -and $mac -notmatch '^(ff:){5}ff$' -and -not $macs.ContainsKey($ip)) { $macs[$ip] = $mac }
    }
  } catch {}
  if ($macs.Count -eq 0) {
    try {
      & arp.exe -a 2>$null | ForEach-Object {
        $m = [regex]::Match($_, '(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})')
        if ($m.Success) {
          $ip = $m.Groups[1].Value; $mac = ($m.Groups[2].Value.ToLower() -replace '-', ':')
          if ($mac -ne '00:00:00:00:00:00' -and -not $macs.ContainsKey($ip)) { $macs[$ip] = $mac }
        }
      }
    } catch {}
  }
  return $macs
}

function Resolve-ReverseDns($ip) {
  try { $n = [System.Net.Dns]::GetHostEntry($ip).HostName; if ($n -and $n -ne $ip) { return $n } } catch {}
  return $null
}

function Invoke-PingSweep($ips, $timeoutMs) {
  $alive = @{}
  $items = New-Object System.Collections.ArrayList
  foreach ($ip in $ips) {
    try { $p = New-Object System.Net.NetworkInformation.Ping; [void]$items.Add([pscustomobject]@{ ip = $ip; task = $p.SendPingAsync($ip, [int]$timeoutMs); ping = $p }) } catch {}
  }
  Start-Sleep -Milliseconds ([int]$timeoutMs + 500)
  foreach ($it in $items) {
    try { if ($it.task.IsCompleted -and -not $it.task.IsFaulted -and ([string]$it.task.Result.Status) -eq 'Success') { $alive[$it.ip] = $true } } catch {}
    try { $it.ping.Dispose() } catch {}
  }
  return $alive
}

function Test-TcpPortsBulk($ips, $ports, $timeoutMs) {
  $res = @{}
  $socks = New-Object System.Collections.ArrayList
  foreach ($ip in $ips) {
    foreach ($pt in $ports) {
      try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect($ip, [int]$pt, $null, $null)
        [void]$socks.Add([pscustomobject]@{ ip = $ip; port = [int]$pt; client = $c; iar = $iar })
      } catch {}
    }
  }
  Start-Sleep -Milliseconds ([int]$timeoutMs)
  foreach ($s in $socks) {
    $ok = $false
    try { if ($s.iar.IsCompleted) { $s.client.EndConnect($s.iar); if ($s.client.Connected) { $ok = $true } } } catch {}
    try { $s.client.Close() } catch {}
    if ($ok) {
      if (-not $res.ContainsKey($s.ip)) { $res[$s.ip] = New-Object System.Collections.ArrayList }
      [void]$res[$s.ip].Add($s.port)
    }
  }
  return $res
}

function Act-NetScan {
  param($p, $cfg)
  $subnets = New-Object System.Collections.ArrayList
  if ($p.ContainsKey('targets') -and $p.targets) {
    foreach ($part in ($p.targets -split '[,\s]+')) {
      if (-not $part) { continue }
      $cidr = if ($part -like '*/*') { $part } else { "$part/24" }
      $net = ConvertTo-NetworkCidr $cidr
      if ($net) { [void]$subnets.Add(@{ cidr = $net; vlan = $null; iface = $null; ifIndex = $null }) }
    }
  } else {
    $seen = @{}
    foreach ($s in (Get-LocalSubnets)) { if (-not $seen.ContainsKey($s.cidr)) { $seen[$s.cidr] = $true; [void]$subnets.Add($s) } }
  }
  if ($subnets.Count -eq 0) { return (New-Result 1 'Khong phat hien duoc subnet nao de quet' $null) }

  $gw = Get-GatewayMap
  $neigh = Get-NeighborMap
  $ports = if ($p.deep) { $script:DEEP_PORTS } else { $script:DEFAULT_PORTS }
  if ($p.ContainsKey('ports') -and $p.ports) {
    $pl = @(); foreach ($x in ($p.ports -split '[,\s]+')) { if ($x) { $n = 0; if ([int]::TryParse([string]$x, [ref]$n)) { $pl += $n } } }
    if ($pl.Count -gt 0) { $ports = @($pl | Sort-Object -Unique) }
  }
  $cap = 1024
  if ($cfg -and $cfg.PSObject.Properties['scan_host_cap']) { try { $cap = [int]$cfg.scan_host_cap } catch {} }
  $scannerIp = Get-PrimaryIp

  $subnetReport = New-Object System.Collections.ArrayList
  $devices = New-Object System.Collections.ArrayList
  foreach ($sn in $subnets) {
    $targets = Get-HostsInCidr $sn.cidr $cap
    if (-not $targets -or $targets.Count -eq 0) {
      [void]$subnetReport.Add(@{ cidr = $sn.cidr; vlan = $sn.vlan; iface = $sn.iface; gateway_ip = $null; hosts_scanned = 0; note = 'subnet qua lon, bo qua (can chi dinh targets)' })
      continue
    }
    $gwIp = $null
    if ($null -ne $sn.ifIndex -and $gw.byIndex.ContainsKey([int]$sn.ifIndex)) { $gwIp = $gw.byIndex[[int]$sn.ifIndex] }
    $alive = Invoke-PingSweep $targets 700
    foreach ($ip in $targets) { if ($neigh.ContainsKey($ip)) { $alive[$ip] = $true } }
    $aliveIps = @($alive.Keys)
    if ($aliveIps.Count -gt 256) { $aliveIps = @($aliveIps[0..255]) }
    $portMap = Test-TcpPortsBulk $aliveIps $ports 700
    $neigh2 = Get-NeighborMap
    $sorted = @($aliveIps | Sort-Object { $q = $_.Split('.'); ([uint32]$q[0] -shl 24) -bor ([uint32]$q[1] -shl 16) -bor ([uint32]$q[2] -shl 8) -bor [uint32]$q[3] })
    foreach ($ip in $sorted) {
      $openPorts = @(); if ($portMap.ContainsKey($ip)) { $openPorts = @($portMap[$ip] | Sort-Object) }
      $mac = if ($neigh2.ContainsKey($ip)) { $neigh2[$ip] } elseif ($neigh.ContainsKey($ip)) { $neigh[$ip] } else { $null }
      $vendor = Get-MacVendor $mac
      $hostname = Resolve-ReverseDns $ip
      $isGw = ($gw.ips.ContainsKey($ip)) -or ($ip -eq $gwIp)
      $op = New-Object System.Collections.ArrayList
      foreach ($po in $openPorts) { [void]$op.Add(@{ port = [int]$po; proto = 'tcp'; service = $script:PORT_SERVICE[[int]$po] }) }
      [void]$devices.Add(@{
        ip = $ip; mac = $mac; vendor = $vendor; hostname = $hostname;
        subnet = $sn.cidr; vlan = $sn.vlan; open_ports = $op;
        device_type = (Get-DeviceType $openPorts $vendor $hostname $isGw);
        is_gateway = [bool]$isGw; snmp = $null
      })
    }
    [void]$subnetReport.Add(@{ cidr = $sn.cidr; vlan = $sn.vlan; iface = $sn.iface; gateway_ip = $gwIp; hosts_scanned = $targets.Count; devices_found = $aliveIps.Count })
  }

  $result = @{ subnets = $subnetReport; devices = $devices; scanner = @{ ip = $scannerIp; hostname = $env:COMPUTERNAME } }
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add("Quet $($subnetReport.Count) subnet, tim thay $($devices.Count) thiet bi:")
  foreach ($sr in $subnetReport) {
    $dc = if ($sr.ContainsKey('devices_found')) { $sr.devices_found } else { 0 }
    $vl = if ($sr.vlan) { " (VLAN $($sr.vlan))" } else { '' }
    [void]$lines.Add("  $($sr.cidr)$vl - $dc thiet bi")
  }
  foreach ($d in $devices) {
    $lbl = if ($d.hostname) { $d.hostname } elseif ($d.vendor) { $d.vendor } else { '' }
    [void]$lines.Add(("  {0,-15} {1,-17} {2,-14} {3}" -f $d.ip, $(if ($d.mac) { $d.mac } else { '-' }), $d.device_type, $lbl))
  }
  return (New-Result 0 ($lines -join "`n") $result)
}

# ----------------------------------------------------------------------------- remote agent install (mirrors the Linux agent's net.remote_install)
# Note: $host is a PowerShell automatic variable (the host object) — always use $targetHost here.
function Invoke-SshExec {
  param($targetHost, $user, $port, $key, $password, $remoteCmd)
  $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if (-not $ssh) {
    return (New-Result 1 "Khong tim thay ssh.exe tren may agent Windows. Cai 'OpenSSH Client' (Settings > Apps > Optional Features) roi thu lai, hoac dung mot agent Linux de cai qua SSH." $null)
  }
  $opts = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=12', '-o', 'NumberOfPasswordPrompts=1', '-p', [string]$port)
  $keyfile = $null
  try {
    if ($key) {
      $keyfile = Join-Path $env:TEMP ("infra_rk_" + [Guid]::NewGuid().ToString('N'))
      $txt = if ($key.EndsWith("`n")) { $key } else { $key + "`n" }
      [System.IO.File]::WriteAllText($keyfile, $txt, (New-Object System.Text.UTF8Encoding($false)))
      try { & icacls.exe $keyfile /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null } catch {}
      $sshArgs = @('-i', $keyfile, '-o', 'BatchMode=yes') + $opts + @("$user@$targetHost", $remoteCmd)
    } elseif ($password) {
      return (New-Result 1 "Cai qua SSH bang mat khau khong duoc ho tro tu agent Windows (thieu sshpass). Hay dung SSH key, dung mot agent Linux, hoac cai thiet bi Windows qua WinRM." $null)
    } else {
      $sshArgs = @('-o', 'BatchMode=yes') + $opts + @("$user@$targetHost", $remoteCmd)
    }
    $out = & $ssh.Path @sshArgs 2>&1 | Out-String
    return (New-Result $LASTEXITCODE $out $null)
  } finally {
    if ($keyfile -and (Test-Path $keyfile)) { Remove-Item $keyfile -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-WinrmExec {
  param($targetHost, $user, $password, $scriptBlock, $argList)
  if (-not $password) {
    return (New-Result 1 "Cai thiet bi Windows tu xa qua WinRM can mat khau cho tai khoan '$user'. Hay nhap mat khau Administrator cua may dich." $null)
  }
  $secpw = ConvertTo-SecureString $password -AsPlainText -Force
  $cred = New-Object System.Management.Automation.PSCredential($user, $secpw)
  try {
    $cur = $null
    try { $cur = (Get-Item WSMan:\localhost\Client\TrustedHosts -ErrorAction SilentlyContinue).Value } catch {}
    $known = if ($cur) { @($cur -split ',' | ForEach-Object { $_.Trim() }) } else { @() }
    if ($cur -ne '*' -and $known -notcontains $targetHost) {
      try { Set-Item WSMan:\localhost\Client\TrustedHosts -Value $targetHost -Concatenate -Force -ErrorAction SilentlyContinue } catch {}
    }
    $out = Invoke-Command -ComputerName $targetHost -Credential $cred -ScriptBlock $scriptBlock -ArgumentList $argList -ErrorAction Stop 2>&1 | Out-String
    return (New-Result 0 $out $null)
  } catch {
    return (New-Result 1 ("WinRM toi $targetHost that bai: " + $_.Exception.Message + ". Dam bao WinRM da bat tren may dich (chay 'winrm quickconfig') va tai khoan co quyen Administrator.") $null)
  }
}

function Act-NetRemoteInstall {
  param($p, $cfg)
  $targetHost = $p['host']
  $osName = if ($p.ContainsKey('os') -and $p['os']) { $p['os'] } else { 'linux' }
  $url = ([string]$p['server_url']).TrimEnd('/')
  $token = $p['enroll_token']
  $user = if ($p.ContainsKey('ssh_user') -and $p['ssh_user']) { $p['ssh_user'] } else { 'root' }
  $port = if ($p.ContainsKey('ssh_port') -and $p['ssh_port']) { [int]$p['ssh_port'] } else { 22 }
  $key = if ($p.ContainsKey('ssh_key')) { $p['ssh_key'] } else { $null }
  $password = if ($p.ContainsKey('ssh_password')) { $p['ssh_password'] } else { $null }
  if ($osName -eq 'windows') {
    $sb = {
      param($u, $t)
      try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
      Invoke-WebRequest -Uri "$u/agent/install.ps1" -UseBasicParsing | Select-Object -ExpandProperty Content | Invoke-Expression
      Install-InfraAgent -Server $u -Token $t
    }
    $r = Invoke-WinrmExec $targetHost $user $password $sb @($url, $token)
  } else {
    $sudo = if ($user -eq 'root') { '' } else { 'sudo -n ' }
    $remote = "curl -fsSL $url/agent/install.sh | ${sudo}bash -s -- --server $url --token $token"
    $r = Invoke-SshExec $targetHost $user $port $key $password $remote
  }
  $meta = @{ host = $targetHost; os = $osName; installed = ($r.code -eq 0) }
  return (New-Result $r.code $r.output $meta)
}

function Act-NetRemoteUninstall {
  param($p, $cfg)
  $targetHost = $p['host']
  $osName = if ($p.ContainsKey('os') -and $p['os']) { $p['os'] } else { 'linux' }
  $url = ([string]$p['server_url']).TrimEnd('/')
  $user = if ($p.ContainsKey('ssh_user') -and $p['ssh_user']) { $p['ssh_user'] } else { 'root' }
  $port = if ($p.ContainsKey('ssh_port') -and $p['ssh_port']) { [int]$p['ssh_port'] } else { 22 }
  $key = if ($p.ContainsKey('ssh_key')) { $p['ssh_key'] } else { $null }
  $password = if ($p.ContainsKey('ssh_password')) { $p['ssh_password'] } else { $null }
  $purge = ($p.ContainsKey('purge') -and $p['purge'])
  if ($osName -eq 'windows') {
    $sb = {
      param($u, $pg)
      try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
      Invoke-WebRequest -Uri "$u/agent/install.ps1" -UseBasicParsing | Select-Object -ExpandProperty Content | Invoke-Expression
      if ($pg) { Uninstall-InfraAgent -Purge } else { Uninstall-InfraAgent }
    }
    $r = Invoke-WinrmExec $targetHost $user $password $sb @($url, [bool]$purge)
  } else {
    $sudo = if ($user -eq 'root') { '' } else { 'sudo -n ' }
    $flag = if ($purge) { ' --purge' } else { ' --uninstall' }
    $remote = "curl -fsSL $url/agent/install.sh | ${sudo}bash -s --$flag"
    $r = Invoke-SshExec $targetHost $user $port $key $password $remote
  }
  $meta = @{ host = $targetHost; os = $osName; uninstalled = ($r.code -eq 0) }
  return (New-Result $r.code $r.output $meta)
}

$script:HANDLERS = @{
  'system.info'              = { param($p, $c) Act-SystemInfo }
  'system.disk_usage'        = { param($p, $c) Act-DiskUsage }
  'system.processes'         = { param($p, $c) Act-Processes $p }
  'system.users'             = { param($p, $c) Act-Users }
  'system.update_check'      = { param($p, $c) Act-UpdateCheck }
  'system.update_apply'      = { param($p, $c) Act-UpdateApply $p }
  'system.reboot'            = { param($p, $c) Act-Reboot $p }
  'service.list'             = { param($p, $c) Act-ServiceList }
  'service.status'           = { param($p, $c) Get-SvcOut 'status'  $p.name }
  'service.restart'          = { param($p, $c) Get-SvcOut 'restart' $p.name }
  'service.start'            = { param($p, $c) Get-SvcOut 'start'   $p.name }
  'service.stop'             = { param($p, $c) Get-SvcOut 'stop'    $p.name }
  'logs.tail'                = { param($p, $c) Act-LogsTail $p }
  'security.audit'           = { param($p, $c) Act-SecurityAudit }
  'security.listening_ports' = { param($p, $c) Act-ListeningPorts }
  'security.failed_logins'   = { param($p, $c) Act-FailedLogins $p }
  'security.firewall_status' = { param($p, $c) Act-FirewallStatus }
  'security.firewall_allow'  = { param($p, $c) Act-FirewallRule $p 'allow' }
  'security.firewall_deny'   = { param($p, $c) Act-FirewallRule $p 'deny' }
  'security.block_ip'        = { param($p, $c) Act-BlockIp $p }
  'security.deep_audit'      = { param($p, $c) Act-DeepAudit }
  'security.disable_smb1'    = { param($p, $c) Act-DisableSmb1 }
  'security.disable_guest'   = { param($p, $c) Act-DisableGuest }
  'shell.exec'               = { param($p, $c) Act-Shell $p $c }
  'net.scan'                 = { param($p, $c) Act-NetScan $p $c }
  'net.remote_install'       = { param($p, $c) Act-NetRemoteInstall $p $c }
  'net.remote_uninstall'     = { param($p, $c) Act-NetRemoteUninstall $p $c }
}

function Invoke-Task {
  param($Task, $Cfg)
  try {
    $params = Resolve-Params $Task.action $Task.params $Cfg
    $h = $script:HANDLERS[$Task.action]
    if (-not $h) { throw [Rejected]::new("action not implemented on Windows agent: $($Task.action)") }
    $r = & $h $params $Cfg
    $status = if ($r.code -eq 0) { 'succeeded' } else { 'failed' }
    $body = @{ status = $status; exit_code = [int]$r.code; output = (Clip $r.output) }
    if ($null -ne $r.result) { $body.result = $r.result }
    return $body
  } catch [Rejected] {
    return @{ status = 'rejected'; exit_code = $null; output = "Agent từ chối: $($_.Exception.Message)" }
  } catch {
    return @{ status = 'failed'; exit_code = $null; output = "Lỗi agent: $($_.Exception.Message)" }
  }
}

# ----------------------------------------------------------------------------- loops
function Invoke-Enroll {
  $cfg = @{ server_url = $Server.TrimEnd('/') }
  if ($CaFile) { $cfg.ca_file = $CaFile }
  if (-not $cfg.server_url.StartsWith('https://') -and -not $InsecureHttp) { throw 'Refusing to enroll over plain HTTP. Use https:// or pass -InsecureHttp for lab setups.' }
  $cfgObj = [pscustomobject]$cfg
  $resp = Invoke-ApiJson $cfgObj 'POST' '/api/agent/enroll' @{
    token = $Token; version = $script:VERSION; platform = 'windows'
    capabilities = @($script:ACTIONS.Keys); facts = (Get-Facts); metrics = (Get-Metrics)
  }
  $cfg.server_id = $resp.server_id; $cfg.agent_token = $resp.agent_token; $cfg.allow_shell = $false
  Save-Config $Config ([pscustomobject]$cfg)
  Write-Log "Enrolled as $($resp.server_id); config written to $Config"
}

function Invoke-Heartbeat { param($Cfg)
  $resp = Invoke-ApiJson $Cfg 'POST' '/api/agent/heartbeat' @{
    version = $script:VERSION; capabilities = @($script:ACTIONS.Keys); facts = (Get-Facts); metrics = (Get-Metrics)
  } $Cfg.agent_token
  foreach ($task in @($resp.tasks)) {
    Write-Log "task $($task.id): $($task.action)"
    $body = Invoke-Task $task $Cfg
    for ($i = 0; $i -lt 5; $i++) {
      try { Invoke-ApiJson $Cfg 'POST' "/api/agent/tasks/$($task.id)/result" $body $Cfg.agent_token | Out-Null; break }
      catch { Write-Log "result upload failed ($($_.Exception.Message)), retrying"; Start-Sleep -Seconds ([math]::Pow(2, $i)) }
    }
    Write-Log "task $($task.id): $($body.status)"
  }
  if ($resp.poll_interval) { return [int]$resp.poll_interval } else { return 10 }
}

function Invoke-Run { param([switch]$Once)
  $cfg = Read-Config $Config
  Write-Log "infra-agent-win $($script:VERSION) -> $($cfg.server_url) (server $($cfg.server_id), allow_shell=$([bool]$cfg.allow_shell))"
  $backoff = 5
  while ($true) {
    try { $interval = Invoke-Heartbeat $cfg; $backoff = 5 }
    catch { Write-Log "heartbeat failed: $($_.Exception.Message)"; if ($Once) { exit 1 }; Start-Sleep -Seconds $backoff; $backoff = [math]::Min($backoff * 2, 300); continue }
    if ($Once) { return }
    Start-Sleep -Seconds ([math]::Max(1, [math]::Min([int]$interval, 60)))
  }
}

switch ($Command) {
  'enroll'  { Invoke-Enroll }
  'run'     { Invoke-Run }
  'once'    { Invoke-Run -Once }
  'version' { Write-Output $script:VERSION }
  default   { Write-Output 'Usage: infra_agent.ps1 -Command enroll|run|once -Server URL -Token TOKEN' }
}
