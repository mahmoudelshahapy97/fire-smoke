# app/services/event_service.py
"""Persistence for fire / smoke incidents and the hourly detection samples."""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from uuid import UUID

import numpy as np

from app.core.database import db_manager
from app.services import media_service
from app.services.fire_detector import Detection
from app.services.fire_monitor import Incident
from app.services.object_store import frame_key
from app.utils.image_utils import annotate_fire, bytes_to_base64, encode_jpeg

logger = logging.getLogger(__name__)

# What the alert poll returns at most: more than this is a site-wide emergency
# and the console shows the count.
ACTIVE_ALERT_LIMIT = 20

# Location text for alerts, as InsightEye builds it: building - Floor n - zone -
# area, falling back to the free-form location.
LOCATION_SQL = """
    COALESCE(
        NULLIF(concat_ws(' - ',
            NULLIF(c.building, ''),
            'Floor ' || NULLIF(c.floor_level, ''),
            NULLIF(c.zone, ''),
            NULLIF(c.area, '')), ''),
        NULLIF(c.location, ''),
        'Unknown location')
"""


def _to_datetime(epoch: Optional[float]) -> Optional[datetime]:
    return datetime.fromtimestamp(epoch, tz=timezone.utc) if epoch else None


def _box_json(box: Optional[Sequence[float]]) -> Optional[str]:
    if not box:
        return None
    x1, y1, x2, y2 = box
    return json.dumps({"x1": x1, "y1": y1, "x2": x2, "y2": y2})


