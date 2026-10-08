$secureKey = Read-Host 'Paste your rotated NVIDIA API key, then press Enter' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  [Environment]::SetEnvironmentVariable('NVIDIA_API_KEY', $plainKey, 'User')
  [Environment]::SetEnvironmentVariable('STUDYOS_AI_PROVIDER', 'nvidia', 'User')
  [Environment]::SetEnvironmentVariable('STUDYOS_AI_CHAT_MODEL', 'nvidia/nemotron-3-super-120b-a12b', 'User')
  [Environment]::SetEnvironmentVariable('STUDYOS_AI_EMBEDDING_MODEL', 'nvidia/nemotron-3-embed-1b', 'User')
  Write-Host 'NVIDIA provider configured locally. Close and reopen PowerShell, then run .\run-backend.ps1.' -ForegroundColor Green
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $plainKey = $null
}
