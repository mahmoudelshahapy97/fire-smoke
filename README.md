# Fire & Smoke

Fire and smoke detection on RTSP cameras, ported from InsightEye. It uses InsightEye's own model (`fire.pt`, YOLO26-N) and its alert text and emergency dialog. Around them it adds:

- incidents an operator triages, instead of one notification per frame;
- an annotated frame and an evidence clip for each incident;
- alert emails to the camera's workspace;
- analytics.

```
RTSP camera → fire.pt on the GPU (2 checks/s) → 3 of 5 checks → incident
                                                                  ├─ frame + clip → MinIO
                                                                  ├─ alert email
                                                                  └─ OPEN alert ──> console poll ──> 🚨 dialog
browser ──same origin──> web (nginx) ──proxy──> api ──> postgres
```

| Tier | Directory | Stack |
|---|---|---|
| Console | [`frontend/`](frontend) | React 18, Vite, React Router, MUI, Chart.js |
| API + detection | [`backend/`](backend) | FastAPI, asyncpg, Ultralytics, OpenCV |
| Database | [`database/`](database) | PostgreSQL 17: schema, seed, reference queries |
| End-to-end tests | [`e2e/`](e2e) | Playwright, run against the live stack |

Each directory has its own README with the detail.

---

## Run the whole thing

```bash
cd "/home/ubuntu/fire&smoke"            # quote it: the path contains '&'
cp .env.example .env                    # then set MINIO_ROOT_PASSWORD
cp backend/.env.example backend/.env    # then set SECRET_KEY (see the comment in the file)
docker compose up -d --build
```

| Service | URL | Notes |
|---|---|---|
| Console | http://localhost:8083 | nginx serving the built SPA and proxying the API |
| API | http://localhost:8004 | `/docs` for Swagger |
| Postgres | localhost:5437 | `firesmoke` / `firesmoke_pass` / `firesmoke_db` |
| Test RTSP | rtsp://localhost:8557/fire1 | mediamtx looping `backend/videos/fire1.mp4` |
| MinIO | http://localhost:9002 (S3), http://localhost:9003 (console) | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from `.env` |

Sign in as the bootstrap admin from `backend/.env` (`admin` / `ChangeMe!123` by default) and change the password.

The ports avoid the other stacks on this machine (see the header of `docker-compose.yml`). Override them with `POSTGRES_HOST_PORT`, `API_HOST_PORT`, `WEB_HOST_PORT`, `RTSP_HOST_PORT`, `MINIO_API_HOST_PORT` and `MINIO_CONSOLE_HOST_PORT`.

The api runs the detector on the GPU (`MODEL_DEVICE=cuda`, and a GPU reservation in `docker-compose.yml`). Without one it falls back to the CPU and still works, just with fewer cameras per machine. The model is `backend/models/fire.pt`, mounted into the container; see [backend/models/README.md](backend/models/README.md) for where it came from and what its classes mean.

The schema is `database/schema.sql`, applied by Postgres on the first boot of an empty volume; later changes go in `database/migrations/`. To have something on screen straight away, load the demo data: four cameras and two weeks of incidents.

```bash
docker compose exec -T postgres psql -U firesmoke -d firesmoke_db < database/seed.sql
```

## From a sighting to an alert

Each camera's worker checks a frame `FIRE_DETECT_FPS` (2) times a second. A box counts when it beats the per-kind confidence (`FIRE_CONFIDENCE` / `SMOKE_CONFIDENCE`, 0.5 by default).

