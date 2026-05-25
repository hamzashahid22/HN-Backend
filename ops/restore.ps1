param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$StorageRoot,
  [Parameter(Mandatory = $true)][string]$EncryptedDbDump,
  [Parameter(Mandatory = $true)][string]$EncryptedMediaArchive,
  [Parameter(Mandatory = $true)][string]$EncryptionPassword
)

$ErrorActionPreference = "Stop"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("homenet-restore-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
  $dbDump = Join-Path $work "homenet-db.dump"
  $mediaArchive = Join-Path $work "homenet-media.zip"

  gpg --batch --yes --pinentry-mode loopback --passphrase $EncryptionPassword --decrypt --output $dbDump $EncryptedDbDump
  gpg --batch --yes --pinentry-mode loopback --passphrase $EncryptionPassword --decrypt --output $mediaArchive $EncryptedMediaArchive

  pg_restore --clean --if-exists --no-owner --dbname $DatabaseUrl $dbDump

  New-Item -ItemType Directory -Force -Path $StorageRoot | Out-Null
  Expand-Archive -LiteralPath $mediaArchive -DestinationPath $StorageRoot -Force

  Write-Host "Restore completed."
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
