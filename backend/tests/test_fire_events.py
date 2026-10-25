"""Incident persistence, the alert poll and analytics against a live Postgres.

Skipped automatically when no database is reachable, so ``pytest`` stays green
without one. To run them, point the usual DB_* variables at a server that has
``database/schema.sql`` applied - for example the compose stack::

    docker compose run --rm -v ./backend/tests:/app/tests api pytest -q

No model weights are needed: incidents are built by FireMonitor from synthetic
detections, or written directly.
"""

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import List

import numpy as np
import pytest

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.services.alert_mailer import alert_mailer
from app.services.analytics_service import analytics_service
from app.services.camera_service import camera_service
from app.services.event_service import event_service
from app.services.fire_detector import Detection
from app.services.fire_monitor import CLOSED, OPENED, REOPENED, FireMonitor, FireParams
from app.services.object_store import object_store
from app.services.user_service import user_service

pytestmark = pytest.mark.asyncio


@pytest.fixture(scope="module")
async def database():
    """Connect once for the module, or skip the whole file."""
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")

    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")

    await run_migrations()
    yield
    await close_db_pool()


_CREATED: List[tuple] = []


@pytest.fixture(autouse=True)
async def cleanup_helper_rows(database):
    yield
    for table, column, identifier in _CREATED:
        await db_manager.execute_query(f"DELETE FROM {table} WHERE {column} = $1", (identifier,))
    _CREATED.clear()


@pytest.fixture
async def camera(database):
    """A throwaway camera; deleting it cascades to its incidents and samples."""
    created = await camera_service.create_camera(
        name=f"test-cam-{uuid.uuid4().hex[:8]}",
        rtsp_url="rtsp://example.invalid:8554/test",
        location="test-suite",
        building="HQ",
        floor_level="2",
        zone="Kitchen",
        enabled=False,
    )
    yield created
    await camera_service.delete_camera(created["camera_id"])
    for prefix in ("frames", "clips"):
        await object_store.remove_prefix(f"{prefix}/{created['camera_id']}/")


def _fire(confidence: float = 0.8, kind: str = "fire") -> Detection:
    return Detection(kind, confidence, (100.0, 100.0, 220.0, 260.0))


def _confirmed(kind: str = "fire", start: float = 1_700_000_000.0):
    """A FireMonitor that has just opened an incident, and that incident."""
    monitor = FireMonitor(FireParams(confirm_hits=2, confirm_window=3, clear_after_s=5, cooldown_s=60))
    events = []
    for i in range(2):
        events = monitor.update([_fire(0.7 + 0.1 * i, kind)], start + i)
    assert events and events[0].type == OPENED
    return monitor, events[0].incident


# ------------------------------------------------------------------- cameras
async def test_camera_crud_roundtrip_with_location_fields(database):
    name = f"crud-cam-{uuid.uuid4().hex[:8]}"
    created = await camera_service.create_camera(
        name=name,
        rtsp_url="rtsp://example.invalid/a",
        enabled=False,
        roi=[[0, 0], [100, 0], [100, 100]],
        settings={"fire_confidence": 0.6, "kinds": ["fire"]},
        building="Warehouse A",
    )
    try:
        fetched = await camera_service.get_camera(created["camera_id"])
        assert camera_service.parse_settings(fetched)["fire_confidence"] == 0.6
        assert len(camera_service.parse_roi(fetched)) == 3
        assert fetched["building"] == "Warehouse A"

        updated = await camera_service.update_camera(
            created["camera_id"], floor_level="1", zone="Loading bay", location="gate 2"
        )
        assert (updated["floor_level"], updated["zone"], updated["location"]) == ("1", "Loading bay", "gate 2")
        assert updated["building"] == "Warehouse A"  # untouched columns survive
    finally:
        assert await camera_service.delete_camera(created["camera_id"])


