# Fire & Smoke — FastAPI backend

One service that watches RTSP cameras with InsightEye's fire and smoke model (`models/fire.pt`), turns sightings into **incidents**, raises alerts, and serves the console's API.

---

## From a sighting to an incident

```
frame ──(FIRE_DETECT_FPS, 2/s)──> fire.pt ──> boxes over the per-kind confidence, inside the ROI
                                                │
     FireMonitor, per camera and kind:          ▼
     seen in FIRE_CONFIRM_HITS of the last FIRE_CONFIRM_WINDOW checks (3 of 5)?
                                                │ yes
                                                ▼
     OPENED   fire_event row + annotated frame + alert email; clip recording starts
     (seen)   last_seen_at and peak confidence move on; no second alert
     CLOSED   not seen for FIRE_CLEAR_AFTER_S (30 s)
     REOPENED seen again within FIRE_COOLDOWN_S (10 min) of closing: the same row, no new alert
```

The state machine is [app/services/fire_monitor.py](app/services/fire_monitor.py). It is pure Python and driven by timestamps, so [tests/test_fire_monitor.py](tests/test_fire_monitor.py) exercises it without a camera or a model. The detector wrapper is [app/services/fire_detector.py](app/services/fire_detector.py). It maps the model's classes through `FIRE_CLASS_MAP` (0 = fire, 1 = smoke, 2 ignored, as InsightEye reads them) and applies the thresholds and the camera's ROI.

Fire and smoke are separate incidents, each with its own alert. When both are in view, the camera's status reads fire. An incident's `status` (OPEN → ACKNOWLEDGED → RESOLVED / FALSE_POSITIVE) is the operator's triage, independent of whether the camera still sees it. At startup, incidents a previous process left live are closed, because nobody is watching them any more.

Every value is set globally in `.env` and can be overridden per camera in `camera.settings`:

```json
{ "fire_confidence": 0.6, "smoke_confidence": 0.4, "confirm_hits": 4, "confirm_window": 6,
  "clear_after_s": 60, "cooldown_s": 300, "kinds": ["fire"] }
```

`kinds` limits what a camera alerts on; the detector still runs and the live view still shows both. The camera's `building`, `floor_level`, `zone` and `area` make the location in InsightEye's alert text: *"🚨 FIRE ALERT: FIRE detected in Warehouse A - Floor 1 - Loading bay - Dock 3"*. A camera without them falls back to `location`.

Each worker also adds its checks and hits to `detection_sample_hourly`. Analytics divides by those, giving rates like "fire in 0.4% of checks".

`tools/eval_fire.py` runs the same detector and monitor over video files on video time, and prints every incident it would raise:

```bash
docker compose exec api python tools/eval_fire.py /app/videos/fire1.mp4 --set fire_confidence=0.4
```

---

## Layout

```
app/
├── api/routes/     auth, user, workspace, camera, event (+ /alerts), analytics, system
├── api/deps.py     auth, role floors, the active workspace
├── core/           config.py (pydantic-settings), database.py (asyncpg), migrations.py, security.py
├── schemas/        pydantic request/response models
├── services/       model_registry, fire_detector, fire_monitor, rtsp_reader, stream_manager,
│                   clip_recorder, event_service, alert_mailer, analytics_service,
│                   media_service + object_store (MinIO), retention, camera/user/workspace/auth/otp
├── utils/          image, geometry, response
└── main.py         app factory, lifespan, /health
models/             fire.pt and its provenance (models/README.md)
videos/             fire1.mp4, the test camera's clip
tools/eval_fire.py  score the pipeline on video files
```

The schema, demo data and reference queries are in `../database/` (see its README).

---

## Running with Docker

From the repository root, run the full stack (database, MinIO, test RTSP, API and console). See `../README.md`.

`docker-compose.yml` in this folder is the **backend-only** stack, for iterating on detection without a web container:

```bash
cd "/home/ubuntu/fire&smoke/backend"
cp .env.example .env               # then set SECRET_KEY
docker compose up -d --build
```

Both files declare the project name `fire-smoke`, so they share one `pgdata` volume and one API image. The cost is that `docker compose up` here reports the `web` container as an orphan. That's harmless, and much better than a second API running against a second, empty database. Do not pass `--remove-orphans`.

The api needs `models/fire.pt` (mounted, not baked into the image). It uses the GPU when `MODEL_DEVICE=cuda` and one is available, and falls back to CPU otherwise.

