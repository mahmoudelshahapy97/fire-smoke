-- ---------------------------------------------------------------------------
-- Fire & Smoke : schema
--
-- The source of truth for this app's schema. Bind-mounted into
-- /docker-entrypoint-initdb.d/ by docker-compose.yml, so Postgres applies it
-- once on the first boot of an empty data volume. There is no Alembic here —
-- what this file says is what the database is.
--
-- Apply it by hand to a database that already exists:
--
--   psql -h 127.0.0.1 -p 5437 -U firesmoke -d firesmoke_db -f schema.sql
--
-- Safe to re-run: every object is created IF NOT EXISTS.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions.
-- ---------------------------------------------------------------------------

-- gen_random_uuid() lives in pgcrypto on older servers; on PG13+ it is built
-- in. Creating it anyway keeps this file portable across both.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- workspace — a partition of the data: its cameras and their incidents
--
-- Users see the workspaces they are members of (workspace_member, below);
-- admins see all of them. The account roles stay global. "Default" has a
-- fixed id so seed data and tools can name it; the api never deletes it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace (
    workspace_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    UUID,                     -- app_user; FK added after that table
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_name ON workspace (lower(name));

INSERT INTO workspace (workspace_id, name, description)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default',
        'The workspace every install starts with.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- camera — one watched RTSP source
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera (
    camera_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Defaults to Default for hand-written inserts; the api always names it.
    workspace_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- rtsp:// URL, or a local video file path when exercising the pipeline
    -- without hardware.
    rtsp_url    TEXT NOT NULL,
    -- Where it looks, as InsightEye records it. The alert text and email
    -- read "<building> - Floor <floor_level> - <zone> - <area>", falling back
    -- to location; analytics can group by any of them.
    location    TEXT,
    building    TEXT,
    floor_level TEXT,
    zone        TEXT,
    area        TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Optional region of interest: [[x, y], ...] in pixel coordinates. Only
    -- detections whose centre lies inside it count, which is how a kitchen's
    -- stove or a welding bay is kept out of a camera that watches the floor.
    roi         JSONB,

    -- Per-camera overrides of the incident rules, e.g.
    -- {"fire_confidence": 0.6, "cooldown_s": 300, "kinds": ["fire"]}. An absent
    -- key means "inherit the global .env value", which is a different thing
    -- from 0.
    settings    JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Names are unique within a workspace.
    CONSTRAINT camera_workspace_name_key UNIQUE (workspace_id, name)
);

-- Partial index: startup only ever asks for the enabled rows.
CREATE INDEX IF NOT EXISTS idx_camera_enabled ON camera (enabled) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_camera_workspace ON camera (workspace_id);

-- ---------------------------------------------------------------------------
-- fire_event — one fire or smoke incident on one camera
--
-- A row appears once a kind has been seen in FIRE_CONFIRM_HITS of the last
-- FIRE_CONFIRM_WINDOW inferences, so a single orange flicker never alarms. It
-- stays open (cleared_at NULL) while the kind keeps being seen, and closes
-- FIRE_CLEAR_AFTER_S after the last sighting. Seen again within
-- FIRE_COOLDOWN_S, the same row reopens: one fire, one alert.
--
-- `status` is the operator's triage and is independent of whether the camera
-- still sees it: a fire can be ACKNOWLEDGED while it burns, and an OPEN alert
-- can have cleared on its own.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fire_event (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id       UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    -- Always the camera's: set by trg_event_workspace when left out.
    workspace_id    UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('fire', 'smoke')),
    peak_confidence REAL,
    bbox            JSONB,                   -- largest-confidence box: {"x1":..,"y1":..,"x2":..,"y2":..}
    detections      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- every box in the peak frame
    sightings       INTEGER NOT NULL DEFAULT 1,           -- inferences that saw it
    started_at      TIMESTAMPTZ NOT NULL,    -- first sighting of the confirming run
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- confirmed: when the alert went out
    last_seen_at    TIMESTAMPTZ NOT NULL,
    cleared_at      TIMESTAMPTZ,             -- NULL while it is still being seen
    frame_jpeg      BYTEA,                   -- annotated frame at confirmation (fallback when MinIO is down)
    frame_key       TEXT,                    -- the frame in MinIO: frames/<camera>/<event>.jpg
    clip_path       TEXT,                    -- evidence mp4 under CLIP_DIR (fallback when MinIO is down)
    clip_key        TEXT,                    -- the clip in MinIO: clips/<camera>/<event>.mp4
    status          TEXT NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE')),
    -- How the alert was closed out: what the operator did and their notes.
    action_taken    TEXT,
    description     TEXT,
    acknowledged_at TIMESTAMPTZ,            -- first left OPEN
    acknowledged_by UUID,                   -- app_user; FK added after that table
    resolved_at     TIMESTAMPTZ,            -- RESOLVED or FALSE_POSITIVE
    resolved_by     UUID,                   -- app_user; FK added after that table
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one live incident per camera and kind: makes recording idempotent,
-- so a worker replaying a confirmation cannot raise a second alert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fire_event_live
    ON fire_event (camera_id, kind) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fire_event_camera_time
    ON fire_event (camera_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_fire_event_workspace_time
    ON fire_event (workspace_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_fire_event_status ON fire_event (status);
-- The console's alert poll: open alerts of one workspace.
CREATE INDEX IF NOT EXISTS idx_fire_event_open
    ON fire_event (workspace_id, detected_at DESC) WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- detection_sample_hourly — how often each camera was checked, and saw what
--
-- InsightEye wrote one stream_results row per check and computed detection
-- rates from them ("fire in 3% of checks"). Writing every check here would be
-- millions of rows for the same answer, so workers add up per hour instead.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS detection_sample_hourly (
    camera_id    UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    hour         TIMESTAMPTZ NOT NULL,       -- date_trunc('hour', ...) in UTC
    checks       INTEGER NOT NULL DEFAULT 0,  -- inferences run
    fire_hits    INTEGER NOT NULL DEFAULT 0,  -- ...that saw fire above threshold
    smoke_hits   INTEGER NOT NULL DEFAULT 0,  -- ...that saw smoke above threshold
    PRIMARY KEY (camera_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_sample_hour ON detection_sample_hourly (hour);

-- ---------------------------------------------------------------------------
-- app_user — an operator console account
--
-- Three roles, in ascending order of what they may do:
--   viewer    read everything: dashboard, live views, incidents, analytics
--   operator  the daily work: acknowledge and resolve alerts, start and stop
--             camera workers
--   admin     register and delete cameras, and manage accounts
--
-- There is no public signup. The API creates the first admin at startup from
-- BOOTSTRAP_ADMIN_* if this table is empty; every later account is made by an
-- admin. The hash lives on the row rather than in a side table because there is
-- only ever one credential per account here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    full_name     TEXT,

    -- Argon2, produced by passlib in app/core/security.py. Never a plain digest.
    password_hash TEXT NOT NULL,

    role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'operator', 'viewer')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Bumped on "log out everywhere", password change and deactivation. Every
    -- access token carries the value it was minted with, and a mismatch is a
    -- 401. That makes revocation instant without a per-request blacklist
    -- lookup: the row is already being read to check role and is_active.
    token_version INTEGER NOT NULL DEFAULT 1,

    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_user_active ON app_user (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
-- refresh_session — one row per logged-in device
--
-- Keyed by the refresh token's jti, never by the token string itself, so a
-- lookup is an indexed UUID equality test rather than a scan over TEXT.
--
-- Refresh rotates: spending a refresh token revokes its row and issues a new
-- one. A revoked jti presented again means the token was captured, and the
-- attempt is refused rather than silently honoured.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_session (
    session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    jti         UUID NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,

    -- Context for the account's session list, so a stolen session is
    -- recognisable before it is revoked.
    user_agent  TEXT,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_session (user_id)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- password_otp — a "forgot your password?" code mailed to the account
--
-- At most one live code per account. Only an HMAC of the code is stored; it
-- expires after OTP_TTL_SECONDS and dies after OTP_MAX_ATTEMPTS wrong guesses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_otp (
    user_id       UUID PRIMARY KEY REFERENCES app_user (user_id) ON DELETE CASCADE,
    otp_hash      TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- workspace_member — who may see a workspace
--
-- Admins see every workspace without a row here. A new account joins the
-- workspaces it is created with, or Default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_member (
    workspace_id  UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_member_user ON workspace_member (user_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_created_by_fkey') THEN
        ALTER TABLE workspace
            ADD CONSTRAINT workspace_created_by_fkey
            FOREIGN KEY (created_by) REFERENCES app_user (user_id) ON DELETE SET NULL;
    END IF;
END $$;

-- Incidents take their camera's workspace, so the workers never have to know
-- about workspaces and the two can never disagree.
CREATE OR REPLACE FUNCTION fs_inherit_workspace() RETURNS trigger AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT c.workspace_id INTO NEW.workspace_id FROM camera c WHERE c.camera_id = NEW.camera_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_event_workspace
    BEFORE INSERT ON fire_event
    FOR EACH ROW EXECUTE FUNCTION fs_inherit_workspace();

-- fire_event is created before app_user, so its references to the operators
-- who handled it are added here.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fire_event_acknowledged_by_fkey') THEN
        ALTER TABLE fire_event
            ADD CONSTRAINT fire_event_acknowledged_by_fkey
            FOREIGN KEY (acknowledged_by) REFERENCES app_user (user_id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fire_event_resolved_by_fkey') THEN
        ALTER TABLE fire_event
            ADD CONSTRAINT fire_event_resolved_by_fkey
            FOREIGN KEY (resolved_by) REFERENCES app_user (user_id) ON DELETE SET NULL;
    END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Notes
--
-- Every change made here after the first release also goes into a numbered
-- file in database/migrations/ (NNN_name.sql), which the api applies at
-- startup and records in schema_migration.
--
-- Images and videos live in MinIO (the *_key columns). The BYTEA column and
-- clip_path are the fallback the api writes when MinIO is unreachable.
-- ---------------------------------------------------------------------------
