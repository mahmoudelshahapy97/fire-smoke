# Models

The model this app runs, where it came from, and what is known about it.
Weights live in this folder, which docker-compose mounts at `/app/models`.
Only the files listed under **In use** are tracked in git. Any other file
dropped here stays ignored (see the root `.gitignore`).

## In use

| File | Model | Role | Config |
|---|---|---|---|
| `fire.pt` | Ultralytics YOLO26-N fine-tuned for fire and smoke, 3 classes | Detects fire and smoke in every camera | `FIRE_MODEL_PATH="models/fire.pt"` |

- **Source:** InsightEye's production model, copied from `insighteye/models/fire.pt`. The same model is also there as `fire.onnx`, `fire.engine` (TensorRT) and `fire_openvino_model/`. This app loads only the PyTorch file.
- **Size:** 5,370,693 bytes.
- **SHA-256:** `5e9fbb977b8e6ac6f2f408587a5b455639ec0a0cd388ce9069a62d0ea11ebf12`
- **Checkpoint:**
  - dated 2026-01-25 and saved by Ultralytics 8.4.6;
  - the api image runs Ultralytics 8.4.178 with torch 2.11.0+cu128.
- **Training:**
  - base `yolo26n.pt`, 100 epochs, 640 px, batch 128;
  - data `/home/ubuntu/Agent/datasets/fire/data.yaml`, which is not on this host.
- **Validation (from the checkpoint):** precision 0.863, recall 0.841, mAP@0.5 0.885, mAP@0.5:0.95 0.521.
- **License:** AGPL-3.0, from Ultralytics. Check this before any commercial or closed-source deployment.
- **Classes:** the checkpoint names them only `0`, `1` and `2`. The meanings below come from InsightEye's code, `stream_processing_service.py`, which reads 0 as fire and 1 as smoke and ignores 2. `FIRE_CLASS_MAP` sets this mapping in `backend/.env`.

  | Id | Meaning |
  |---|---|
  | 0 | fire |
  | 1 | smoke |
  | 2 | ignored (unknown) |

- **Checked on `videos/fire1.mp4`** (`tools/eval_fire.py`, 2026-10-24, T4):
  - At 2 checks/s the fire is first seen at 0.5 s and seen in 60% of checks.
  - The incident opens at 7.0 s, after 3 of 5 positive checks, with a peak confidence of 0.84.
  - Probing every third frame at confidence ≥ 0.05 gave 841 boxes, all class 0, peaking at 0.87.
  - Smoke (class 1) has **not** been seen on any footage on this host. Treat the smoke mapping as unverified until it is checked on a smoke clip.
- **Inference settings:**
  - 640 px input, FP16 on CUDA.
  - Per-kind confidence `FIRE_CONFIDENCE` / `SMOKE_CONFIDENCE` (0.5, as in InsightEye).
  - The detector runs at `FIRE_DETECT_FPS` (2) per camera.

## Changing the model

1. Put the weights here and set `FIRE_MODEL_PATH` in `backend/.env`.
2. Set `FIRE_CLASS_MAP` to the new model's class ids, e.g. `'{"0":"smoke","1":"fire"}'`. A class missing from the map is ignored.
3. Score it before switching. In the api container, run:

   ```sh
   python tools/eval_fire.py --model models/new.pt /app/videos/*.mp4
   ```

   It prints, for each clip, when each kind was first seen and when it was confirmed.
4. Recreate the api (`docker compose up -d api`).
5. Add a row to this file. If the file should be tracked, add it to the `!backend/models/...` lines in the root `.gitignore`.
