# 把当前页面和数据服务发布到 192.168.101.172。提交后的钩子会调用本脚本。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "$root\deploy\dikong_deploy")) {
  Write-Error "缺少部署密钥 deploy/dikong_deploy"
}

Write-Host "构建页面..."
pnpm build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$stage = Join-Path $env:TEMP "dikong-oa-release"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path "$stage\dist", "$stage\server", "$stage\deploy" | Out-Null
Copy-Item -Recurse "$root\dist\*" "$stage\dist"
Copy-Item "$root\server\local-server\server.mjs", "$root\server\local-server\db-api.mjs", "$root\server\local-server\mail-reminder.mjs", "$root\server\local-server\storage.mjs", "$root\server\local-server\package.json", "$root\server\local-server\package-lock.json" "$stage\server"
Copy-Item "$root\deploy\update.sh", "$root\deploy\nginx-dikong.conf", "$root\deploy\dikong-oa.service" "$stage\deploy"
Get-ChildItem "$stage\deploy" | ForEach-Object {
  $text = [IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n" -replace "`r", "`n"
  [IO.File]::WriteAllText($_.FullName, $text, (New-Object System.Text.UTF8Encoding $false))
}

$archive = Join-Path $env:TEMP "dikong-oa-release.tgz"
if (Test-Path $archive) { Remove-Item -Force $archive }
tar -czf $archive -C $stage .

$key = "$root\deploy\dikong_deploy"
scp -i $key -o StrictHostKeyChecking=accept-new -o BatchMode=yes $archive chen@192.168.101.172:/tmp/dikong-oa-release.tgz
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
ssh -i $key -o StrictHostKeyChecking=accept-new -o BatchMode=yes chen@192.168.101.172 "sudo -n /usr/local/sbin/dikong-deploy"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "已发布到 http://192.168.101.172/"
