-- ---------------------------------------------------------------------------
-- Fire & Smoke : queries
--
-- A reference, not a script. Each block is annotated with the endpoint or the
-- service function that issues it, so a statement can be pasted into psql and
-- run in isolation while working out why the API returned what it did.
--
-- Parameters use asyncpg's $1, $2 style, matching the source. Substitute real
-- values before running a block by hand.
--
--   psql -h 127.0.0.1 -p 5437 -U firesmoke -d firesmoke_db
--
-- Sections:
--   1. cameras      2. incidents      3. alerts
--   4. samples      5. analytics      6. operations
--
-- Workspaces: the api adds "AND <table>.workspace_id = $n" to every list and
-- aggregate below for the caller's active workspace (X-Workspace-Id), and
-- answers 404 for a row by id whose workspace_id is another one. The blocks
-- here leave that filter out for readability.
-- ---------------------------------------------------------------------------

-- :name workspace_owner_of
-- app/services/workspace_service.py:owner_of - the check behind every by-id route.
SELECT workspace_id FROM fire_event WHERE event_id = $1;

-- ==========================================================================
-- 1. CAMERAS
-- ==========================================================================

-- :name create_camera
-- POST /api/v1/cameras (app/services/camera_service.py:create_camera)
INSERT INTO camera (name, rtsp_url, location, enabled, roi, settings, workspace_id,
                    building, floor_level, zone, area)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb,
        COALESCE($7, '00000000-0000-0000-0000-000000000001'::uuid), $8, $9, $10, $11)
RETURNING *;

-- :name list_cameras_enabled_only
-- What StreamManager.start_enabled_cameras() runs at boot. Served by idx_camera_enabled.
SELECT * FROM camera WHERE enabled ORDER BY created_at;

-- :name camera_location_text
-- The alert text's location, as InsightEye builds it (event_service.LOCATION_SQL).
SELECT name,
       COALESCE(NULLIF(concat_ws(' - ', NULLIF(building, ''), 'Floor ' || NULLIF(floor_level, ''),
                                 NULLIF(zone, ''), NULLIF(area, '')), ''),
                NULLIF(location, ''), 'Unknown location') AS location_text
FROM camera;

-- ==========================================================================
-- 2. INCIDENTS
-- ==========================================================================

-- :name record_event
-- A confirmed incident (event_service.record_event). idx_fire_event_live allows
-- one live incident per camera and kind; a replay updates last_seen_at instead,
-- and (xmax = 0) tells the worker whether this call created the row.
INSERT INTO fire_event (camera_id, kind, peak_confidence, bbox, detections, sightings,
                        started_at, last_seen_at)
VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
ON CONFLICT (camera_id, kind) WHERE cleared_at IS NULL
DO UPDATE SET last_seen_at = GREATEST(fire_event.last_seen_at, EXCLUDED.last_seen_at)
RETURNING event_id, (xmax = 0) AS inserted;

-- :name close_incident
-- Not seen for FIRE_CLEAR_AFTER_S (event_service.close_incident).
UPDATE fire_event SET cleared_at = $2, last_seen_at = GREATEST(last_seen_at, $3) WHERE event_id = $1;

-- :name close_stale
-- At startup: incidents a previous process left live have nobody watching them.
UPDATE fire_event SET cleared_at = last_seen_at WHERE cleared_at IS NULL;

-- :name live_incidents
-- What every camera sees right now, per the database.
SELECT c.name, e.kind, e.started_at, e.last_seen_at, e.peak_confidence, e.status
FROM fire_event e JOIN camera c USING (camera_id)
WHERE e.cleared_at IS NULL
ORDER BY e.detected_at DESC;

-- :name list_events
-- GET /api/v1/events?kind=&status=&live=&camera_id=&start=&end=
SELECT e.event_id, c.name AS camera_name, e.kind, e.peak_confidence, e.detected_at,
       e.cleared_at, (e.cleared_at IS NULL) AS live, e.status
FROM fire_event e LEFT JOIN camera c ON c.camera_id = e.camera_id
WHERE e.kind = 'fire' AND e.status = 'RESOLVED'
ORDER BY e.detected_at DESC
LIMIT 20 OFFSET 0;

-- :name update_status
-- PATCH /api/v1/events/{id}/status. Leaving OPEN stamps acknowledged_*; closing
-- stamps resolved_*; back to OPEN clears both.
UPDATE fire_event
SET status          = $1::text,
    action_taken    = COALESCE($3, action_taken),
    description     = COALESCE($4, description),
    acknowledged_at = CASE WHEN $1::text <> 'OPEN' THEN COALESCE(acknowledged_at, NOW()) END,
    acknowledged_by = CASE WHEN $1::text <> 'OPEN' THEN COALESCE(acknowledged_by, $5::uuid) END,
    resolved_at     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                           THEN COALESCE(resolved_at, NOW()) END,
    resolved_by     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                           THEN COALESCE($5::uuid, resolved_by) END
WHERE event_id = $2
RETURNING *;

-- ==========================================================================
-- 3. ALERTS
-- ==========================================================================

