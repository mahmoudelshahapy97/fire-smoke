# app/services/fire_detector.py
"""The fire & smoke detector: one YOLO forward pass -> fire / smoke boxes.

Fire and smoke are not objects that keep an identity from frame to frame --
flames flicker, smoke spreads and merges -- so there is no tracker here. What
makes a sighting an incident is decided over time by ``FireMonitor``.
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from app.core.config import config
from app.services.model_registry import model_registry
from app.utils.geometry_utils import Box, box_area, box_in_polygon

logger = logging.getLogger(__name__)

FIRE = "fire"
SMOKE = "smoke"
KINDS = (FIRE, SMOKE)


@dataclass
class Detection:
    kind: str           # "fire" | "smoke"
    confidence: float
    box: Box

    @property
    def area(self) -> float:
        return box_area(self.box)

    def as_dict(self) -> Dict[str, Any]:
        x1, y1, x2, y2 = self.box
        return {
            "kind": self.kind,
            "confidence": round(self.confidence, 4),
            "box": {"x1": round(x1, 1), "y1": round(y1, 1), "x2": round(x2, 1), "y2": round(y2, 1)},
        }


def thresholds_from_settings(settings: Optional[Dict[str, Any]] = None) -> Dict[str, float]:
    """Per-kind confidence, with the camera's ``fire_confidence`` /
    ``smoke_confidence`` overriding the global values."""
    settings = settings or {}
    out = {}
    for kind, default in ((FIRE, config.fire_confidence), (SMOKE, config.smoke_confidence)):
        value = settings.get(f"{kind}_confidence")
        out[kind] = float(value) if isinstance(value, (int, float)) else default
    return out


def enabled_kinds(settings: Optional[Dict[str, Any]] = None) -> List[str]:
    """The kinds a camera alerts on; ``{"kinds": ["fire"]}`` turns smoke off."""
    kinds = (settings or {}).get("kinds")
    if isinstance(kinds, list):
        picked = [k for k in KINDS if k in kinds]
        return picked
    return list(KINDS)


def filter_detections(
    raw: Sequence[Detection],
    thresholds: Dict[str, float],
    kinds: Sequence[str],
    roi: Optional[Sequence[Sequence[float]]] = None,
) -> List[Detection]:
    """Keep the boxes of an enabled kind, at or above its threshold, inside the ROI."""
    kept = []
    for d in raw:
        if d.kind not in kinds or d.confidence < thresholds.get(d.kind, 1.0):
            continue
        if roi and not box_in_polygon(d.box, roi):
            continue
        kept.append(d)
    return kept


class FireDetector:
    """Wraps one YOLO instance; build one per camera worker."""

    def __init__(
        self,
        thresholds: Optional[Dict[str, float]] = None,
        kinds: Optional[Sequence[str]] = None,
        roi: Optional[Sequence[Sequence[float]]] = None,
        model: Any = None,
    ) -> None:
        self.model = model or model_registry.create_yolo()
        self.thresholds = thresholds or thresholds_from_settings()
        self.kinds = list(kinds) if kinds is not None else list(KINDS)
        self.roi = roi
        self.class_map = {int(k): v for k, v in config.fire_class_map.items()}

    def detect(self, frame: np.ndarray) -> List[Detection]:
        """Fire and smoke boxes in ``frame`` that pass the camera's filters. Blocking."""
        if frame is None or frame.size == 0:
            return []
        device = model_registry.device
        results = self.model.predict(
            frame,
            conf=min(self.thresholds.values()) if self.thresholds else config.detector_floor,
            imgsz=config.fire_input_size,
            classes=sorted(self.class_map),
            quantize=16 if config.fire_half and device.startswith("cuda") else None,
            device=device,
            verbose=False,
        )
        if not results:
            return []
        try:
            boxes = results[0].boxes.cpu().numpy()
            raw = [
                Detection(self.class_map[int(c)], float(s), tuple(float(v) for v in xyxy))
                for xyxy, c, s in zip(boxes.xyxy, boxes.cls, boxes.conf)
                if int(c) in self.class_map
            ]
        except Exception as e:
            logger.error("Could not read detections: %s", e, exc_info=True)
            return []
        return filter_detections(raw, self.thresholds, self.kinds, self.roi)
