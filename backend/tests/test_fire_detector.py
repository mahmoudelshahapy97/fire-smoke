"""FireDetector: thresholds, kinds and ROI over a model's raw boxes.

The fake model stands in for ultralytics; the slow test at the end runs the
real fire.pt on frames of videos/fire1.mp4 and is skipped without them.
"""

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from app.services.fire_detector import (
    Detection,
    FireDetector,
    enabled_kinds,
    filter_detections,
    thresholds_from_settings,
)
from app.utils.image_utils import annotate_fire

BACKEND = Path(__file__).resolve().parents[1]


class FakeBoxes:
    def __init__(self, rows):
        arr = np.array(rows, dtype=np.float32).reshape(-1, 6)
        self.xyxy, self.conf, self.cls = arr[:, :4], arr[:, 4], arr[:, 5]

    def cpu(self):
        return self

    def numpy(self):
        return self


class FakeModel:
    """Returns the given rows ([x1, y1, x2, y2, conf, cls]) and records the call."""

    def __init__(self, rows):
        self.rows = rows
        self.kwargs = None

    def predict(self, frame, **kwargs):
        self.kwargs = kwargs
        return [SimpleNamespace(boxes=FakeBoxes(self.rows))]


FRAME = np.zeros((480, 640, 3), dtype=np.uint8)


def test_class_map_thresholds_and_ignored_class():
    model = FakeModel([
        [10, 10, 50, 50, 0.9, 0],   # fire
        [60, 60, 90, 90, 0.4, 0],   # fire, under 0.5
        [100, 100, 200, 200, 0.6, 1],  # smoke
        [0, 0, 5, 5, 0.99, 2],      # class 2: not in the map
    ])
    detector = FireDetector({"fire": 0.5, "smoke": 0.5}, model=model)
    found = detector.detect(FRAME)
    assert [(d.kind, round(d.confidence, 2)) for d in found] == [("fire", 0.9), ("smoke", 0.6)]
    # The model is asked for the lowest threshold and only the mapped classes.
    assert model.kwargs["conf"] == 0.5
    assert model.kwargs["classes"] == [0, 1]


def test_per_kind_thresholds_and_roi():
    raw = [
        Detection("fire", 0.45, (10, 10, 30, 30)),
        Detection("smoke", 0.45, (10, 10, 30, 30)),
        Detection("fire", 0.9, (400, 400, 450, 450)),  # outside the ROI
    ]
    roi = [[0, 0], [200, 0], [200, 200], [0, 200]]
    kept = filter_detections(raw, {"fire": 0.4, "smoke": 0.5}, ["fire", "smoke"], roi)
    assert [d.kind for d in kept] == ["fire"]


def test_camera_settings_override_thresholds_and_kinds():
    assert thresholds_from_settings({"smoke_confidence": 0.3}) == {"fire": 0.5, "smoke": 0.3}
    assert enabled_kinds({"kinds": ["smoke", "nonsense"]}) == ["smoke"]
    assert enabled_kinds({}) == ["fire", "smoke"]


def test_empty_frame_has_no_detections():
    detector = FireDetector(model=FakeModel([[0, 0, 1, 1, 0.9, 0]]))
    assert detector.detect(np.zeros((0, 0, 3), np.uint8)) == []


def test_annotation_marks_an_alert_and_leaves_the_input_alone():
    frame = np.full((240, 320, 3), 100, dtype=np.uint8)
    out = annotate_fire(frame, [Detection("fire", 0.8, (50, 50, 150, 150))], "fire", header="cam")
    assert out.shape == frame.shape
    assert (frame == 100).all()
    assert not np.array_equal(out, frame)
    quiet = annotate_fire(frame, [], "clear")
    assert np.array_equal(quiet, frame)


@pytest.mark.slow
def test_real_model_sees_the_fire_in_fire1():
    cv2 = pytest.importorskip("cv2")
    weights, clip = BACKEND / "models" / "fire.pt", BACKEND / "videos" / "fire1.mp4"
    if not weights.exists() or not clip.exists():
        pytest.skip("models/fire.pt or videos/fire1.mp4 missing")
    pytest.importorskip("ultralytics")
    from app.services.model_registry import model_registry

    detector = FireDetector(model=model_registry.create_yolo(str(weights)))
    cap = cv2.VideoCapture(str(clip))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    seen = 0
    for second in (10, 12, 15, 18):  # the fire is in full view here
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(second * fps))
        ok, frame = cap.read()
        assert ok
        seen += any(d.kind == "fire" for d in detector.detect(frame))
    cap.release()
    assert seen >= 3