class EventService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    # -------------------------------------------------------------- ingestion
    async def record_event(
        self,
        camera_id: UUID,
        incident: Incident,
        frame: Optional[np.ndarray] = None,
        detections: Sequence[Detection] = (),
    ) -> Optional[Dict[str, Any]]:
        """Store a newly confirmed incident and its annotated frame.

        At most one incident per camera and kind is live (idx_fire_event_live),
        so recording is idempotent: a second call while it is still live
        returns that row with ``inserted`` False, and no second alert goes out.
        """
        stored = await self.db_manager.execute_query(
            """
            INSERT INTO fire_event (
                camera_id, kind, peak_confidence, bbox, detections, sightings,
                started_at, last_seen_at
            )
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
            ON CONFLICT (camera_id, kind) WHERE cleared_at IS NULL
            DO UPDATE SET last_seen_at = GREATEST(fire_event.last_seen_at, EXCLUDED.last_seen_at)
            RETURNING event_id, camera_id, workspace_id, kind, peak_confidence, bbox,
                      started_at, detected_at, last_seen_at, status, (xmax = 0) AS inserted
            """,
            (
                camera_id,
                incident.kind,
                incident.peak_confidence,
                _box_json(incident.peak_box),
                json.dumps(incident.detections),
                incident.sightings,
                _to_datetime(incident.started_at),
                _to_datetime(incident.last_seen_at),
            ),
            fetch_one=True,
        )
        if not stored:
            return None
        if not stored["inserted"]:
            logger.debug("Camera %s already has a live %s incident.", camera_id, incident.kind)
            return stored

        if frame is not None:
            annotated = annotate_fire(frame, detections, incident.kind)
            await media_service.save_image(
                media_service.EVENT_FRAME,
                stored["event_id"],
                frame_key(camera_id, stored["event_id"]),
                encode_jpeg(annotated),
            )
        logger.warning(
            "%s detected on camera %s (event %s, confidence %.2f)",
            incident.kind.upper(),
            camera_id,
            stored["event_id"],
            incident.peak_confidence,
        )
        return stored

    async def update_incident(self, event_id: UUID, incident: Incident) -> None:
        """Write back the latest sighting and the peak so far."""
        await self.db_manager.execute_query(
            """
            UPDATE fire_event
            SET last_seen_at    = GREATEST(last_seen_at, $2),
                peak_confidence = GREATEST(COALESCE(peak_confidence, 0), $3),
                bbox            = CASE WHEN $3 > COALESCE(peak_confidence, 0) THEN $4::jsonb ELSE bbox END,
                detections      = CASE WHEN $3 > COALESCE(peak_confidence, 0) THEN $5::jsonb ELSE detections END,
                sightings       = GREATEST(sightings, $6)
            WHERE event_id = $1
            """,
            (
                event_id,
                _to_datetime(incident.last_seen_at),
                incident.peak_confidence,
                _box_json(incident.peak_box),
                json.dumps(incident.detections),
                incident.sightings,
            ),
        )

    async def reopen(self, event_id: UUID) -> None:
        """Seen again within the cooldown: the same incident is live again."""
        await self.db_manager.execute_query(
            "UPDATE fire_event SET cleared_at = NULL WHERE event_id = $1", (event_id,)
        )

    async def close_incident(self, event_id: UUID, incident: Incident) -> None:
        await self.db_manager.execute_query(
            """
            UPDATE fire_event
            SET cleared_at = $2, last_seen_at = GREATEST(last_seen_at, $3), sightings = GREATEST(sightings, $4)
            WHERE event_id = $1
            """,
            (
                event_id,
                _to_datetime(incident.closed_at),
                _to_datetime(incident.last_seen_at),
                incident.sightings,
            ),
        )

    async def close_stale(self) -> int:
        """Close incidents left live by a previous process: nobody is watching
        them any more. They are marked cleared at their last sighting."""
        count = await self.db_manager.execute_query(
            "UPDATE fire_event SET cleared_at = last_seen_at WHERE cleared_at IS NULL",
            return_rowcount=True,
        )
        if count:
            logger.info("Closed %s incident(s) left live by the previous run.", count)
        return count or 0

    async def add_samples(
        self, camera_id: UUID, rows: Iterable[Tuple[datetime, int, int, int]]
    ) -> None:
        """Add (hour, checks, fire_hits, smoke_hits) to the camera's hourly counts."""
        rows = list(rows)
        if not rows:
            return
        await self.db_manager.execute_many(
            """
            INSERT INTO detection_sample_hourly (camera_id, hour, checks, fire_hits, smoke_hits)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (camera_id, hour) DO UPDATE
            SET checks     = detection_sample_hourly.checks + EXCLUDED.checks,
                fire_hits  = detection_sample_hourly.fire_hits + EXCLUDED.fire_hits,
                smoke_hits = detection_sample_hourly.smoke_hits + EXCLUDED.smoke_hits
            """,
            [(camera_id, hour, checks, fire, smoke) for hour, checks, fire, smoke in rows],
        )

    # ---------------------------------------------------------------- queries
    async def list_events(
        self,
        camera_id: Optional[UUID] = None,
        status: Optional[str] = None,
        kind: Optional[str] = None,
        live: Optional[bool] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        include_frame: bool = False,
        page: int = 1,
        per_page: int = 20,
        workspace_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        conditions: List[str] = []
        params: List[Any] = []

        def add(condition: str, value: Any) -> None:
            params.append(value)
            conditions.append(condition.format(n=len(params)))

        if workspace_id:
            add("e.workspace_id = ${n}", workspace_id)
        if camera_id:
            add("e.camera_id = ${n}", camera_id)
        if status:
            add("e.status = ${n}", status)
        if kind:
            add("e.kind = ${n}", kind)
        if live is not None:
            conditions.append("e.cleared_at IS NULL" if live else "e.cleared_at IS NOT NULL")
        if start:
            add("e.detected_at >= ${n}", start)
        if end:
            add("e.detected_at <= ${n}", end)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS total FROM fire_event e {where}",
            tuple(params),
            fetch_one=True,
        )

        frame_column = ", e.frame_key, e.frame_jpeg" if include_frame else ""
        params.extend([per_page, (page - 1) * per_page])
        rows = await self.db_manager.execute_query(
            f"""
            SELECT e.event_id, e.camera_id, c.name AS camera_name, {LOCATION_SQL} AS location_text,
                   e.kind, e.peak_confidence, e.bbox, e.sightings,
                   e.started_at, e.detected_at, e.last_seen_at, e.cleared_at,
                   (e.cleared_at IS NULL) AS live, e.status,
                   e.action_taken, e.description, e.acknowledged_at, e.resolved_at,
                   a.username AS acknowledged_by_username,
                   u.username AS resolved_by_username,
                   (e.clip_key IS NOT NULL OR e.clip_path IS NOT NULL) AS has_clip{frame_column}
            FROM fire_event e
            LEFT JOIN camera c ON c.camera_id = e.camera_id
            LEFT JOIN app_user a ON a.user_id = e.acknowledged_by
            LEFT JOIN app_user u ON u.user_id = e.resolved_by
            {where}
            ORDER BY e.detected_at DESC, e.event_id
            LIMIT ${len(params) - 1} OFFSET ${len(params)}
            """,
            tuple(params),
            fetch_all=True,
        )

        return {
            "total": total["total"] if total else 0,
            "page": page,
            "per_page": per_page,
            "events": [self._serialize_event(await self._with_frame(row)) for row in rows],
        }

    async def get_event(
        self, event_id: UUID, include_frame: bool = True
    ) -> Optional[Dict[str, Any]]:
        row = await self.db_manager.execute_query(
            f"""
            SELECT e.*, (e.clip_key IS NOT NULL OR e.clip_path IS NOT NULL) AS has_clip,
                   (e.cleared_at IS NULL) AS live,
                   c.name AS camera_name, {LOCATION_SQL} AS location_text,
                   a.username AS acknowledged_by_username,
                   u.username AS resolved_by_username
            FROM fire_event e
            LEFT JOIN camera c ON c.camera_id = e.camera_id
            LEFT JOIN app_user a ON a.user_id = e.acknowledged_by
            LEFT JOIN app_user u ON u.user_id = e.resolved_by
            WHERE e.event_id = $1
            """,
            (event_id,),
            fetch_one=True,
        )
        if not row:
            return None
        if not include_frame:
            row = {k: v for k, v in row.items() if k not in ("frame_jpeg", "frame_key")}
        return self._serialize_event(await self._with_frame(row))

    async def active_alerts(self, workspace_id: UUID) -> Dict[str, Any]:
        """Alerts nobody has acknowledged yet, newest first: what the console's
        emergency dialog shows. Cheap enough to poll every few seconds."""
        rows = await self.db_manager.execute_query(
            f"""
            SELECT e.event_id, e.camera_id, c.name AS camera_name, {LOCATION_SQL} AS location_text,
                   e.kind, e.peak_confidence, e.started_at, e.detected_at, e.last_seen_at,
                   (e.cleared_at IS NULL) AS live,
                   COUNT(*) OVER () AS total
            FROM fire_event e
            LEFT JOIN camera c ON c.camera_id = e.camera_id
            WHERE e.workspace_id = $1 AND e.status = 'OPEN'
            ORDER BY e.detected_at DESC, e.event_id
            LIMIT {ACTIVE_ALERT_LIMIT}
            """,
            (workspace_id,),
            fetch_all=True,
        )
        total = rows[0]["total"] if rows else 0
        alerts = []
        for row in rows:
            alert = dict(row)
            alert.pop("total", None)
            alert["message"] = self.alert_message(alert["kind"], alert["location_text"])
            alerts.append(alert)
        return {"count": total, "alerts": alerts}

    @staticmethod
    def alert_message(kind: str, location_text: Optional[str]) -> str:
        """InsightEye's alert text, kept word for word."""
        return f"🚨 {kind.upper()} ALERT: {kind.upper()} detected in {location_text or 'Unknown location'}"

    @staticmethod
    async def _with_frame(row: Dict[str, Any]) -> Dict[str, Any]:
        """Swap the frame's key/bytes for the image itself (from MinIO when it is there)."""
        if "frame_key" not in row and "frame_jpeg" not in row:
            return row
        row = dict(row)
        row["frame_jpeg"] = await media_service.load(row.pop("frame_key", None), row.get("frame_jpeg"))
        return row

    async def get_event_frame(self, event_id: UUID) -> Optional[bytes]:
        return await media_service.load_image(media_service.EVENT_FRAME, event_id)

    async def set_clip_path(self, event_id: UUID, clip_path: Optional[str]) -> None:
        """Clip kept on disk (MinIO was unreachable)."""
        await self.db_manager.execute_query(
            "UPDATE fire_event SET clip_path = $1 WHERE event_id = $2",
            (clip_path, event_id),
        )

    async def set_clip_key(self, event_id: UUID, clip_key: Optional[str]) -> None:
        await self.db_manager.execute_query(
            "UPDATE fire_event SET clip_key = $1 WHERE event_id = $2",
            (clip_key, event_id),
        )

    async def get_clip_location(self, event_id: UUID) -> Tuple[Optional[str], Optional[str]]:
        """(MinIO key, on-disk path) of the event's clip; either may be None."""
        row = await self.db_manager.execute_query(
            "SELECT clip_key, clip_path FROM fire_event WHERE event_id = $1",
            (event_id,),
            fetch_one=True,
        )
        return (row["clip_key"], row["clip_path"]) if row else (None, None)

    async def update_status(
        self,
        event_id: UUID,
        status: str,
        action_taken: Optional[str] = None,
        description: Optional[str] = None,
        user_id: Optional[UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """Acknowledge, resolve or dismiss an alert, keeping how it was handled.

        Notes left empty keep what was there. Leaving OPEN stamps acknowledged_at
        and acknowledged_by once; RESOLVED / FALSE_POSITIVE stamp resolved_at and
        resolved_by. Back to OPEN clears both, so the alert shows again.
        """
        return await self.db_manager.execute_query(
            """
            UPDATE fire_event
            SET status          = $1::text,
                action_taken    = COALESCE($3, action_taken),
                description     = COALESCE($4, description),
                acknowledged_at = CASE WHEN $1::text <> 'OPEN'
                                       THEN COALESCE(acknowledged_at, NOW()) END,
                acknowledged_by = CASE WHEN $1::text <> 'OPEN'
                                       THEN COALESCE(acknowledged_by, $5::uuid) END,
                resolved_at     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                                       THEN COALESCE(resolved_at, NOW()) END,
                resolved_by     = CASE WHEN $1::text IN ('RESOLVED', 'FALSE_POSITIVE')
                                       THEN COALESCE($5::uuid, resolved_by) END
            WHERE event_id = $2
            RETURNING event_id, status, action_taken, description,
                      acknowledged_at, acknowledged_by, resolved_at, resolved_by
            """,
            (status, event_id, action_taken, description, user_id),
            fetch_one=True,
        )

    async def stats(
        self, camera_id: Optional[UUID] = None, workspace_id: Optional[UUID] = None
    ) -> Dict[str, Any]:
        conditions: List[str] = []
        params: List[Any] = []
        for column, value in (("workspace_id", workspace_id), ("camera_id", camera_id)):
            if value:
                params.append(value)
                conditions.append(f"{column} = ${len(params)}")
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        row = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
                   COUNT(*) FILTER (WHERE cleared_at IS NULL) AS live,
                   COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '24 hours') AS last_24h,
                   COUNT(*) FILTER (WHERE kind = 'fire'
                                    AND detected_at > NOW() - INTERVAL '24 hours') AS fire_24h,
                   COUNT(*) FILTER (WHERE kind = 'smoke'
                                    AND detected_at > NOW() - INTERVAL '24 hours') AS smoke_24h,
                   MAX(detected_at) AS last_event_at
            FROM fire_event {where}
            """,
            tuple(params),
            fetch_one=True,
        )
        return row or {}

    # ------------------------------------------------------------ serializing
    @staticmethod
    def _serialize_event(row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not row:
            return {}
        event = dict(row)
        # Storage details stay server-side; clients get has_clip and fetch the
        # file through /events/{id}/clip.
        for column in ("clip_path", "clip_key", "frame_key"):
            event.pop(column, None)
        for column in ("bbox", "detections"):
            value = event.get(column)
            if isinstance(value, str):
                try:
                    event[column] = json.loads(value)
                except json.JSONDecodeError:
                    event[column] = None
        if "frame_jpeg" in event:
            event["frame_base64"] = bytes_to_base64(event.pop("frame_jpeg"))
        return event


event_service = EventService()