## Running without Docker

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# point at a Postgres that has ../database/schema.sql applied
DB_HOST=localhost DB_PORT=5437 uvicorn app.main:app --reload
```

---

## Auth

Every route below `/api/v1` requires a bearer token except `GET /health` and the public password-reset routes. There is no public signup. The first admin is created at startup from `BOOTSTRAP_ADMIN_USERNAME` / `_EMAIL` / `_PASSWORD` in `.env` (default `admin` / `ChangeMe!123`; change it after the first login). Every other account is created by an admin through `POST /users`.

| method | path | purpose |
|---|---|---|
| POST | `/auth/login` | `{username, password}` → access + refresh token; also sets the media cookie. `username` may be the account's email, in any case |
| POST | `/auth/refresh` | `{refresh_token}` → a new pair; rotates the refresh token |
| POST | `/auth/logout` · `/auth/logout-all` | revoke this session, or every session of the account |
| GET | `/auth/me` | the calling user |
| POST | `/auth/change-password` | verifies the current password, then logs the account out everywhere |
| GET | `/auth/options` | public: `{password_reset}`, whether the login page offers "Forgot your password?" |
| POST | `/auth/forgot-password` | public: `{email}` → mails a 6-digit code; same answer whether or not the account exists |
| POST | `/auth/reset-password` | public: `{email, code, new_password}` → sets the password, logs out everywhere |

Password reset is off until `SMTP_HOST` is set; the two public routes answer 503 until then. A code expires after `OTP_TTL_SECONDS`, one can be sent per `OTP_RESEND_SECONDS`, and `OTP_MAX_ATTEMPTS` wrong guesses burn it. Only its HMAC is stored.

There are three roles, each a superset of the one before:

- **viewer:** reads everything;
- **operator:** also triages incidents and starts and stops cameras;
- **admin:** also registers, edits and deletes cameras, and manages accounts and workspaces.

The floors are enforced in `app/api/deps.py` and applied on each route.

The four media routes accept the httpOnly cookie `/auth/login` sets, because a plain `<img>` or `<video>` cannot attach an `Authorization` header: `/cameras/{id}/snapshot`, `/cameras/{id}/stream`, `/events/{id}/frame` and `/events/{id}/clip`. No other route accepts it (see `get_image_viewer` in `app/api/deps.py`).

### Workspaces

Data is partitioned into workspaces, as in InsightEye. A camera belongs to one, and its incidents, alerts and alert emails follow it. Members see the workspaces they are in; admins see every workspace. Roles are account-wide.

- **Choosing a workspace.** Every data route works in the workspace named by the `X-Workspace-Id` header. Without it, the caller's first workspace is used (Default for admins).
- **Hidden workspaces.** A workspace the caller cannot see, or a camera or incident in another workspace, answers **404**, the same as a missing one.
- **Media routes** cannot send the header, so they are checked against the workspace of the camera or incident itself.

| method | path | purpose |
|---|---|---|
| GET | `/workspaces/mine` | the caller's workspaces (all of them for admins), Default first |
| GET · POST | `/workspaces` | admin: list, or create `{name, description?, member_ids?}` |
| GET · PATCH · DELETE | `/workspaces/{id}` | admin: read, edit, delete. Delete cascades to cameras and incidents and stops their workers. Default cannot be deleted or deactivated |
| GET · POST · DELETE | `/workspaces/{id}/members[/{user_id}]` | admin: list, add, remove members |

`POST /users` and `PATCH /users/{id}` take `workspace_ids`. A new account with none joins Default.

---

## API

Base prefix `/api/v1`.

### Cameras
| method | path | role | purpose |
|---|---|---|---|
| POST | `/cameras` | admin | register `{name, rtsp_url, location?, building?, floor_level?, zone?, area?, enabled?, roi?, settings?}`; starts the worker if enabled |
| GET | `/cameras` · `/cameras/{id}` | viewer | list, read |
| PATCH | `/cameras/{id}` | admin | update; a running worker restarts with the new settings |
| DELETE | `/cameras/{id}` | admin | delete the camera, its incidents and their media |
| POST | `/cameras/{id}/start` · `/stop` | operator | control the worker; sets / clears `enabled` |
| GET | `/cameras/{id}/status` | viewer | worker state, the latest check's boxes, live incidents and pending sightings |
| GET | `/cameras/{id}/snapshot` · `/stream` | viewer (cookie) | latest annotated frame as JPEG; live MJPEG |

### Incidents and alerts
| method | path | role | purpose |
|---|---|---|---|
| GET | `/alerts/active` | viewer | `{count, alerts}`: OPEN incidents, newest first, each with InsightEye's `message`. Polled by every console |
| GET | `/events` | viewer | filter by `camera_id`, `kind`, `status`, `live`, `start`/`end`; paginated |
| GET | `/events/stats` | viewer | all-time, open, live and last-24-h counts |
| GET | `/events/{id}` | viewer | one incident, with `location_text` and `has_clip` |
| GET | `/events/{id}/frame` · `/clip` | viewer (cookie) | the annotated frame; the evidence clip, with Range support |
| PATCH | `/events/{id}/status` | operator | `{status, action_taken?, description?}`; stamps who acknowledged / closed it and when |

### Analytics
Every route takes `days` (1–90; 1 means hourly buckets) and `tz` (IANA).

| method | path | purpose |
|---|---|---|
| GET | `/analytics/summary` | KPIs (incidents, detection rates, median time to acknowledge / resolve, false-positive share), the zero-filled series, the hour-of-day heatmap |
| GET | `/analytics/confidence-audit` | peak-confidence histogram and per-camera spread, with operator-marked false positives |
| GET | `/analytics/by-camera` | InsightEye's detections-by-camera, over incidents and samples |
| GET | `/analytics/by-location` | the same grouped by `building`, `floor_level`, `zone`, `area` or `location` |
| GET | `/analytics/high-risk` | cameras whose detection rate reaches `threshold_percentage`, or that had a fire |

### System
`GET /health`, `GET /api/v1/system/workers`, and `GET /api/v1/system/config`. The last returns the tuning values actually in force: the first place to look when an alert fires later than expected.

---

## Walkthrough

```bash
API=localhost:8004/api/v1
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe!123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer $TOKEN"

