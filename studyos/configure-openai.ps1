$secureKey = Read-Host 'Paste your rotated OpenAI API key, then press Enter' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $plainKey, 'User')
  [Environment]::SetEnvironmentVariable('STUDYOS_AI_PROVIDER', 'openai', 'User')
  Write-Host 'Saved the provider settings to your Windows user environment.' -ForegroundColor Green
  Write-Host 'Close and reopen PowerShell, then run .\run-backend.ps1.'
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $plainKey = $null
}
