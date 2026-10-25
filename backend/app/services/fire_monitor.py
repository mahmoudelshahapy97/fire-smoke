# app/services/fire_monitor.py
"""Turns per-frame fire / smoke sightings into incidents.

A single detection is never an alarm: flames are confused with sunsets, brake
lights and orange jackets, and those confusions rarely last. Per kind:

    PENDING     sightings counted over the last ``confirm_window`` inferences
    ACTIVE      ``confirm_hits`` of them were positive: the incident opens and
                the alert goes out (one event row, frame, clip, email)
    CLEARED     not seen for ``clear_after_s``: the incident closes

A kind confirmed again within ``cooldown_s`` of its incident closing reopens
that incident rather than raising a second alert -- smoke drifting in and out
of view is one fire, not ten. (InsightEye kept a 10-minute per-camera cooldown
in fire_detection_state; this is the same rule, per kind.)

The camera's live status is the most severe active kind: fire beats smoke, as
in InsightEye.

Pure Python: unit-tested with synthetic detection sequences and no camera.
"""

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Sequence
from uuid import UUID

from app.core.config import config
from app.services.fire_detector import FIRE, KINDS, SMOKE, Detection

logger = logging.getLogger(__name__)

CLEAR = "clear"

# Event types emitted by FireMonitor.update()
OPENED = "opened"        # new incident: record it and alert
REOPENED = "reopened"    # same incident back within the cooldown: no new alert
UPDATED = "updated"      # new peak confidence, or a periodic last-seen refresh
CLOSED = "closed"        # not seen for clear_after_s

# How often an active incident's last_seen_at is written back even when the
# peak has not changed, so the console shows it as still burning.
HEARTBEAT_S = 10.0


@dataclass
class FireParams:
    confirm_hits: int = field(default_factory=lambda: config.fire_confirm_hits)
    confirm_window: int = field(default_factory=lambda: config.fire_confirm_window)
    clear_after_s: float = field(default_factory=lambda: config.fire_clear_after_s)
    cooldown_s: float = field(default_factory=lambda: config.fire_cooldown_s)

    @classmethod
    def from_settings(cls, settings: Optional[Dict] = None) -> "FireParams":
        """Global values, with any numeric key of the camera's settings on top."""
        params = cls()
        for key, value in (settings or {}).items():
            if hasattr(params, key) and isinstance(value, (int, float)) and not isinstance(value, bool):
                setattr(params, key, type(getattr(params, key))(value))
        params.confirm_window = max(1, params.confirm_window)
        params.confirm_hits = max(1, min(params.confirm_hits, params.confirm_window))
        return params


@dataclass
class Incident:
    kind: str
    started_at: float
    last_seen_at: float
    peak_confidence: float
    peak_box: Any
    detections: List[Dict[str, Any]]
    event_id: Optional[UUID] = None
    closed_at: Optional[float] = None
    sightings: int = 0
    _last_written_at: float = 0.0

    @property
    def active(self) -> bool:
        return self.closed_at is None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "event_id": str(self.event_id) if self.event_id else None,
            "active": self.active,
            "started_at": self.started_at,
            "last_seen_at": self.last_seen_at,
            "closed_at": self.closed_at,
            "peak_confidence": round(self.peak_confidence, 4),
            "sightings": self.sightings,
        }


@dataclass
class FireEvent:
    type: str
    incident: Incident

    @property
    def kind(self) -> str:
        return self.incident.kind


class FireMonitor:
    def __init__(self, params: Optional[FireParams] = None, kinds: Sequence[str] = KINDS) -> None:
        self.params = params or FireParams()
        self.kinds = [k for k in KINDS if k in kinds]
        self._window: Dict[str, Deque[Optional[float]]] = {}
        self._incident: Dict[str, Incident] = {}
        self.reset()

    def reset(self) -> None:
        """Forget pending sightings (e.g. after a reconnect). Incidents are kept:
        a fire does not go out because the stream dropped; it closes once it is
        no longer seen."""
        self._window = {k: deque(maxlen=self.params.confirm_window) for k in self.kinds}

    # ----------------------------------------------------------------- update
    def update(self, detections: Sequence[Detection], ts: float) -> List[FireEvent]:
        """Feed one inference's detections (already filtered); returns what changed."""
        events: List[FireEvent] = []
        for kind in self.kinds:
            hits = [d for d in detections if d.kind == kind]
            window = self._window[kind]
            window.append(ts if hits else None)
            incident = self._incident.get(kind)

            if incident is not None and incident.active:
                if hits:
                    events.extend(self._seen(incident, hits, ts))
                elif ts - incident.last_seen_at >= self.params.clear_after_s:
                    incident.closed_at = ts
                    # Sightings from before it cleared must not re-confirm it.
                    window.clear()
                    events.append(FireEvent(CLOSED, incident))
                continue

            confirmed = sum(1 for t in window if t is not None) >= self.params.confirm_hits
            if not confirmed:
                continue

            best = max(hits, key=lambda d: d.confidence) if hits else None
            if best is None:
                continue  # confirmed on earlier frames, but absent now: wait for the next sighting
            if (
                incident is not None
                and incident.closed_at is not None
                and ts - incident.closed_at < self.params.cooldown_s
            ):
                incident.closed_at = None
                events.append(FireEvent(REOPENED, incident))
                events.extend(self._seen(incident, hits, ts))
                continue

            first = next(t for t in window if t is not None)
            incident = Incident(
                kind=kind,
                started_at=first,
                last_seen_at=ts,
                peak_confidence=best.confidence,
                peak_box=best.box,
                detections=[d.as_dict() for d in hits],
                sightings=sum(1 for t in window if t is not None),
                _last_written_at=ts,
            )
            self._incident[kind] = incident
            events.append(FireEvent(OPENED, incident))
        return events

    def _seen(self, incident: Incident, hits: Sequence[Detection], ts: float) -> List[FireEvent]:
        incident.last_seen_at = ts
        incident.sightings += 1
        best = max(hits, key=lambda d: d.confidence)
        changed = best.confidence > incident.peak_confidence
        if changed:
            incident.peak_confidence = best.confidence
            incident.peak_box = best.box
            incident.detections = [d.as_dict() for d in hits]
        if changed or ts - incident._last_written_at >= HEARTBEAT_S:
            incident._last_written_at = ts
            return [FireEvent(UPDATED, incident)]
        return []

    def close_all(self, ts: float) -> List[FireEvent]:
        """Close every active incident (the worker is stopping)."""
        events = []
        for incident in self._incident.values():
            if incident.active:
                incident.closed_at = ts
                events.append(FireEvent(CLOSED, incident))
        return events

    # ------------------------------------------------------------------ state
    @property
    def status(self) -> str:
        """fire | smoke | clear -- the most severe active kind."""
        for kind in (FIRE, SMOKE):
            incident = self._incident.get(kind)
            if incident is not None and incident.active:
                return kind
        return CLEAR

    def snapshot(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "pending": {
                k: sum(1 for t in self._window[k] if t is not None) for k in self.kinds
            },
            "incidents": [i.as_dict() for i in self._incident.values()],
        }