# ----------------------------------------------------------------- incidents
async def test_record_event_stores_the_incident_and_its_frame(camera, monkeypatch):
    monkeypatch.setattr(config, "minio_endpoint", "")  # frame goes to Postgres
    _, incident = _confirmed()
    frame = np.full((480, 640, 3), 90, dtype=np.uint8)

    stored = await event_service.record_event(camera["camera_id"], incident, frame, [_fire()])

    assert stored["inserted"] is True
    assert stored["kind"] == "fire"
    assert stored["workspace_id"] == camera["workspace_id"]  # trigger copied it
    assert stored["peak_confidence"] == pytest.approx(0.8)
    event = await event_service.get_event(stored["event_id"])
    assert event["live"] is True and event["cleared_at"] is None
    assert event["location_text"] == "HQ - Floor 2 - Kitchen"
    assert event["bbox"] == {"x1": 100.0, "y1": 100.0, "x2": 220.0, "y2": 260.0}
    assert event["detections"][0]["kind"] == "fire"
    assert event["frame_base64"]
    assert (await event_service.get_event_frame(stored["event_id"]))[:2] == b"\xff\xd8"


async def test_event_frame_goes_to_minio_when_it_is_up(camera):
    if not object_store.enabled or not await object_store.healthy():
        pytest.skip("MinIO not configured or not reachable")
    _, incident = _confirmed()
    stored = await event_service.record_event(
        camera["camera_id"], incident, np.zeros((240, 320, 3), np.uint8), [_fire()]
    )
    row = await db_manager.execute_query(
        "SELECT frame_key, frame_jpeg IS NOT NULL AS in_db FROM fire_event WHERE event_id = $1",
        (stored["event_id"],),
        fetch_one=True,
    )
    assert row["frame_key"] == f"frames/{camera['camera_id']}/{stored['event_id']}.jpg"
    assert not row["in_db"]
    assert (await event_service.get_event_frame(stored["event_id"]))[:2] == b"\xff\xd8"


async def test_one_live_incident_per_camera_and_kind(camera):
    _, incident = _confirmed()
    first = await event_service.record_event(camera["camera_id"], incident, None)
    again = await event_service.record_event(camera["camera_id"], incident, None)
    assert first["inserted"] and not again["inserted"]
    assert again["event_id"] == first["event_id"]

    # Smoke on the same camera is its own incident.
    _, smoke = _confirmed("smoke")
    other = await event_service.record_event(camera["camera_id"], smoke, None)
    assert other["inserted"] and other["event_id"] != first["event_id"]


async def test_incident_lifecycle_update_close_reopen(camera):
    monitor, incident = _confirmed()
    stored = await event_service.record_event(camera["camera_id"], incident, None)
    incident.event_id = stored["event_id"]
    t0 = incident.last_seen_at

    monitor.update([_fire(0.95)], t0 + 1)  # new peak
    await event_service.update_incident(incident.event_id, incident)
    event = await event_service.get_event(incident.event_id, include_frame=False)
    assert event["peak_confidence"] == pytest.approx(0.95)

    closed = monitor.update([], t0 + 7)
    assert [e.type for e in closed] == [CLOSED]
    await event_service.close_incident(incident.event_id, incident)
    event = await event_service.get_event(incident.event_id, include_frame=False)
    assert event["live"] is False and event["cleared_at"] is not None

    # Back within the cooldown: the same row is live again.
    events = [e.type for t in (t0 + 8, t0 + 9) for e in monitor.update([_fire()], t)]
    assert REOPENED in events and OPENED not in events
    await event_service.reopen(incident.event_id)
    event = await event_service.get_event(incident.event_id, include_frame=False)
    assert event["live"] is True


async def test_close_stale_ends_incidents_of_a_previous_run(camera):
    _, incident = _confirmed()
    stored = await event_service.record_event(camera["camera_id"], incident, None)
    assert await event_service.close_stale() >= 1
    event = await event_service.get_event(stored["event_id"], include_frame=False)
    assert event["cleared_at"] == event["last_seen_at"]


