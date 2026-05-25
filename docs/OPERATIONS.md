# Production Operations

## Runtime Topology

Run the first production target on one VPS with Docker Compose:

- `nginx`: TLS termination, Socket.IO proxying, private media acceleration.
- `api`: Fastify API and Socket.IO server.
- `worker`: Kafka consumers for push, media scanning, and async jobs.
- `postgres`: source of truth.
- `redis`: presence, rate limiting, Socket.IO adapter.
- `kafka`: durable async event bus.
- `clamav`: plaintext upload scanning.
- `livekit`: audio-call SFU.

Only expose `80`, `443`, SSH, and the LiveKit UDP media range at the firewall. Internal data services are not published by Compose.

## Health And Readiness

- `GET /health`: process liveness.
- `GET /ready`: database, Redis, and storage readiness.
- `GET /metrics`: Prometheus-style process metrics. Nginx restricts this endpoint to private IP ranges.

## Secrets

Use `.env.production.example` as the template. Generate long random values for JWT secrets, MFA encryption key, LiveKit API secret, database password, and backup encryption password. Never commit the real `.env`.

## TLS

Mount certificates at:

- `ops/certs/fullchain.pem`
- `ops/certs/privkey.pem`

The included Nginx config redirects HTTP to HTTPS and enables HSTS. Replace with Caddy/Traefik if automatic certificate renewal is preferred.

## Storage

Private media storage is mounted at `/var/lib/homenet/storage` inside API, worker, and Nginx. Chat media is encrypted before upload, so server-side ClamAV only applies to plaintext avatars/admin assets.

## Backups And Restore

Run `ops/backup.ps1` daily. It creates:

- PostgreSQL custom-format dump.
- Media archive.
- GPG-encrypted outputs when `gpg` is available.

Copy encrypted outputs offsite. Run `ops/restore.ps1` monthly against staging and verify login, conversation loading, media retrieval, and call token generation.

## Deploy Flow

1. Update code on the VPS.
2. Update `.env` if needed.
3. Run `docker compose --env-file .env up -d --build`.
4. Run `docker compose exec api npm run prisma:deploy`.
5. Check `/ready`, logs, and worker health.
6. Run a smoke test: signup/login, direct message, group message, avatar upload, direct call token.

## Alerting

Alert on:

- `/ready` failure.
- Container restart loops.
- Disk above 75 percent.
- Backup missing or failed.
- Kafka consumer lag.
- PostgreSQL pool saturation.
- Redis unavailable.
- ClamAV unavailable.
- LiveKit reconnect rate/media failures.

## Scaling Notes

Horizontal API scaling requires Redis Socket.IO adapter, already configured. Media storage on a single VPS must become shared storage, replicated storage, or object storage-compatible storage before running API/worker on multiple hosts.
