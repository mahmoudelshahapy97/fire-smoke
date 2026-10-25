# app/schemas/camera_schemas.py
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class CameraCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    rtsp_url: str = Field(..., description="rtsp://user:pass@host:554/stream, or a local file path")
    location: Optional[str] = Field(None, max_length=200)
    building: Optional[str] = Field(None, max_length=100)
    floor_level: Optional[str] = Field(None, max_length=20)
    zone: Optional[str] = Field(None, max_length=100)
    area: Optional[str] = Field(None, max_length=100)
    enabled: bool = True
    roi: Optional[List[List[float]]] = Field(
        None, description="Optional polygon [[x,y], ...] limiting where detections count"
    )
    settings: Optional[Dict[str, Any]] = Field(
        None,
        description=(
            "Per-camera overrides, e.g. {'fire_confidence': 0.6, 'smoke_confidence': 0.4, "
            "'confirm_hits': 3, 'confirm_window': 5, 'clear_after_s': 30, 'cooldown_s': 600, "
            "'kinds': ['fire', 'smoke']}"
        ),
    )

    @field_validator("roi")
    @classmethod
    def validate_roi(cls, value: Optional[List[List[float]]]) -> Optional[List[List[float]]]:
        if value is None:
            return None
        if len(value) < 3:
            raise ValueError("roi needs at least 3 points")
        if any(len(point) != 2 for point in value):
            raise ValueError("each roi point must be [x, y]")
        return value


class CameraUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    rtsp_url: Optional[str] = None
    location: Optional[str] = Field(None, max_length=200)
    building: Optional[str] = Field(None, max_length=100)
    floor_level: Optional[str] = Field(None, max_length=20)
    zone: Optional[str] = Field(None, max_length=100)
    area: Optional[str] = Field(None, max_length=100)
    enabled: Optional[bool] = None
    roi: Optional[List[List[float]]] = None
    settings: Optional[Dict[str, Any]] = None


class CameraResponse(BaseModel):
    camera_id: UUID
    workspace_id: Optional[UUID] = None
    name: str
    rtsp_url: str
    location: Optional[str] = None
    building: Optional[str] = None
    floor_level: Optional[str] = None
    zone: Optional[str] = None
    area: Optional[str] = None
    enabled: bool
    roi: Optional[Any] = None
    settings: Optional[Any] = None
    created_at: datetime
    updated_at: Optional[datetime] = None


class WorkerStatus(BaseModel):
    camera_id: str
    name: str
    running: bool
    connected: bool
    started_at: Optional[str] = None
    frames_processed: int = 0
    events_emitted: int = 0
    last_error: Optional[str] = None
    status: str = "clear"   # fire | smoke | clear
    incidents: List[Dict[str, Any]] = []
    detections: List[Dict[str, Any]] = []
