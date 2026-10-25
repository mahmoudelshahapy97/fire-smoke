"""Run the fire & smoke pipeline over video files and print what it would alert on.

The detector and FireMonitor are the ones the camera workers use, driven on
video time instead of wall-clock time, so a clip is scored as fast as the GPU
allows and the result is the same on every run.

    python tools/eval_fire.py /app/videos/fire1.mp4
    python tools/eval_fire.py --model models/new.pt --set fire_confidence=0.4 --set confirm_hits=2 clip.mp4

For each clip it prints the first sighting of each kind, every incident event
(opened / reopened / closed) with its video time, and the per-kind hit rate.
Run it in the api container, where the model and its dependencies are.
"""

import argparse
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import config  # noqa: E402
from app.services.fire_detector import FireDetector, enabled_kinds, thresholds_from_settings  # noqa: E402
from app.services.fire_monitor import UPDATED, FireMonitor, FireParams  # noqa: E402
from app.services.model_registry import model_registry  # noqa: E402


def parse_overrides(pairs: List[str]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for pair in pairs:
        key, _, value = pair.partition("=")
        out[key.strip()] = float(value)
    return out


def evaluate(path: str, detector: FireDetector, settings: Dict[str, float], fps: float) -> Dict:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(f"{path}: cannot open")
        return {}
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, int(round(video_fps / fps)))
    monitor = FireMonitor(FireParams.from_settings(settings), detector.kinds)
    first_seen: Dict[str, float] = {}
    hits: Counter = Counter()
    checks = 0
    events = []
    index = 0
    t = 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if index % step == 0:
            t = index / video_fps
            detections = detector.detect(frame)
            checks += 1
            for kind in {d.kind for d in detections}:
                hits[kind] += 1
                first_seen.setdefault(kind, t)
            for event in monitor.update(detections, t):
                if event.type != UPDATED:
                    events.append((t, event.type, event.kind, event.incident.peak_confidence))
        index += 1
    cap.release()
    for event in monitor.close_all(t):
        events.append((t, "end of clip", event.kind, event.incident.peak_confidence))

    duration = index / video_fps
    print(f"\n{Path(path).name}: {duration:.1f}s, {checks} checks at {fps:g}/s")
    for kind in detector.kinds:
        seen = f"first seen {first_seen[kind]:.1f}s" if kind in first_seen else "never seen"
        rate = 100.0 * hits[kind] / checks if checks else 0.0
        print(f"  {kind:5}  {seen:20} in {rate:5.1f}% of checks")
    for t, kind_of_event, kind, peak in events:
        print(f"  {t:7.1f}s  {kind:5} {kind_of_event:12} peak {peak:.2f}")
    return {"checks": checks, "hits": dict(hits), "events": events}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("videos", nargs="+")
    parser.add_argument("--model", default=config.fire_model_path)
    parser.add_argument("--fps", type=float, default=config.fire_detect_fps, help="inferences per video second")
    parser.add_argument(
        "--set", action="append", default=[], metavar="KEY=VALUE",
        help="camera setting override, e.g. fire_confidence=0.4 or confirm_hits=2",
    )
    args = parser.parse_args()

    settings = parse_overrides(args.set)
    detector = FireDetector(
        thresholds_from_settings(settings),
        enabled_kinds(settings),
        model=model_registry.create_yolo(args.model),
    )
    print(f"model {args.model} on {model_registry.device}; thresholds {detector.thresholds}")
    params = FireParams.from_settings(settings)
    print(
        f"confirm {params.confirm_hits}/{params.confirm_window}, clear after {params.clear_after_s:g}s, "
        f"cooldown {params.cooldown_s:g}s"
    )
    for path in args.videos:
        evaluate(path, detector, settings, args.fps)


if __name__ == "__main__":
    main()