async def test_triage_notes_and_who_handled_it(camera):
    operator = await user_service.create_user(
        f"op-{uuid.uuid4().hex[:8]}", f"{uuid.uuid4().hex[:8]}@test.local", "Passw0rd!x", "operator"
    )
    _CREATED.append(("app_user", "user_id", operator["user_id"]))
    _, incident = _confirmed()
    event_id = (await event_service.record_event(camera["camera_id"], incident, None))["event_id"]

    acked = await event_service.update_status(
        event_id, "ACKNOWLEDGED", action_taken="Fire team called", user_id=operator["user_id"]
    )
    assert acked["acknowledged_at"] is not None and acked["acknowledged_by"] == operator["user_id"]
    assert acked["resolved_at"] is None

    done = await event_service.update_status(
        event_id, "RESOLVED", description="Extinguished", user_id=operator["user_id"]
    )
    assert done["action_taken"] == "Fire team called"  # empty notes keep the stored ones
    assert done["acknowledged_at"] == acked["acknowledged_at"]
    assert done["resolved_by"] == operator["user_id"]

    event = await event_service.get_event(event_id, include_frame=False)
    assert event["acknowledged_by_username"] == operator["username"]
    assert event["resolved_by_username"] == operator["username"]

    reopened = await event_service.update_status(event_id, "OPEN")
    assert reopened["acknowledged_at"] is None and reopened["resolved_at"] is None


async def test_active_alerts_lists_only_unacknowledged(camera):
    _, fire = _confirmed()
    _, smoke = _confirmed("smoke")
    fire_id = (await event_service.record_event(camera["camera_id"], fire, None))["event_id"]
    smoke_id = (await event_service.record_event(camera["camera_id"], smoke, None))["event_id"]
    await event_service.update_status(smoke_id, "ACKNOWLEDGED")

    active = await event_service.active_alerts(camera["workspace_id"])
    ids = [a["event_id"] for a in active["alerts"]]
    assert fire_id in ids and smoke_id not in ids
    alert = next(a for a in active["alerts"] if a["event_id"] == fire_id)
    assert alert["message"] == "🚨 FIRE ALERT: FIRE detected in HQ - Floor 2 - Kitchen"
    assert alert["camera_name"] == camera["name"]


async def test_list_filters_by_kind_status_and_live(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, "fire", now - timedelta(hours=1))
    await _insert_event(cam, "smoke", now - timedelta(hours=2), status="RESOLVED")
    await _insert_event(cam, "fire", now - timedelta(hours=3), live=True)

    async def ids(**filters):
        page = await event_service.list_events(camera_id=cam, **filters)
        return page["total"]

    assert await ids() == 3
    assert await ids(kind="fire") == 2
    assert await ids(status="RESOLVED") == 1
    assert await ids(live=True) == 1
    assert await ids(start=now - timedelta(minutes=90)) == 1

    stats = await event_service.stats(cam)
    assert (stats["total"], stats["open"], stats["live"]) == (3, 2, 1)
    assert (stats["fire_24h"], stats["smoke_24h"]) == (2, 1)


# ------------------------------------------------------------------- samples
async def test_samples_add_up_per_hour(camera):
    hour = datetime(2026, 1, 1, 10, tzinfo=timezone.utc)
    await event_service.add_samples(camera["camera_id"], [(hour, 10, 2, 1)])
    await event_service.add_samples(camera["camera_id"], [(hour, 5, 1, 0)])
    row = await db_manager.execute_query(
        "SELECT checks, fire_hits, smoke_hits FROM detection_sample_hourly WHERE camera_id = $1",
        (camera["camera_id"],),
        fetch_one=True,
    )
    assert (row["checks"], row["fire_hits"], row["smoke_hits"]) == (15, 3, 1)


