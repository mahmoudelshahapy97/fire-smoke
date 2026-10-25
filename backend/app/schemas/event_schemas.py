# app/schemas/event_schemas.py
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class EventStatus(str, Enum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"
    FALSE_POSITIVE = "FALSE_POSITIVE"


class EventStatusUpdate(BaseModel):
    status: EventStatus
    # Optional notes on how it was handled; left out, the stored ones are kept.
    action_taken: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)


class EventKind(str, Enum):
    FIRE = "fire"
    SMOKE = "smoke"


class EventResponse(BaseModel):
    event_id: UUID
    camera_id: Optional[UUID] = None
    camera_name: Optional[str] = None
    location_text: Optional[str] = None
    kind: str
    peak_confidence: Optional[float] = None
    bbox: Optional[Dict[str, float]] = None
    detections: Optional[List[Dict[str, Any]]] = None
    sightings: Optional[int] = None
    started_at: Optional[datetime] = None
    detected_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    cleared_at: Optional[datetime] = None
    live: bool = False
    status: str
    action_taken: Optional[str] = None
    description: Optional[str] = None
    acknowledged_at: Optional[datetime] = None
    acknowledged_by_username: Optional[str] = None
    resolved_at: Optional[datetime] = None
    resolved_by_username: Optional[str] = None
    has_clip: bool = False
    frame_base64: Optional[str] = None


class EventListResponse(BaseModel):
    total: int
    page: int
    per_page: int
    events: List[EventResponse]


class EventStats(BaseModel):
    total: int = 0
    open: int = 0
    live: int = 0
    last_24h: int = 0
    fire_24h: int = 0
    smoke_24h: int = 0
    last_event_at: Optional[datetime] = None
    by_camera: Optional[List[Dict[str, Any]]] = None


class ActiveAlert(BaseModel):
    event_id: UUID
    camera_id: Optional[UUID] = None
    camera_name: Optional[str] = None
    location_text: Optional[str] = None
    kind: str
    peak_confidence: Optional[float] = None
    started_at: Optional[datetime] = None
    detected_at: datetime
    last_seen_at: Optional[datetime] = None
    live: bool = False
    message: str


class ActiveAlerts(BaseModel):
    count: int
    alerts: List[ActiveAlert]
