# Database

Postgres 17. The compose image is `pgvector/pgvector:pg17` because the sibling stacks on this host already have it; no extension beyond `pgcrypto` is used.

Two tables carry the app itself:

- **`fire_event`** — one fire or smoke **incident** on one camera. A row appears once a camera has seen the kind in 3 of its last 5 checks, stays live (`cleared_at IS NULL`) while it is still seen, and closes 30 s after the last sighting. Seen again within the cooldown, the same row reopens. `status` is the operator's triage (OPEN → ACKNOWLEDGED → RESOLVED / FALSE_POSITIVE) and is independent of whether the camera still sees it.
- **`detection_sample_hourly`** — checks and hits per camera per hour, the denominator for detection rates ("fire in 0.4% of checks").

```
workspace ──< camera ──< fire_event
                    └──< detection_sample_hourly
workspace ──< workspace_member >── app_user ──< refresh_session
                                            └── password_otp
```

The accounts tables are the same as lost-found's:

- `app_user` (username, email, Argon2 hash, role, `token_version`);
- `refresh_session` (one row per logged-in device);
- `password_otp` (emailed reset codes, stored as HMACs);
- `workspace` and `workspace_member`.

None of them is seeded. The first admin is created by the API at startup if `app_user` is empty (`BOOTSTRAP_ADMIN_*`, see `backend/app/services/user_service.py:ensure_bootstrap_admin`).

## Layout

| Path | Runs when | Contents |
| --- | --- | --- |
| `schema.sql` | first boot of an empty volume, automatic | every table, index and trigger |
| `migrations/NNN_*.sql` | API startup, once each | changes made after the first release (none yet) |
| `seed.sql` | on demand | demo cameras, incidents and samples |
| `queries.sql` | never automatic | reference queries, annotated with the endpoint that issues them |

`docker-compose.yml` bind-mounts `schema.sql` into `/docker-entrypoint-initdb.d/`, so Postgres runs it once, on the first boot of an empty data volume. Editing it does nothing to a database that already exists; see *Migrations*.

## Applying the schema

The compose stack does it for you:

```bash
cd "/home/ubuntu/fire&smoke"
docker compose up -d postgres
```

Against a database that already exists, or one you manage elsewhere:

```bash
psql -h 127.0.0.1 -p 5437 -U firesmoke -d firesmoke_db -f database/schema.sql
```

Every statement is `IF NOT EXISTS` or guarded, so re-applying it is a no-op.

## Migrations

`schema.sql` is always the full, current schema for a fresh volume. Postgres runs it only once, so every later change to it **also** goes into a new numbered file in `migrations/`. This is the same runner as lost-found's.

- **Applied:** the API mounts `migrations/` at `/app/migrations`. At startup, `app/core/migrations.py` applies each file not yet in `schema_migration`, in name order. Each runs in its own transaction, under an advisory lock.
- **Idempotent:** use `IF NOT EXISTS` and `DO $$ … $$` guards. On a fresh volume every file runs against a schema that already has the change, and must be a no-op there.
- **Never edit an applied file.** It is not re-run; the API only logs a checksum warning. Add the next number instead.

```bash
docker compose exec api python -m app.core.migrations --list   # applied / pending
docker compose exec api python -m app.core.migrations          # apply now, without a restart
```

The folder is empty: lost-found's migrations 001–004 (MinIO keys, resolution notes, OTP, workspaces) are part of this baseline.

## Workspaces

Each camera belongs to a workspace, and its incidents follow it: the trigger `trg_event_workspace` copies the camera's `workspace_id` when an insert leaves it out. Workers therefore never deal with workspaces. Camera names are unique per workspace.

The **Default** workspace has the fixed id `00000000-0000-0000-0000-000000000001`. Hand-written inserts into `camera` (`seed.sql`, tools) land there. The API never deletes it; deleting any other workspace cascades to its cameras and incidents.

## Seeding

The seed is deliberately **not** run at boot, so a fresh stack comes up empty. Load it when you want the console to have something to render:

```bash
docker compose exec -T postgres psql -U firesmoke -d firesmoke_db < database/seed.sql
```

It inserts:

- 4 cameras across two buildings, all disabled. They read the looping `fire1.mp4`, which is on fire: start *Warehouse A - Loading Bay* from its page to see a live alert.
- 28 incidents over the last 14 days: fire and smoke, acknowledged, resolved and false positive.
- Hourly samples (7200 checks an hour per camera).

No incident is left OPEN, because an open alert pops the emergency dialog on every console. Every row has a fixed id and every insert is `ON CONFLICT DO NOTHING`, so it is safe to run repeatedly.

## Resetting

`schema.sql` only runs against an empty volume. To start over:

```bash
docker compose down -v          # -v drops the pgdata and miniodata volumes, and with them all data
docker compose up -d
```

## Connecting

| From | Command |
| --- | --- |
| Host | `psql postgresql://firesmoke:firesmoke_pass@localhost:5437/firesmoke_db` |
| Container | `docker compose exec postgres psql -U firesmoke -d firesmoke_db` |
| API container | `DB_HOST=postgres`, `DB_PORT=5432` (compose network) |

## Notes on the schema

- **`idx_fire_event_live`**, a unique index on `(camera_id, kind) WHERE cleared_at IS NULL`, makes recording idempotent: a worker replaying a confirmation produces no second alert. At startup the API closes incidents a previous process left live.
- **`idx_fire_event_open`**, a partial index on `(workspace_id, detected_at DESC) WHERE status = 'OPEN'`, serves the alert poll every console sends every few seconds.
- **Media lives in MinIO**: `frame_key` and `clip_key`. The `frame_jpeg` BYTEA column and `clip_path` are the fallback the API writes while MinIO is unreachable. Retention deletes clips (not frames or rows) past `CLIP_RETENTION_DAYS` or `CLIP_MAX_TOTAL_MB`.
- **How this maps to InsightEye:**

  | InsightEye | Here |
  |---|---|
  | `fire_detection_state` (one row per stream: status + last notification, for the 10-minute cooldown) | the live incident row plus `FIRE_COOLDOWN_S` |
  | `stream_results.fire_status`, one row per check | `fire_event` for incidents, `detection_sample_hourly` for rates |
  | `notifications` rows matched on the words "fire" / "smoke" | `fire_event.status = 'OPEN'`, served by `/alerts/active` |