# ----------------------------------------------------------------- analytics
async def test_analytics_summary_windows_and_buckets(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, "fire", now - timedelta(hours=1))
    await _insert_event(cam, "smoke", now - timedelta(days=2))
    await _insert_event(cam, "fire", now - timedelta(days=3), status="FALSE_POSITIVE")
    await _insert_event(cam, "fire", now - timedelta(days=10))  # outside a 7-day window
    await event_service.add_samples(
        cam, [(now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=2), 200, 4, 2)]
    )

    week = await analytics_service.summary(days=7, camera_id=cam, tz="UTC")

    assert week["window"]["bucket"] == "day"
    assert len(week["series"]) == 7  # zero-filled
    assert sum(p["fire"] for p in week["series"]) == 2
    assert sum(p["smoke"] for p in week["series"]) == 1
    kpis = week["kpis"]
    assert (kpis["events"], kpis["fire"], kpis["smoke"]) == (3, 2, 1)
    assert kpis["false_positive_pct"] == 33.3
    assert kpis["cameras_affected"] == 1
    assert kpis["avg_duration_s"] == pytest.approx(30.0)
    assert (kpis["checks"], kpis["fire_detection_rate"], kpis["smoke_detection_rate"]) == (200, 2.0, 1.0)
    assert sum(cell["events"] for cell in week["heatmap"]) == 3
    assert len(week["by_hour"]) == 24 and sum(h["events"] for h in week["by_hour"]) == 3
    assert len(week["by_weekday"]) == 7
    assert {row["kind"]: row["events"] for row in week["by_kind"]} == {"fire": 2, "smoke": 1}
    assert week["funnel"]["false_positives"] == 1

    day = await analytics_service.summary(days=1, camera_id=cam, tz="Africa/Cairo")
    assert day["window"]["bucket"] == "hour"
    assert len(day["series"]) == 24
    assert day["kpis"]["events"] == 1

    with pytest.raises(ValueError):
        await analytics_service.summary(days=7, tz="Not/AZone")


async def test_by_camera_location_and_high_risk(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, "fire", now - timedelta(hours=1))
    await _insert_event(cam, "fire", now - timedelta(days=1))
    await _insert_event(cam, "smoke", now - timedelta(days=1))
    await event_service.add_samples(cam, [(now.replace(minute=0, second=0, microsecond=0), 100, 6, 3)])

    data = await analytics_service.by_camera(days=7, workspace_id=camera["workspace_id"])
    row = next(r for r in data["cameras"] if r["camera_id"] == cam)
    assert (row["fire_events"], row["smoke_events"], row["total_events"]) == (2, 1, 3)
    assert row["days_with_fire"] == 2 and row["days_with_smoke"] == 1
    assert (row["fire_detection_rate"], row["smoke_detection_rate"], row["total_detection_rate"]) == (6.0, 3.0, 9.0)
    assert row["first_fire"] < row["last_fire"]
    assert data["summary"]["cameras_with_fire"] >= 1

    zones = await analytics_service.by_location("zone", days=7, workspace_id=camera["workspace_id"])
    kitchen = next(g for g in zones["groups"] if g["group_name"] == "Kitchen")
    assert kitchen["fire_events"] >= 2 and kitchen["cameras"] >= 1
    with pytest.raises(ValueError):
        await analytics_service.by_location("bogus")

    risky = await analytics_service.high_risk(8.0, days=7, workspace_id=camera["workspace_id"])
    assert cam in [r["camera_id"] for r in risky["cameras"]]
    quiet = await analytics_service.high_risk(50.0, days=7, workspace_id=camera["workspace_id"])
    # Still listed: a camera that had a fire is high-risk whatever its rate.
    assert cam in [r["camera_id"] for r in quiet["cameras"]]


