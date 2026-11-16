@echo off
rem Saves the Sterling Admin token outside this folder, in %USERPROFILE%\.sterling-admin\admin.env.
rem The token should have only "D1: Edit" and "Account Analytics: Read", for your one account.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = Join-Path $env:USERPROFILE '.sterling-admin'; New-Item -ItemType Directory -Force $dir | Out-Null;" ^
  "$acct = Read-Host 'Cloudflare account ID';" ^
  "if ($acct -notmatch '^[0-9a-f]{32}$') { Write-Host 'That is not an account ID (32 characters, 0-9 and a-f).'; exit 1 };" ^
  "$sec = Read-Host -AsSecureString 'Paste the admin token (nothing shows while you paste)';" ^
  "$tok = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim();" ^
  "if ($tok.Length -lt 30) { Write-Host 'That does not look like a token.'; exit 1 };" ^
  "Set-Content -Path (Join-Path $dir 'admin.env') -Encoding ascii -Value @('CF_ACCOUNT_ID=' + $acct, 'CF_D1_TOKEN=' + $tok, 'CF_API_TOKEN=' + $tok);" ^
  "Write-Host ''; Write-Host ('Saved to ' + (Join-Path $dir 'admin.env') + '. Sterling Admin now uses this token instead of your Wrangler login.')"
if errorlevel 1 (echo. & echo Nothing was saved. Copy this window to Claude.)
pause