- **Confirmed:** a kind seen in `FIRE_CONFIRM_HITS` of the last `FIRE_CONFIRM_WINDOW` checks (3 of 5) becomes an incident. One flicker of orange light is not a fire.
- **Recorded:** the incident is a `fire_event` row with the annotated frame, its status OPEN.
- **Alerted:** the console polls `GET /api/v1/alerts/active` every 3 s. Every open console then shows the 🚨 Emergency Alert dialog: *"🚨 FIRE ALERT: FIRE detected in Warehouse A - Floor 1 - Loading bay - Dock 3"*. It cannot be escaped away, and Close only enables after 10 s; Acknowledge takes it off every console. The workspace's members also get an email with the same wording.
- **Live, then cleared:** the incident stays live while the kind is still seen, and closes `FIRE_CLEAR_AFTER_S` (30 s) after the last sighting. Seen again within `FIRE_COOLDOWN_S` (10 min), the same incident reopens rather than raising a new alert.

Triage (Acknowledge, Resolve, False positive, with what was done) is the operator's, and independent of whether the camera still sees it. Any of these values can be set per camera, along with which kinds it alerts on and a region of interest. The location in the alert comes from the camera's building, floor, zone and area.

To see how a model or a threshold would behave on a clip, without a camera:

```bash
docker compose exec api python tools/eval_fire.py /app/videos/fire1.mp4 --set confirm_hits=2
```

## Cameras stay running

A camera's `enabled` flag is the operator's intent. **Start** sets it and **Stop** clears it, so a camera comes back after an API restart exactly as it was left.

While the API runs, a supervisor checks every worker every `WORKER_SUPERVISION_INTERVAL_S`. It restarts any worker that died, errored or stopped analysing frames, with exponential backoff. It also starts any enabled camera that has no worker. Per-worker state, reconnects and restarts are shown on the camera page and at `GET /api/v1/system/workers`.

The camera page shows the annotated detection output live, as MJPEG from `GET /api/v1/cameras/{id}/stream`, with the boxes from the latest check.

`mediamtx` starts with the stack and serves `backend/videos/fire1.mp4` as `rtsp://mediamtx:8554/fire1`, looping on demand. That clip is on fire for most of its length: start a camera on it and an alert follows within seconds.

## Evidence: frames and clips

Images and videos are stored in MinIO; Postgres keeps the records and each object's key.

| Object | Key | Postgres column |
|---|---|---|
| Alert frame | `frames/<camera_id>/<event_id>.jpg` | `fire_event.frame_key` |
| Evidence clip | `clips/<camera_id>/<event_id>.mp4` | `fire_event.clip_key` |

- **Clips:** each incident gets an annotated mp4. It starts `CLIP_PRE_SECONDS` (20 s) before the incident was confirmed, so it shows how the fire started, and ends `CLIP_POST_SECONDS` (20 s) after. It plays on the incident page and is served with Range support at `GET /api/v1/events/{id}/clip`.
- **Fallback:** while MinIO is unreachable, the frame goes into Postgres (`frame_jpeg`) and the clip onto disk (`backend/data/clips`, `clip_path`). Reads try MinIO first.
- **Retention:** a pass every 6 h deletes clips older than `CLIP_RETENTION_DAYS` and keeps the total under `CLIP_MAX_TOTAL_MB`. The incident and its frame are kept.

On first start, `minio-init` creates the bucket (`MINIO_BUCKET`, default `firesmoke`) and exits. MinIO no longer publishes community images, so the service runs Chainguard's build, pinned by digest in `docker-compose.yml`.

## Accounts and workspaces

There is no public signup. Accounts have one of three roles:

- **viewer:** reads everything;
- **operator:** also triages incidents and starts and stops cameras;
- **admin:** also manages cameras, accounts and workspaces.

Cameras belong to a workspace, and their incidents, alerts and emails follow it. Password reset by emailed code works once `SMTP_HOST` is set. The details are in [backend/README.md](backend/README.md#auth).

## Tests

```bash
./e2e/run.sh                                                         # Playwright, against the running stack
docker compose run --rm -v ./backend/tests:/app/tests api pytest -q  # backend unit + DB tests
```

The e2e suite includes a real detection end to end: a camera on `fire1.mp4` raises the emergency dialog, which is then acknowledged, and its frame, clip and email are checked. See [e2e/README.md](e2e/README.md).
