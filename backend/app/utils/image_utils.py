# app/utils/image_utils.py
"""Image processing utilities for frame conversion, cropping and annotation."""

import base64
import logging
from typing import Optional, Sequence, Tuple

import cv2
import numpy as np

from app.core.config import config
from app.utils.geometry_utils import Box, clamp_box

logger = logging.getLogger(__name__)


def encode_jpeg(frame: np.ndarray, quality: Optional[int] = None) -> Optional[bytes]:
    """Encode a BGR frame as JPEG bytes."""
    if frame is None or frame.size == 0:
        return None
    success, buffer = cv2.imencode(
        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality or config.jpeg_quality]
    )
    if not success:
        logger.error("cv2.imencode failed during JPEG encoding.")
        return None
    return buffer.tobytes()


def decode_jpeg(data: bytes) -> Optional[np.ndarray]:
    """Decode JPEG/PNG bytes into a BGR frame."""
    if not data:
        return None
    try:
        nparr = np.frombuffer(data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error("Error decoding image bytes: %s", e, exc_info=True)
        return None


def frame_to_base64(frame: np.ndarray) -> str:
    """Converts an OpenCV frame (numpy array) to a base64 encoded string."""
    data = encode_jpeg(frame)
    return base64.b64encode(data).decode("utf-8") if data else ""


def base64_to_frame(base64_string: str) -> Optional[np.ndarray]:
    """Converts a base64 encoded string back to an OpenCV frame."""
    if not base64_string:
        return None
    try:
        return decode_jpeg(base64.b64decode(base64_string))
    except Exception as e:
        logger.error("Error decoding base64 string to frame: %s", e, exc_info=True)
        return None


def bytes_to_base64(data: Optional[bytes]) -> Optional[str]:
    """Postgres BYTEA -> base64 string for JSON responses."""
    if not data:
        return None
    return base64.b64encode(bytes(data)).decode("utf-8")


def crop_box(
    frame: np.ndarray, box: Box, padding: int = 8, context_ratio: float = 0.0
) -> Optional[np.ndarray]:
    """Crop a padded region of the frame; returns None when the crop is empty.

    ``context_ratio`` widens the pad to a fraction of the box's longer side:
    a tight 80 px crop gives an embedder little to work with, a little
    surrounding context gives it shape and scale.
    """
    if frame is None or frame.size == 0:
        return None

    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    if context_ratio > 0:
        padding = max(padding, int(round(max(x2 - x1, y2 - y1) * context_ratio)))
    padded = (x1 - padding, y1 - padding, x2 + padding, y2 + padding)
    x1, y1, x2, y2 = clamp_box(padded, width, height)

    crop = frame[int(y1) : int(y2), int(x1) : int(x2)]
    return crop if crop.size else None


# BGR colours
_COLOR_FIRE = (0, 0, 255)          # red - fire
_COLOR_SMOKE = (160, 160, 160)     # grey - smoke
_COLOR_ROI = (255, 200, 0)         # cyan-ish - region of interest
_COLOR_HEADER = (32, 32, 32)

_KIND_COLORS = {"fire": _COLOR_FIRE, "smoke": _COLOR_SMOKE}


def draw_box(
    frame: np.ndarray,
    box: Box,
    label: str = "",
    color: Tuple[int, int, int] = _COLOR_FIRE,
    thickness: int = 2,
) -> np.ndarray:
    """Draw a labelled rectangle in place and return the frame."""
    x1, y1, x2, y2 = (int(v) for v in box)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, thickness)

    if label:
        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        top = max(0, y1 - th - baseline - 4)
        cv2.rectangle(frame, (x1, top), (x1 + tw + 6, top + th + baseline + 4), color, -1)
        cv2.putText(
            frame,
            label,
            (x1 + 3, top + th + 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
    return frame


def draw_roi(frame: np.ndarray, polygon: Sequence[Sequence[float]]) -> np.ndarray:
    """Outline the configured region of interest."""
    if not polygon or len(polygon) < 3:
        return frame
    points = np.array([[int(p[0]), int(p[1])] for p in polygon], dtype=np.int32)
    cv2.polylines(frame, [points], isClosed=True, color=_COLOR_ROI, thickness=2)
    return frame


def _draw_header(frame: np.ndarray, header: str) -> int:
    """Dark bar across the top with ``header``; returns its height."""
    (_, th), baseline = cv2.getTextSize(header, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
    bar = th + baseline + 10
    cv2.rectangle(frame, (0, 0), (frame.shape[1], bar), _COLOR_HEADER, -1)
    cv2.putText(
        frame, header, (8, th + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA
    )
    return bar


def annotate_fire(
    frame: np.ndarray,
    detections: Sequence[object],
    status: str = "clear",
    roi: Optional[Sequence[Sequence[float]]] = None,
    header: str = "",
    tint: bool = True,
) -> np.ndarray:
    """Boxes for every fire / smoke detection, and InsightEye's alert overlay.

    ``detections`` are ``fire_detector.Detection``s. While ``status`` is fire
    or smoke the frame carries a red ``ALERT: FIRE`` / ``ALERT: SMOKE`` banner
    and, with ``tint``, InsightEye's 10% red wash. Draws on a copy.
    """
    annotated = frame.copy()
    alerting = status in _KIND_COLORS
    if alerting and tint:
        red = np.zeros_like(annotated)
        red[:, :] = _COLOR_FIRE
        annotated = cv2.addWeighted(annotated, 0.9, red, 0.1, 0)
    if roi:
        draw_roi(annotated, roi)

    for d in detections:
        kind = getattr(d, "kind", "fire")
        draw_box(
            annotated,
            d.box,
            f"{kind} {getattr(d, 'confidence', 0):.2f}",
            _KIND_COLORS.get(kind, _COLOR_FIRE),
            thickness=3 if kind == "fire" else 2,
        )

    top = _draw_header(annotated, header) if header else 0
    if alerting:
        text = f"ALERT: {status.upper()}"
        (tw, th), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 2)
        y = top + 10
        cv2.rectangle(annotated, (8, y), (8 + tw + 16, y + th + baseline + 12), _COLOR_FIRE, -1)
        cv2.putText(
            annotated,
            text,
            (16, y + th + 6),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.9,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
    return annotated


def placeholder_frame(message: str, width: int = 960, height: int = 540) -> np.ndarray:
    """A dark frame with a message, for live viewers before the first frame."""
    frame = np.full((height, width, 3), 24, dtype=np.uint8)
    (tw, th), _ = cv2.getTextSize(message, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
    cv2.putText(
        frame,
        message,
        ((width - tw) // 2, (height + th) // 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (200, 200, 200),
        2,
        cv2.LINE_AA,
    )
    return frame
