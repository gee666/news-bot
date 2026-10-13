param(
  [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Distro = 'Debian',
  [ValidatePattern('^[a-z_][a-z0-9_-]*$')][string]$LinuxUser = 'oira666',
  [ValidatePattern('^/[^"\r\n]+$')][string]$ProjectPath = '/var/www/workshop/oira666/news-bot',
  [Parameter(Mandatory=$true)][ValidatePattern('^/[^"\r\n]+$')][string]$NodeBin,
  [ValidatePattern('^[A-Za-z0-9_.-]{1,64}$')][string]$TaskName = 'NewsBot-WSL',
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$nodeDirectory = $NodeBin.Substring(0, $NodeBin.LastIndexOf('/'))
$linuxPath = "$nodeDirectory`:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
function Literal([string]$value) { return "'" + $value.Replace("'", "''") + "'" }
# PowerShell supplies real redirected handles to headless wsl.exe and records actionable task failures.
$runner = @'
$ErrorActionPreference='Continue'
function Describe([string]$message) {
  $task=Get-ScheduledTask -TaskName {TASK}
  $task.Description=$message
  Set-ScheduledTask -InputObject $task | Out-Null
}
$rootOutput = & {WSL} -d {DISTRO} -u root -- service docker start 2>&1 | Out-String
if($LASTEXITCODE -ne 0) {
  Describe ('Docker startup failed: '+$rootOutput.Substring(0,[Math]::Min(700,$rootOutput.Length)))
  exit 1
}
Describe 'Docker started; foreground WSL watcher is active.'
$watchOutput = & {WSL} -d {DISTRO} -u {USER} -- env {PATH} bash {SCRIPT} --watch 2>&1 | Out-String
$result=$LASTEXITCODE
Describe ('WSL watcher stopped: '+$watchOutput.Substring(0,[Math]::Min(700,$watchOutput.Length)))
exit $result
'@
foreach($pair in @(@('{WSL}',$wsl),@('{DISTRO}',$Distro),@('{TASK}',$TaskName),@('{USER}',$LinuxUser),@('{PATH}',"PATH=$linuxPath"),@('{SCRIPT}',"$ProjectPath/scripts/start-wsl.sh"))) {
  $runner=$runner.Replace($pair[0],(Literal $pair[1]))
}
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($runner))
$powerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action=New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
  -Principal $principal -Settings $settings -Description 'Keep Docker and the foreground WSL news watcher running; retry failures.' -Force | Out-Null
if($StartNow) {Start-ScheduledTask -TaskName $TaskName}
Write-Output "Installed $TaskName. Keep Windows awake and arrange Windows model-service startup separately."
