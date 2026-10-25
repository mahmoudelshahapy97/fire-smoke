# app/services/model_registry.py
"""Thread-safe loading of the fire & smoke detector and resolution of the model device.

Each camera worker gets its own model instance: ultralytics models are not
safe to share across threads that predict at the same time.
"""

import logging
import os
import threading
from typing import Any, Optional

from app.core.config import config

logger = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self) -> None:
        self._yolo_lock = threading.Lock()
        self._device: Optional[str] = None

    # ------------------------------------------------------------------ device
    @property
    def device(self) -> str:
        """Resolve the configured device once, falling back to CPU when CUDA is absent."""
        if self._device is not None:
            return self._device

        requested = (config.model_device or "cpu").lower()
        if requested.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    logger.warning("MODEL_DEVICE=%s but CUDA is unavailable; using cpu.", requested)
                    requested = "cpu"
            except Exception as e:
                logger.warning("Could not probe CUDA (%s); using cpu.", e)
                requested = "cpu"

        self._device = requested
        return self._device

    # -------------------------------------------------------------------- yolo
    def create_yolo(self, weights: str = "") -> Any:
        """Build a fresh YOLO instance from ``weights`` (default FIRE_MODEL_PATH). One per camera worker.

        The fire model is a custom checkpoint, so there is nothing to download:
        missing weights are a deployment error and say so.
        """
        from ultralytics import YOLO

        weights = weights or config.fire_model_path
        if not os.path.exists(weights):
            raise FileNotFoundError(
                f"Model weights {weights} not found; see backend/models/README.md."
            )
        with self._yolo_lock:  # serialise loads so several workers starting at once do not race
            model = YOLO(weights, task="detect")

        logger.info("YOLO loaded (%s) on %s", weights, self.device)
        return model


model_registry = ModelRegistry()
