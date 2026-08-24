$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$worker = Join-Path $root 'core\reminder_worker.mjs'
$node = (Get-Command node.exe).Source
if (-not (Test-Path -LiteralPath $worker)) { throw '找不到提醒 worker。' }

$taskName = 'CareerPilot Deadline Reminder'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$worker`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
$trigger.RepetitionInterval = New-TimeSpan -Minutes 15
$trigger.RepetitionDuration = New-TimeSpan -Days 3650
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'CareerPilot 截止日期提醒；只读取未完成申请截止事项。' -Force | Out-Null
Write-Output "已安装：$taskName"
Write-Output '每 15 分钟检查一次；电脑完全关机时无法发送，重新开机后会检查尚未发送的提醒。'
