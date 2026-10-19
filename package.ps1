# 배포용 HTML 패키지 만들기: docs 폴더의 화면 파일만 dist\exam-web.zip 으로 묶는다.
# 사용: PowerShell 에서  .\package.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out = Join-Path $root 'dist\exam-web.zip'
New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
if (Test-Path $out) { Remove-Item $out }
Compress-Archive -Path (Join-Path $root 'docs\*') -DestinationPath $out
Write-Host "만들었습니다: $out"
