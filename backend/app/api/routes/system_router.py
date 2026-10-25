# app/api/routes/system_router.py
import logging
from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends

from app.api.deps import get_workspace_id, require_role
from app.core.config import config
from app.services.model_registry import model_registry
from app.services.object_store import object_store
from app.services.stream_manager import stream_manager
from app.services.workspace_service import workspace_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["system"], prefix="/system", dependencies=[Depends(require_role("viewer"))]
)


@router.get("/workers")
async def worker_status(workspace_id: UUID = Depends(get_workspace_id)) -> Dict[str, Any]:
    """State of the active workspace's camera workers held by the stream manager."""
    cameras = {str(camera_id) for camera_id in await workspace_service.camera_ids(workspace_id)}
    workers = [w for w in stream_manager.status() if str(w.get("camera_id")) in cameras]
    return create_response(
        True,
        f"{len(workers)} worker(s).",
        {
            "count": len(workers),
            "running": sum(1 for w in workers if w["running"]),
            "connected": sum(1 for w in workers if w["connected"]),
            "workers": workers,
        },
    )


@router.get("/config")
async def effective_config() -> Dict[str, Any]:
    """The tuning values in force - useful when an alert fires later than expected."""
    return create_response(
        True,
        "Effective configuration.",
        {
            "environment": config.environment,
            "device": model_registry.device,
            "detection": {
                "fire_model_path": config.fire_model_path,
                "fire_input_size": config.fire_input_size,
                "fire_class_map": config.fire_class_map,
                "fire_confidence": config.fire_confidence,
                "smoke_confidence": config.smoke_confidence,
                "fire_detect_fps": config.fire_detect_fps,
            },
            "incidents": {
                "fire_confirm_hits": config.fire_confirm_hits,
                "fire_confirm_window": config.fire_confirm_window,
                "fire_clear_after_s": config.fire_clear_after_s,
                "fire_cooldown_s": config.fire_cooldown_s,
                "alert_email": config.alert_email_active,
            },
            "stream": {
                "frame_skip": config.frame_skip,
                "target_process_fps": config.target_process_fps,
            },
            "storage": {
                # Images and videos in MinIO; records and object keys in Postgres.
                "object_store": "minio" if object_store.enabled else "disabled",
                "endpoint": config.minio_endpoint or None,
                "bucket": config.minio_bucket if object_store.enabled else None,
                "reachable": await object_store.healthy() if object_store.enabled else False,
            },
        },
    )
