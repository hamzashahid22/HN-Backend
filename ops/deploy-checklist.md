# Production Deploy Checklist

## Before First Deploy

- Copy `.env.production.example` to `.env` and replace every secret.
- Render `ops/livekit.yaml` with the same `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` used by the API.
- Place TLS files at `ops/certs/fullchain.pem` and `ops/certs/privkey.pem`, or replace Nginx with a managed TLS proxy.
- Keep only ports `80`, `443`, SSH, and LiveKit UDP media range open on the VPS firewall.
- Keep PostgreSQL, Redis, Kafka, and ClamAV unexposed.
- Create `/var/lib/homenet/storage` on the host if using a bind mount instead of the named volume.

## Deploy

```powershell
docker compose --env-file .env up -d --build
docker compose exec api npm run prisma:deploy
docker compose ps
```

## Verify

```powershell
curl.exe -f https://api.example.com/health
curl.exe -f https://api.example.com/ready
docker compose logs --tail=100 api
docker compose logs --tail=100 worker
```

## Backups

Run daily:

```powershell
.\ops\backup.ps1 `
  -DatabaseUrl $env:DATABASE_URL `
  -StorageRoot C:\homenet\storage `
  -OutputDirectory C:\homenet\backups `
  -EncryptionPassword $env:BACKUP_ENCRYPTION_PASSWORD
```

Copy encrypted `.gpg` outputs offsite.

## Restore Drill

Run monthly against a staging database and storage directory:

```powershell
.\ops\restore.ps1 `
  -DatabaseUrl $env:STAGING_DATABASE_URL `
  -StorageRoot C:\homenet\restore-storage `
  -EncryptedDbDump C:\homenet\backups\homenet-db-YYYYMMDD-HHMMSS.dump.gpg `
  -EncryptedMediaArchive C:\homenet\backups\homenet-media-YYYYMMDD-HHMMSS.zip.gpg `
  -EncryptionPassword $env:BACKUP_ENCRYPTION_PASSWORD
```

## Alerts

- Disk usage above 75 percent.
- `/ready` returns non-200.
- Container restart loop.
- Failed backup or missing offsite copy.
- Kafka consumer lag.
- PostgreSQL connection saturation.
- Redis unavailable.
- ClamAV unavailable for plaintext uploads.
- LiveKit UDP media failures or elevated reconnect rate.
