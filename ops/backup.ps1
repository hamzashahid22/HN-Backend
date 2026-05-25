param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$StorageRoot,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$EncryptionPassword
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$dbDump = Join-Path $OutputDirectory "homenet-db-$timestamp.dump"
$mediaArchive = Join-Path $OutputDirectory "homenet-media-$timestamp.zip"
$encryptedDbDump = "$dbDump.gpg"
$encryptedMediaArchive = "$mediaArchive.gpg"

pg_dump $DatabaseUrl -Fc -f $dbDump
Compress-Archive -Path (Join-Path $StorageRoot "*") -DestinationPath $mediaArchive -Force

if (Get-Command gpg -ErrorAction SilentlyContinue) {
  gpg --batch --yes --pinentry-mode loopback --passphrase $EncryptionPassword --symmetric --cipher-algo AES256 --output $encryptedDbDump $dbDump
  gpg --batch --yes --pinentry-mode loopback --passphrase $EncryptionPassword --symmetric --cipher-algo AES256 --output $encryptedMediaArchive $mediaArchive
  Remove-Item -LiteralPath $dbDump -Force
  Remove-Item -LiteralPath $mediaArchive -Force
  Write-Host "Created $encryptedDbDump"
  Write-Host "Created $encryptedMediaArchive"
} else {
  Write-Warning "gpg is not installed; backup files were created but not encrypted."
  Write-Host "Created $dbDump"
  Write-Host "Created $mediaArchive"
}
