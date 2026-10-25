# End-to-end tests

Playwright drives the operator console in a real browser, against the real stack: nginx serving the built bundle, FastAPI with fire.pt behind it, then Postgres and MinIO. Nothing is mocked. When these pass, the wiring works, not just the React components.

## Running

```bash
cd "/home/ubuntu/fire&smoke"
docker compose up -d --build                    # postgres, minio, mediamtx, api, web
docker compose exec -T postgres psql -U firesmoke -d firesmoke_db < database/seed.sql
./e2e/run.sh                                    # whole suite
./e2e/run.sh tests/04-fire-alert.spec.js        # one file
```

`run.sh` runs the tests inside `mcr.microsoft.com/playwright`, so nothing needs installing locally beyond Docker; the image already carries the browsers and their system libraries. It runs with `--network host`, which is why `BASE_URL` defaults to `http://localhost:8083` rather than a compose service name.

Results land in:

| Path | What |
| --- | --- |
| `playwright-report/` | HTML report (`npx playwright show-report`) |
| `results.json` | machine-readable summary |
| `artifacts/videos/<spec>/` | a video of every test, named by its order and title |
| `artifacts/screenshots/<spec>/` | every test's final screen; the demo tour's steps (`step-NN-…`); spec 04's clip playing in Firefox |
| `test-results/` | Playwright's raw output, traces for failures; wiped at the start of each run |

`artifacts-reporter.js` copies the videos and screenshots out of `test-results/` after each test. A run replaces the files of the tests it ran and keeps the rest, so running one spec does not throw the others away. `artifacts/` is git-ignored.

To run against a different origin, such as a staging deploy or the Vite dev server:

```bash
BASE_URL=http://localhost:5173 ./e2e/run.sh
```

## The seed is a fixture; spec 04 is the real thing

Spec 03 asserts against the rows in `database/seed.sql`: four cameras and 28 incidents with known kinds, statuses and locations. It skips itself, with a message naming the seed, when those rows are missing.

Spec 04 runs the detector for real. Spec 02's camera reads `fire1.mp4` from `mediamtx` but alerts on smoke only, which that clip never shows. Spec 04 then turns fire on through the edit form and waits for:

- the emergency dialog, with InsightEye's wording and the camera's location;
- acknowledging it from the dialog;
- the stored frame and the evidence clip, which must actually play.

On a GPU the alert arrives a few seconds after the worker restarts. On CPU it can take a minute, so the waits are long. The spec finishes by turning fire off again and resolving what it raised. That matters because an open alert pops up over every page of every console.

The same is why every seeded camera is disabled: an enabled one would raise a live alert over the whole suite.

## Auth: one login, shared by everything

Every route but `/health` and `/login` needs a session (see the backend's Auth section in `../backend/README.md`). Rather than have each file log in, `global.setup.js` runs once as a Playwright *setup project*. It:

- logs in as the bootstrap admin through the real `/login` page;
- saves the browser's storageState to `.auth/admin.json`: the access/refresh tokens in `localStorage`, plus the httpOnly cookie the frame, clip and snapshot routes accept;
- creates one operator and one viewer account for role assertions.

`chromium`, the project that runs `01`–`05` and `07`, starts every test already signed in with that state.

The bare `request` fixture used for direct API assertions is a *separate* context from the browser. It only inherits storageState's cookie, and the JSON API needs the bearer header, so any spec that calls `request.get/post/patch/delete` passes `{ headers: authHeaders() }` (`tests/helpers.js`).

`00-auth.spec.js` runs in its own project, signed out on purpose. It covers the login page itself, a wrong password, the redirect-and-return-to flow, and what a viewer and an operator can and cannot reach.

## The specs are one story

`playwright.config.js` runs a single worker, files in order, and they share state:

| File | What it covers |
| --- | --- |
| `00-auth.spec.js` | Login (by username or email), bad credentials, redirects, role boundaries, forgot password; runs signed out |
| `01-shell.spec.js` | Health, alert poll, analytics shape, every route renders, nav, aliases, the alert bell, 404, theme toggle |
| `02-camera-lifecycle.spec.js` | Register a camera with location fields and overrides, validation, start its worker |
| `03-observability.spec.js` | Incident list and filters, detail and timeline, triage with the action taken, system page |
| `04-fire-alert.spec.js` | A real detection: emergency dialog, acknowledge, frame and clip (played in Firefox), alert email |
| `05-teardown.spec.js` | Edit, stop, delete, and check nothing else was taken with it |
| `06-demo-walkthrough.spec.js` | A recorded tour for a human to watch (its own `demo` project) |
| `07-workspaces.spec.js` | Create a workspace and a camera in it, switch to it, a non-member is shut out, delete it |

Two specs read mail from a [mailpit](https://mailpit.axllent.org) SMTP sink: the password reset in `00` and the alert email in `04`. They run only when the API has `SMTP_HOST` set to that sink (`SMTP_PORT=1025`, `SMTP_STARTTLS=false`) and `MAILPIT_URL` (for example `http://mailpit:8025`) is passed to the test container. Otherwise they are skipped.

Anything that has to survive between files is re-read from the API (`findCamera`), never kept in a module variable: each spec file gets a fresh module registry.

## Conventions worth keeping

- **`collectPageProblems` runs on most specs.** A React page that throws still renders its shell, so a passing visual assertion can hide a broken component. Console errors are collected and asserted empty at the end. 404s and 503s from the media routes are filtered out, because a missing frame or an unreachable snapshot is a state the UI handles on purpose.
- **Assertions check the API as well as the page.** A form that navigates correctly but wrote nothing is the failure worth catching, so the write specs read the row back. `02` in particular checks that a blank threshold is *absent* from `settings`, not stored as `0`.
- **Clip playback is checked in Firefox.** Playwright's Chromium is the open-source build and has no H.264 decoder, so a `<video>` of an evidence clip reports "no supported sources" there. Chrome, Edge, Safari and Firefox play them. Spec 04 launches Firefox, with the saved admin session, just for that one check; the image `run.sh` uses already has it.
- **Nothing is left OPEN.** Specs that change a seeded incident put it back, and never to OPEN.
- **`05` verifies the seed survived.** Deleting a camera cascades to its incidents, so a stray delete would silently gut the fixture and leave the next run failing somewhere unrelated.
