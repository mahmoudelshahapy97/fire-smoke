"""FireMonitor: when sightings become an incident, and when it ends.

Synthetic detections on a synthetic clock: no model, no camera, no database.
"""

from app.services.fire_detector import Detection
from app.services.fire_monitor import (
    CLEAR,
    CLOSED,
    HEARTBEAT_S,
    OPENED,
    REOPENED,
    UPDATED,
    FireMonitor,
    FireParams,
)

BOX = (10.0, 10.0, 60.0, 80.0)


def fire(confidence: float = 0.7) -> Detection:
    return Detection("fire", confidence, BOX)


def smoke(confidence: float = 0.7) -> Detection:
    return Detection("smoke", confidence, BOX)


def monitor(**overrides) -> FireMonitor:
    params = dict(confirm_hits=3, confirm_window=5, clear_after_s=10.0, cooldown_s=60.0)
    params.update(overrides)
    return FireMonitor(FireParams(**params))


def feed(m: FireMonitor, frames, start: float = 0.0, step: float = 0.5):
    """Run ``frames`` (a list of detection lists) through ``m``; returns [(t, type, kind)]."""
    out = []
    for i, detections in enumerate(frames):
        t = start + i * step
        out.extend((t, e.type, e.kind) for e in m.update(detections, t))
    return out


def test_a_single_flicker_is_not_an_incident():
    m = monitor()
    assert feed(m, [[fire()], [], [], [fire()], [], [], []]) == []
    assert m.status == CLEAR


def test_three_sightings_in_five_checks_open_one_incident():
    m = monitor()
    events = feed(m, [[fire()], [], [fire()], [], [fire()]])
    assert events == [(2.0, OPENED, "fire")]
    assert m.status == "fire"
    incident = m.snapshot()["incidents"][0]
    # It started with the first sighting of the confirming run.
    assert incident["started_at"] == 0.0 and incident["sightings"] == 3


def test_sightings_anywhere_in_the_window_count():
    m = monitor(confirm_hits=2, confirm_window=5)
    assert feed(m, [[fire()], [], [], []]) == []
    assert feed(m, [[fire()]], start=2.0) == [(2.0, OPENED, "fire")]


def test_staying_in_view_does_not_alert_again():
    m = monitor()
    events = feed(m, [[fire()]] * 40)
    assert [e for e in events if e[1] == OPENED] == [(1.0, OPENED, "fire")]
    # last_seen is refreshed periodically, not on every frame
    updates = [e for e in events if e[1] == UPDATED]
    assert 0 < len(updates) <= 40 * 0.5 / HEARTBEAT_S + 1


def test_a_higher_peak_is_reported():
    m = monitor()
    feed(m, [[fire(0.6)]] * 3)
    events = m.update([fire(0.9)], 1.6)
    assert [e.type for e in events] == [UPDATED]
    assert events[0].incident.peak_confidence == 0.9


def test_incident_closes_after_clear_after_s_without_sightings():
    m = monitor()
    feed(m, [[fire()]] * 3)  # opens at 1.0, last seen 1.0
    assert m.update([], 10.5) == []
    events = m.update([], 11.0)
    assert [e.type for e in events] == [CLOSED]
    assert events[0].incident.closed_at == 11.0
    assert m.status == CLEAR


def test_back_within_the_cooldown_reopens_the_same_incident():
    m = monitor()
    feed(m, [[fire()]] * 3)
    first = m.update([], 20.0)[0].incident
    events = feed(m, [[fire()]] * 3, start=30.0)
    assert (31.0, REOPENED, "fire") in events
    assert OPENED not in [e[1] for e in events]
    assert m.snapshot()["incidents"][0]["active"] is True
    assert m._incident["fire"] is first


def test_back_after_the_cooldown_is_a_new_incident():
    m = monitor()
    feed(m, [[fire()]] * 3)
    m.update([], 20.0)
    events = feed(m, [[fire()]] * 3, start=100.0)
    assert events[0] == (101.0, OPENED, "fire")


def test_fire_and_smoke_are_separate_incidents_and_fire_wins():
    m = monitor()
    events = feed(m, [[smoke()]] * 3)
    assert events == [(1.0, OPENED, "smoke")]
    assert m.status == "smoke"
    events = feed(m, [[smoke(), fire()]] * 3, start=1.5)
    assert (2.5, OPENED, "fire") in events
    assert m.status == "fire"


def test_disabled_kinds_are_ignored():
    m = FireMonitor(FireParams(confirm_hits=1, confirm_window=1), kinds=["fire"])
    assert feed(m, [[smoke()]] * 5) == []
    assert "smoke" not in m.snapshot()["pending"]


def test_reset_forgets_pending_sightings_but_keeps_incidents():
    m = monitor()
    feed(m, [[fire()], [fire()]])
    m.reset()
    assert feed(m, [[fire()]], start=1.0) == []  # 1 of 1, not 3 of 5
    feed(m, [[fire()]] * 3, start=2.0)
    m.reset()
    assert m.status == "fire"


def test_close_all_ends_every_live_incident():
    m = monitor(confirm_hits=1, confirm_window=1)
    feed(m, [[fire(), smoke()]])
    events = m.close_all(5.0)
    assert sorted(e.kind for e in events) == ["fire", "smoke"]
    assert all(e.type == CLOSED for e in events)
    assert m.close_all(6.0) == []


def test_params_from_camera_settings():
    params = FireParams.from_settings(
        {"confirm_hits": 9, "confirm_window": 4, "cooldown_s": 30, "kinds": ["fire"], "enabled": True}
    )
    assert params.confirm_window == 4
    assert params.confirm_hits == 4  # never more than the window
    assert params.cooldown_s == 30.0