async def test_confidence_audit_histogram_and_spread(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, "fire", now - timedelta(hours=1), confidence=0.92)
    await _insert_event(cam, "fire", now - timedelta(hours=2), confidence=0.55, status="RESOLVED")
    await _insert_event(cam, "smoke", now - timedelta(hours=3), confidence=0.52, status="FALSE_POSITIVE")
    await _insert_event(cam, "fire", now - timedelta(days=10), confidence=0.7)  # outside

    audit = await analytics_service.confidence_audit(days=7, camera_id=cam, tz="UTC")
    summary = audit["summary"]
    assert summary["events"] == 3
    assert summary["max_confidence"] == pytest.approx(0.92)
    # The threshold is 0.5, so "low" means under 0.6.
    assert summary["low_confidence"] == 2
    assert summary["avg_confidence_false_positive"] == pytest.approx(0.52)
    assert len(audit["histogram"]) == 10
    assert audit["histogram"][5]["count"] == 2 and audit["histogram"][5]["false_positives"] == 1
    assert [round(e["confidence"], 2) for e in audit["latest"]] == [0.92, 0.55, 0.52]


# --------------------------------------------------------------------- email
async def test_alert_email_carries_insighteyes_wording(camera):
    event = {
        "event_id": uuid.uuid4(),
        "kind": "smoke",
        "peak_confidence": 0.71,
        "detected_at": datetime(2026, 10, 24, 9, 30, tzinfo=timezone.utc),
    }
    message = alert_mailer.message(camera, event, ["a@test.local", "b@test.local"])
    assert message["Subject"] == f"🚨 URGENT: SMOKE DETECTED - {camera['name']}"
    assert message["To"] == "a@test.local, b@test.local"
    body = message.get_body(("plain",)).get_content()
    assert "🚨 SMOKE ALERT: SMOKE detected in HQ - Floor 2 - Kitchen" in body
    assert "2026-10-24 09:30:00 UTC" in body and "71%" in body


async def test_alert_email_is_off_without_smtp_and_rate_limited(camera, monkeypatch):
    sent = []

    async def fake_send(cam, event):
        sent.append(event["event_id"])

    monkeypatch.setattr(alert_mailer, "_send", fake_send)
    event = {"event_id": uuid.uuid4(), "kind": "fire", "workspace_id": camera["workspace_id"]}

    monkeypatch.setattr(config, "smtp_host", "")
    alert_mailer.notify(camera, event)
    monkeypatch.setattr(config, "smtp_host", "smtp.test.local")
    alert_mailer.notify(camera, event)
    alert_mailer.notify(camera, {**event, "event_id": uuid.uuid4()})  # within the cooldown
    await asyncio.sleep(0)
    assert sent == [event["event_id"]]


async def test_alert_recipients_are_the_workspace_members(camera):
    from app.services.workspace_service import workspace_service

    workspace = await workspace_service.create(f"ws-{uuid.uuid4().hex[:8]}", None, None)
    _CREATED.append(("workspace", "workspace_id", workspace["workspace_id"]))
    member = await user_service.create_user(
        f"m-{uuid.uuid4().hex[:8]}", f"{uuid.uuid4().hex[:8]}@member.local", "Passw0rd!x", "viewer"
    )
    _CREATED.append(("app_user", "user_id", member["user_id"]))
    await workspace_service.add_member(workspace["workspace_id"], member["user_id"])
    assert await alert_mailer.recipients(workspace["workspace_id"]) == [member["email"]]


# ------------------------------------------------------------------- helpers
async def _insert_event(
    camera_id, kind: str, detected_at: datetime, status: str = "OPEN", confidence=0.8, live=False
):
    """A 30-second incident; the camera fixture's cascade removes it."""
    await db_manager.execute_query(
        """
        INSERT INTO fire_event (
            camera_id, kind, peak_confidence, bbox, started_at, detected_at, last_seen_at,
            cleared_at, status
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz,
                $5::timestamptz + interval '30 seconds',
                CASE WHEN $6 THEN NULL ELSE $5::timestamptz + interval '30 seconds' END, $7)
        """,
        (
            camera_id,
            kind,
            confidence,
            json.dumps({"x1": 0, "y1": 0, "x2": 50, "y2": 50}),
            detected_at,
            live,
            status,
        ),
    )
