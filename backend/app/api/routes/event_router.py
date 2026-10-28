# app/api/routes/event_router.py
import csv
import io
import logging
from datetime import datetime
from typing import Any, Dict, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from fastapi.responses import FileResponse, StreamingResponse

from app.api.deps import (
    ensure_in_workspace,
    ensure_visible_resource,
    get_image_viewer,
    get_workspace_id,
    require_role,
)
from app.schemas.event_schemas import ActiveAlerts, EventKind, EventListResponse, EventStatus, EventStatusUpdate
from app.services.audit_service import csv_safe
from app.services.event_service import event_service
from app.services.object_store import object_store
from app.services.stream_manager import clip_root
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["events"], prefix="/events")
alerts_router = APIRouter(tags=["alerts"], prefix="/alerts")


@alerts_router.get("/active", response_model=ActiveAlerts)
async def active_alerts(
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Alerts in the active workspace that nobody has acknowledged yet, newest
    first. The console polls this every few seconds for its emergency dialog."""
    return await event_service.active_alerts(workspace_id)


@router.get("", response_model=EventListResponse)
async def list_events(
    camera_id: Optional[UUID] = Query(None),
    status_filter: Optional[EventStatus] = Query(None, alias="status"),
    kind: Optional[EventKind] = Query(None, description="fire | smoke"),
    live: Optional[bool] = Query(None, description="true = still being seen, false = cleared"),
    start: Optional[datetime] = Query(None, description="ISO8601 lower bound on detected_at"),
    end: Optional[datetime] = Query(None, description="ISO8601 upper bound on detected_at"),
    include_frame: bool = Query(False, description="Embed the annotated frame as base64"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Fire and smoke incidents in the active workspace, newest first."""
    try:
        return await event_service.list_events(
            camera_id=camera_id,
            status=status_filter.value if status_filter else None,
            kind=kind.value if kind else None,
            live=live,
            start=start,
            end=end,
            include_frame=include_frame,
            page=page,
            per_page=per_page,
            workspace_id=workspace_id,
        )
    except Exception as e:
        logger.error("Error listing events: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not list events."
        )


@router.get("/stats")
async def event_stats(
    camera_id: Optional[UUID] = Query(None),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Totals used by dashboards: all-time, unacknowledged, still live, and last 24 hours."""
    try:
        return create_response(
            True, "Event statistics.", await event_service.stats(camera_id, workspace_id)
        )
    except Exception as e:
        logger.error("Error computing event stats: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not compute stats."
        )


EXPORT_LIMIT = 50_000
_EXPORT_COLUMNS = [
    "event_id", "detected_at", "camera_name", "kind", "status", "live", "peak_confidence",
    "sightings", "last_seen_at", "cleared_at", "acknowledged_at", "acknowledged_by_username",
    "resolved_at", "action_taken", "description", "has_clip",
]


@router.get("/export.csv")
async def export_events(
    camera_id: Optional[UUID] = Query(None),
    status_filter: Optional[EventStatus] = Query(None, alias="status"),
    kind: Optional[EventKind] = Query(None),
    live: Optional[bool] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Response:
    """The Incidents list's filters as CSV, newest first, up to 50,000 rows."""
    page = await event_service.list_events(
        camera_id=camera_id,
        status=status_filter.value if status_filter else None,
        kind=kind.value if kind else None,
        live=live,
        start=start,
        end=end,
        page=1,
        per_page=EXPORT_LIMIT,
        workspace_id=workspace_id,
    )
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(_EXPORT_COLUMNS)
    for event in page["events"]:
        writer.writerow(
            [v.isoformat() if isinstance(v, datetime) else v for v in (event.get(c) for c in _EXPORT_COLUMNS)]
        )
    return Response(
        content=csv_safe(out.getvalue()),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="incidents.csv"'},
    )


@router.get("/{event_id}")
async def get_event(
    event_id: UUID,
    include_frame: bool = Query(True),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    await ensure_in_workspace("event", event_id, workspace_id, "Event not found.")
    event = await event_service.get_event(event_id, include_frame=include_frame)
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found.")
    return event


@router.get(
    "/{event_id}/frame",
    responses={200: {"content": {"image/jpeg": {}}, "description": "Annotated alert frame"}},
)
async def get_event_frame(
    event_id: UUID, current_user: Dict[str, Any] = Depends(get_image_viewer)
) -> Response:
    """The annotated frame captured at the moment the incident was confirmed."""
    await ensure_visible_resource(current_user, "event", event_id)
    jpeg = await event_service.get_event_frame(event_id)
    if not jpeg:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No frame stored for this event."
        )
    return Response(content=jpeg, media_type="image/jpeg")


@router.get(
    "/{event_id}/clip",
    responses={200: {"content": {"video/mp4": {}}, "description": "Evidence clip"}},
)
async def get_event_clip(
    event_id: UUID,
    range_header: Optional[str] = Header(None, alias="Range"),
    current_user: Dict[str, Any] = Depends(get_image_viewer),
) -> Response:
    """Annotated mp4 from before the incident was confirmed until after it.

    Served with Range support, so a ``<video>`` element can seek - from MinIO,
    or from disk for a clip saved while MinIO was unreachable.
    """
    await ensure_visible_resource(current_user, "event", event_id)
    key, relative = await event_service.get_clip_location(event_id)
    if key:
        size = await object_store.size(key)
        if size:
            return _stream_object(key, size, range_header, event_id)
    if not relative:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No clip recorded for this event."
        )

    root = clip_root().resolve()
    path = (root / relative).resolve()
    # clip_path is written by the worker, but never trust a path from the DB
    # to stay inside the clip directory.
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Clip file is missing."
        )
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"event-{event_id}.mp4",
        content_disposition_type="inline",
    )


@router.patch("/{event_id}/status")
async def update_event_status(
    event_id: UUID,
    payload: EventStatusUpdate,
    current_user: Dict[str, Any] = Depends(require_role("operator")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Acknowledge, resolve, or dismiss an event as a false positive.

    Optional `action_taken` / `description` record how it was handled.
    Setting it back to OPEN shows the alert again.
    """
    await ensure_in_workspace("event", event_id, workspace_id, "Event not found.")
    updated = await event_service.update_status(
        event_id,
        payload.status.value,
        action_taken=(payload.action_taken or "").strip() or None,
        description=(payload.description or "").strip() or None,
        user_id=current_user["user_id"],
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found.")
    return create_response(True, "Event status updated.", updated)


def parse_range(header: Optional[str], size: int) -> Optional[tuple]:
    """(start, end) inclusive for a single ``bytes=`` range, None for the whole file.

    Raises ValueError for a range that cannot be satisfied.
    """
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    first, _, last = header[len("bytes="):].strip().partition("-")
    if not first:  # suffix range: the last N bytes
        length = int(last)
        if length <= 0:
            raise ValueError("empty suffix range")
        return max(0, size - length), size - 1
    start = int(first)
    end = min(int(last), size - 1) if last else size - 1
    if start >= size or start > end:
        raise ValueError("range outside the file")
    return start, end


def _stream_object(key: str, size: int, range_header: Optional[str], event_id: UUID) -> Response:
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f'inline; filename="event-{event_id}.mp4"',
    }
    try:
        span = parse_range(range_header, size)
    except ValueError:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    start, end = span if span else (0, size - 1)
    length = end - start + 1
    headers["Content-Length"] = str(length)
    if span:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        object_store.iter_range(key, start, length),
        status_code=206 if span else 200,
        media_type="video/mp4",
        headers=headers,
    )
