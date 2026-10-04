# Kills ONLY the throwaway Chrome profiles used by the selftest -- never the user's own Chrome.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'st-chrome|pb-chrome' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
