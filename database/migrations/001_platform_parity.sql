-- 001_platform_parity.sql
-- What every InsightEye console now shares: an in-app notification inbox, an
-- audit log, and refresh sessions tied to the password they were issued under.

-- Whether new alerts are emailed to the account; its own switch (PATCH /auth/me).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE;

-- A refresh session carries the account's token_version from when it was
-- issued, so a password change or reset retires it even if nobody revoked it.
ALTER TABLE refresh_session ADD COLUMN IF NOT EXISTS token_version INTEGER;

-- One row per account per notification: the bell, the Notifications page and
-- the socket that pushes new ones (backend/app/services/inbox_service.py).
CREATE TABLE IF NOT EXISTS notification (
    notification_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    workspace_id     UUID REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,
    severity         TEXT NOT NULL DEFAULT 'info'
                     CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    title            TEXT NOT NULL,
    message          TEXT NOT NULL DEFAULT '',
    link             TEXT,
    camera_id        UUID REFERENCES camera (camera_id) ON DELETE SET NULL,
    camera_name      TEXT,
    -- What it is about (an event, a lost report, ...), so one thing never
    -- notifies the same account twice.
    ref_id           UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_ref ON notification (user_id, kind, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_user_time ON notification (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_created ON notification (created_at);

-- Who did what, when and from where (backend/app/services/audit_service.py).
-- actor is kept as text so the row survives the account being deleted.
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id       UUID REFERENCES app_user (user_id) ON DELETE SET NULL,
    actor         TEXT,
    workspace_id  UUID REFERENCES workspace (workspace_id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failure')),
    target_type   TEXT,
    target_id     TEXT,
    target_label  TEXT,
    ip            TEXT,
    user_agent    TEXT,
    request_id    TEXT,
    data          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC);
