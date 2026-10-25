-- ---------------------------------------------------------------------------
-- Fire & Smoke : demo data
--
-- Development only. Deliberately NOT mounted into docker-entrypoint-initdb.d,
-- so a fresh stack comes up empty and nobody ships fabricated incident history
-- to a real deployment. Load it when you want a populated console to work
-- against:
--
--   docker compose exec -T postgres psql -U firesmoke -d firesmoke_db < database/seed.sql
--
-- Re-runnable: every row has a fixed id (cameras by literal UUID, incidents by
-- md5('fs-seed-event-<n>')) and every insert is ON CONFLICT DO NOTHING, so a
-- second load leaves the same data rather than doubling it. Times are
-- relative to the first load, so the analytics windows have something in them.
--
-- No incident is left OPEN: an unacknowledged alert opens the console's
-- emergency dialog for everyone, which is not what demo data should do.
-- ---------------------------------------------------------------------------

BEGIN;

-- =============================================================================
-- CAMERAS
-- =============================================================================
-- All four read the mediamtx test server from docker-compose.yml, which loops
-- backend/videos/fire1.mp4. All four are disabled: that clip is on fire, so an
-- enabled camera raises a real OPEN alert within seconds, and its emergency
-- dialog sits over every page. To watch one live, start it from its page
-- (or POST /api/v1/cameras/{id}/start); acknowledging the alert quiets it.
INSERT INTO camera (camera_id, name, rtsp_url, location, building, floor_level, zone, area,
                    enabled, roi, settings) VALUES
    ('22222222-2222-4222-8222-000000000001',
     'Warehouse A - Loading Bay',
     'rtsp://mediamtx:8554/fire1',
     'Warehouse A, east doors',
     'Warehouse A', '1', 'Loading bay', 'Dock 3',
     FALSE, NULL, '{}'::jsonb),

    ('22222222-2222-4222-8222-000000000002',
     'Warehouse A - Racking Aisle 4',
     'rtsp://mediamtx:8554/fire1',
     'Warehouse A, high racking',
     'Warehouse A', '1', 'Storage', 'Aisle 4',
     FALSE, NULL,
     -- Smoke rises into the racking and shows faintly: count weaker boxes.
     '{"smoke_confidence": 0.4}'::jsonb),

    ('22222222-2222-4222-8222-000000000003',
     'HQ - Staff Kitchen',
     'rtsp://mediamtx:8554/fire1',
     'Head office, 2nd floor kitchen',
     'HQ', '2', 'Kitchen', 'Pantry',
     FALSE,
     -- Leave the hob out of the frame: a lit burner is not an emergency.
     '[[0, 0], [1280, 0], [1280, 420], [0, 420]]'::jsonb,
     '{"fire_confidence": 0.7, "confirm_hits": 4}'::jsonb),

    ('22222222-2222-4222-8222-000000000004',
     'HQ - Server Room',
     'rtsp://mediamtx:8554/fire1',
     'Head office, basement',
     'HQ', 'B1', 'Server room', 'Rack row A',
     FALSE, NULL,
     '{"smoke_confidence": 0.35, "cooldown_s": 300}'::jsonb)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- INCIDENTS