-- :name active_alerts
-- GET /api/v1/alerts/active, polled by every console every ~3 s. Served by
-- the partial index idx_fire_event_open.
SELECT e.event_id, c.name AS camera_name, e.kind, e.detected_at, (e.cleared_at IS NULL) AS live,
       COUNT(*) OVER () AS total
FROM fire_event e LEFT JOIN camera c ON c.camera_id = e.camera_id
WHERE e.workspace_id = $1 AND e.status = 'OPEN'
ORDER BY e.detected_at DESC
LIMIT 20;

-- :name alert_recipients
-- Who the alert email goes to (alert_mailer.recipients): the workspace's
-- active members, or every active admin when it has none.
SELECT u.email FROM workspace_member m JOIN app_user u ON u.user_id = m.user_id
WHERE m.workspace_id = $1 AND u.is_active AND u.email <> '';

-- ==========================================================================
-- 4. SAMPLES
-- ==========================================================================

-- :name add_samples
-- Each worker adds its checks and hits per UTC hour, every 60 s.
INSERT INTO detection_sample_hourly (camera_id, hour, checks, fire_hits, smoke_hits)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (camera_id, hour) DO UPDATE
SET checks     = detection_sample_hourly.checks + EXCLUDED.checks,
    fire_hits  = detection_sample_hourly.fire_hits + EXCLUDED.fire_hits,
    smoke_hits = detection_sample_hourly.smoke_hits + EXCLUDED.smoke_hits;

-- :name detection_rate_by_camera
-- InsightEye's fire_detection_rate / smoke_detection_rate: share of checks that saw it.
SELECT c.name,
       SUM(s.checks)                                                 AS checks,
       ROUND(100.0 * SUM(s.fire_hits)  / NULLIF(SUM(s.checks), 0), 2) AS fire_rate_pct,
       ROUND(100.0 * SUM(s.smoke_hits) / NULLIF(SUM(s.checks), 0), 2) AS smoke_rate_pct
FROM detection_sample_hourly s JOIN camera c USING (camera_id)
WHERE s.hour >= NOW() - INTERVAL '7 days'
GROUP BY c.name
ORDER BY fire_rate_pct DESC NULLS LAST;

-- ==========================================================================
-- 5. ANALYTICS
-- ==========================================================================
-- The full queries are in app/services/analytics_service.py; these are their
-- cores, for a quick look.

-- :name incidents_per_day
-- GET /api/v1/analytics/summary (series), zero-filled by generate_series.
WITH days AS (
    SELECT generate_series(date_trunc('day', NOW()) - INTERVAL '6 days', date_trunc('day', NOW()),
                           INTERVAL '1 day') AS day
)
SELECT d.day::date,
       COUNT(e.event_id) FILTER (WHERE e.kind = 'fire')  AS fire,
       COUNT(e.event_id) FILTER (WHERE e.kind = 'smoke') AS smoke
FROM days d
LEFT JOIN fire_event e ON date_trunc('day', e.detected_at) = d.day
GROUP BY d.day
ORDER BY d.day;

-- :name response_times
-- KPIs: median time to acknowledge and to resolve.
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM acknowledged_at - detected_at))
           FILTER (WHERE acknowledged_at IS NOT NULL) AS median_ack_s,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM resolved_at - detected_at))
           FILTER (WHERE resolved_at IS NOT NULL)     AS median_resolve_s
FROM fire_event
WHERE detected_at >= NOW() - INTERVAL '7 days';

-- :name by_camera
-- GET /api/v1/analytics/by-camera (InsightEye's detections-by-camera, over incidents).
SELECT c.name,
       COUNT(*) FILTER (WHERE e.kind = 'fire')                               AS fire_events,
       COUNT(*) FILTER (WHERE e.kind = 'smoke')                              AS smoke_events,
       COUNT(DISTINCT e.detected_at::date) FILTER (WHERE e.kind = 'fire')    AS days_with_fire,
       MIN(e.detected_at) FILTER (WHERE e.kind = 'fire')                     AS first_fire,
       MAX(e.detected_at) FILTER (WHERE e.kind = 'fire')                     AS last_fire
FROM camera c
LEFT JOIN fire_event e ON e.camera_id = c.camera_id AND e.detected_at >= NOW() - INTERVAL '7 days'
GROUP BY c.name
ORDER BY COUNT(e.event_id) DESC;

-- ==========================================================================
-- 6. OPERATIONS
-- ==========================================================================

-- :name storage_per_camera
-- What retention will eventually reclaim: incidents with media, per camera.
SELECT c.name,
       COUNT(*) FILTER (WHERE e.clip_key IS NOT NULL)   AS clips_in_minio,
       COUNT(*) FILTER (WHERE e.clip_path IS NOT NULL)  AS clips_on_disk,
       COUNT(*) FILTER (WHERE e.frame_jpeg IS NOT NULL) AS frames_in_postgres
FROM fire_event e JOIN camera c USING (camera_id)
GROUP BY c.name;

-- :name applied_migrations
SELECT version, applied_at FROM schema_migration ORDER BY version;