# 1. register a camera on the looping fire clip
CAM=$(curl -s -X POST $API/cameras -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Dock 3","rtsp_url":"rtsp://mediamtx:8554/fire1","building":"Warehouse A","floor_level":"1","zone":"Loading bay"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["camera_id"])')

# 2. a few seconds later: what it sees, and the alert it raised
curl -s $API/cameras/$CAM/status -H "$AUTH" | python3 -m json.tool
curl -s $API/alerts/active -H "$AUTH" | python3 -m json.tool

# 3. acknowledge it, then fetch the frame and (after CLIP_POST_SECONDS) the clip
EVENT=$(curl -s "$API/events?camera_id=$CAM&per_page=1" -H "$AUTH" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["events"][0]["event_id"])')
curl -s -X PATCH $API/events/$EVENT/status -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"status":"ACKNOWLEDGED","action_taken":"Fire team called"}'
curl -s $API/events/$EVENT/frame -H "$AUTH" -o alert.jpg
curl -s $API/events/$EVENT/clip -H "$AUTH" -o clip.mp4
```

---

## Tests

```bash
docker compose run --rm -v ./tests:/app/tests -v ./videos:/app/videos:ro api pytest -q   # everything
docker compose run --rm -v ./tests:/app/tests api pytest -q -m "not slow"                  # no model run
```

| File | Covers | Needs |
|---|---|---|
| [test_fire_monitor.py](tests/test_fire_monitor.py) | confirmation window, one alert per incident, clear-after, cooldown reopen, fire over smoke, per-camera params | nothing |
| [test_fire_detector.py](tests/test_fire_detector.py) | class map, per-kind thresholds, ROI, camera overrides, annotation. The `slow` test runs the real `fire.pt` over `fire1.mp4` | the model, for `slow` |
| [test_clip_recorder.py](tests/test_clip_recorder.py) | pre-roll, post-roll, flush, H.264 encode, retention | ffmpeg, for the encode |
| [test_supervisor.py](tests/test_supervisor.py), [test_utils.py](tests/test_utils.py) | worker health and backoff; geometry, crops, Range parsing | nothing |
| [test_auth.py](tests/test_auth.py), [test_otp.py](tests/test_otp.py) | hashing, JWTs, roles, rotation, reset codes | DB for some |
| [test_fire_events.py](tests/test_fire_events.py) | camera CRUD with location fields, recording and its idempotency, lifecycle, triage, the alert poll, filters, samples, every analytics query | DB, MinIO for one |
| [test_workspaces.py](tests/test_workspaces.py), [test_migrations.py](tests/test_migrations.py) | workspace isolation; the migration runner | DB |

Database tests skip themselves unless a database with the schema applied is reachable, and each cleans up after itself. The `slow` test skips without `videos/` mounted, since the image does not contain the clip.

---

## Tuning notes

- `FIRE_DETECT_FPS` sets how often each camera is checked, and so how many cameras one GPU carries. Confirmation is counted in checks: at 2/s, 3 of 5 means about 2.5 s from the first sighting to the alert.
- `FIRE_CONFIDENCE` / `SMOKE_CONFIDENCE` (0.5, as InsightEye). Smoke is fainter and more often missed, so a camera looking at high ceilings may want it lower.
- `FIRE_COOLDOWN_S` is InsightEye's 10-minute cooldown, now actually applied: a fire that flickers in and out of view is one incident and one email.
- `FRAME_SKIP` / `TARGET_PROCESS_FPS` set how many frames reach the worker at all: the live view and clips run at that rate, and detection samples from it at `FIRE_DETECT_FPS`. Keep `TARGET_PROCESS_FPS` above `FIRE_DETECT_FPS`.
- `MODEL_DEVICE=cuda` uses FP16 (`FIRE_HALF`). On CPU the same model works at lower throughput.