-- =============================================================================
-- 28 incidents over the last 14 days: two in three are fire, the loading bay
-- sees the most, and every triage outcome except OPEN is represented.
INSERT INTO fire_event (
    event_id, camera_id, kind, peak_confidence, bbox, detections, sightings,
    started_at, detected_at, last_seen_at, cleared_at,
    status, action_taken, description, acknowledged_at, resolved_at
)
SELECT md5('fs-seed-event-' || n)::uuid,
       cam.camera_id,
       kind,
       conf,
       jsonb_build_object('x1', 420 + n * 7 % 300, 'y1', 180 + n * 11 % 200,
                          'x2', 640 + n * 7 % 300, 'y2', 400 + n * 11 % 200),
       jsonb_build_array(jsonb_build_object(
           'kind', kind, 'confidence', conf,
           'box', jsonb_build_object('x1', 420 + n * 7 % 300, 'y1', 180 + n * 11 % 200,
                                     'x2', 640 + n * 7 % 300, 'y2', 400 + n * 11 % 200))),
       sightings,
       detected - interval '3 seconds',
       detected,
       detected + make_interval(secs => duration),
       detected + make_interval(secs => duration + 30),
       status,
       CASE status
           WHEN 'RESOLVED' THEN (ARRAY['Extinguished with CO2', 'Fire team attended',
                                       'Checked: controlled hot work'])[1 + n % 3]
           WHEN 'FALSE_POSITIVE' THEN (ARRAY['Sun glare on the shutter', 'Forklift beacon',
                                             'Steam from the kettle'])[1 + n % 3]
           WHEN 'ACKNOWLEDGED' THEN 'Supervisor on the way'
       END,
       CASE WHEN status = 'RESOLVED' THEN 'Seeded demo incident.' END,
       detected + make_interval(secs => 20 + n * 17 % 160),
       CASE WHEN status IN ('RESOLVED', 'FALSE_POSITIVE')
            THEN detected + make_interval(secs => 300 + n * 97 % 1500) END
FROM (
    SELECT n,
           CASE WHEN n % 3 = 0 THEN 'smoke' ELSE 'fire' END AS kind,
           round((0.55 + (n * 37 % 40) / 100.0)::numeric, 2)::real AS conf,
           4 + n * 5 % 60 AS sightings,
           date_trunc('minute', NOW()) - make_interval(hours => n * 12 + n % 5, mins => n * 7 % 60)
               AS detected,
           20 + n * 29 % 400 AS duration,
           CASE n % 5 WHEN 0 THEN 'FALSE_POSITIVE' WHEN 1 THEN 'ACKNOWLEDGED' ELSE 'RESOLVED' END
               AS status,
           -- Loading bay half the time, the rest spread over the other three.
           CASE WHEN n % 2 = 0 THEN 1 ELSE 2 + n % 3 END AS cam_no
    FROM generate_series(1, 28) AS n
) e
JOIN (VALUES (1, '22222222-2222-4222-8222-000000000001'::uuid),
             (2, '22222222-2222-4222-8222-000000000002'::uuid),
             (3, '22222222-2222-4222-8222-000000000003'::uuid),
             (4, '22222222-2222-4222-8222-000000000004'::uuid)) AS cam (cam_no, camera_id)
  USING (cam_no)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- DETECTION SAMPLES
-- =============================================================================
-- Two checks a second for the last 14 days (7200 an hour), with hits in the
-- hours that had an incident: what detection rates are computed from.
INSERT INTO detection_sample_hourly (camera_id, hour, checks, fire_hits, smoke_hits)
SELECT c.camera_id,
       h.hour,
       7200,
       COALESCE(SUM(CASE WHEN e.kind = 'fire' THEN e.sightings END), 0)
           + CASE WHEN extract(hour FROM h.hour)::int % 7 = 0 THEN 2 ELSE 0 END,
       COALESCE(SUM(CASE WHEN e.kind = 'smoke' THEN e.sightings END), 0)
FROM camera c
CROSS JOIN generate_series(date_trunc('hour', NOW()) - interval '14 days',
                           date_trunc('hour', NOW()), interval '1 hour') AS h (hour)
LEFT JOIN fire_event e
       ON e.camera_id = c.camera_id AND date_trunc('hour', e.detected_at) = h.hour
WHERE c.camera_id IN ('22222222-2222-4222-8222-000000000001',
                      '22222222-2222-4222-8222-000000000002',
                      '22222222-2222-4222-8222-000000000003',
                      '22222222-2222-4222-8222-000000000004')
GROUP BY c.camera_id, h.hour
ON CONFLICT DO NOTHING;

COMMIT;
