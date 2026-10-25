# Frontend — Fire & Smoke

The operator console: cameras, incidents and their triage, InsightEye's emergency alert dialog, and analytics. It is built with **Vite, React 18, react-router-dom 6, MUI 6 and Chart.js**, and talks to the FastAPI backend through a same-origin proxy.

## Quick start

The backend must be running first (see `../backend/README.md`), or bring the whole stack up with `docker compose up -d --build` from the repository root.

```bash
cd "/home/ubuntu/fire&smoke/frontend"   # quote the path: it contains '&'
npm install
cp .env.example .env                    # adjust VITE_API_TARGET if needed
npm run dev
```

Open <http://localhost:5173>.

## The proxy, and why there is one

`vite.config.js` forwards `/api`, `/health`, `/docs`, `/redoc` and `/openapi.json` to the backend, so **the browser only ever makes same-origin requests**. Two things follow from that, and both matter:

- **No CORS.** `CORS_ORIGINS` in `backend/.env` lists a fixed set of origins, and cannot know the port a dev server happened to bind.
- **Media elements work.** Camera snapshots and live views, incident frames and clips go straight into an `<img>` or `<video>`, which can carry neither headers nor a preflight response. They are authenticated by the httpOnly cookie login sets.

`/health` needs its own entry because it sits on the app root, outside `/api/v1`. It is the probe behind the API chip in the app bar.

The target defaults to `http://127.0.0.1:8004`, where `../docker-compose.yml` publishes the API on this machine. Override it with `VITE_API_TARGET`.

### In production

`Dockerfile` builds the bundle and serves it from nginx, with `nginx.conf.template` doing what the dev proxy does. **Keep the two in step**: a path proxied in dev but not in nginx is a 404 that only appears after a build. nginx proxies to `FS_API_URL` (default `http://api:8000`), set on the `web` service in `../docker-compose.yml`.

`try_files $uri $uri/ /index.html` is not optional: this is a `BrowserRouter`, so a hard refresh on `/events/<uuid>` asks the server for a path that is not on disk.

## Routes

| Path | Page | Role |
|---|---|---|
| `/` | Dashboard: open alerts, live incidents, the last 24 h, cameras | viewer |
| `/cameras` | Registered cameras, with worker controls | viewer |
| `/cameras/new` · `/cameras/:id/edit` | Create / edit a camera: location fields, ROI, thresholds, which kinds alert | admin |
| `/cameras/:id` | One camera: live annotated view, latest boxes, live incidents, config | viewer |
| `/events` | Incident history; filters by status, kind, in view, camera and time live in the URL | viewer |
| `/events/:id` | One incident: clip, frame, location, timeline, triage | viewer (triage: operator) |
| `/analytics` | KPIs, series, hour-of-day heatmap, by camera / location, high risk, confidence audit | viewer |
| `/system` | Workers and the configuration in force | viewer |
| `/workspaces` · `/users` | Administration | admin |

`/alerts` and `/incidents` redirect to `/events`, so links written either way keep working.

## Alerts: the poll, the bell and the dialog

`AlertsProvider` (`src/alerts/AlertsContext.jsx`) polls `GET /api/v1/alerts/active` every `VITE_ALERT_POLL_MS` (3 s) for the active workspace, and shares the result:

- **`AlertBadge`**, the header bell, shows the count and links to `/events?status=OPEN`.
- **`EmergencyAlert`** is InsightEye's 🚨 dialog for the newest alert nobody has acknowledged, with its message, camera, confidence and frame:
  - it cannot be escaped or clicked away;
  - **Close** enables only after 10 s (`ALERT_CLOSE_DELAY_S`), and hides the alert in this tab only (sessionStorage);
  - **Acknowledge** (operators) takes it off every console;
  - **View incident** opens the detail page.

Unlike InsightEye, which matched notification text for the words "fire" and "smoke", the alert list here is the incidents whose status is OPEN.

## Layout

```
src/
├── alerts/AlertsContext.jsx   the alert poll, shared by the bell and the dialog
├── api/
│   ├── client.js      axios instance, token refresh, X-Workspace-Id, media URLs
│   └── endpoints.js   one function per backend route
├── auth/              session, roles, token storage
├── workspace/         the active workspace
├── components/        EmergencyAlert, StatusChips, HourHeatmap, ItemImage, DataStates, dialogs, toasts
├── hooks/
│   ├── usePolling.js  interval fetch with abort + tab-visibility pause
│   └── useAsync.js    one-shot fetch, same abort discipline
├── layouts/           AppLayout (sidebar, bell, health chip, theme toggle), AuthLayout
├── pages/             one file per route
├── routes/AppRouter.jsx     lazy-loaded routes and role guards
└── utils/             constants (mirrors the backend enums), formatters, theme
```

## Things worth knowing before changing this

- **`roi` and `settings` can arrive as strings.** They are `jsonb` columns, so everything that reads them goes through `parseJsonField`. Skip it and `Object.keys(settings)` enumerates *character indices*.
- **A blank threshold is not zero.** The camera form leaves empty overrides out of `settings` entirely, because an absent key means "inherit the global value". `fire_confidence: 0` would alert on every box the model emits.
- **Media are elements, not fetches.** `mediaUrl()` builds the path and the browser does the rest. Snapshot URLs carry a cache-busting timestamp. `ItemImage` handles the 404 a frame that was never stored returns, and the 503 of a camera that cannot be reached.
- **Polling pauses on hidden tabs.** `usePolling` schedules the next request only after the previous response, and skips ticks while `document.hidden`. The alert poll uses it too: a hidden tab stops asking, and the dialog appears within one tick (3 s) of the tab being shown again. The alert email is what reaches people who are not looking at a console.
- **The incident page asks for `include_frame=false`.** Fetching `/events/:id/frame` as an image lets the browser stream and cache it, instead of a base64 blob inflating the JSON by a third.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_TARGET` | `http://127.0.0.1:8004` | Backend origin the dev proxy forwards to |
| `VITE_PORT` | `5173` | Dev server port |
| `VITE_PREVIEW_PORT` | `4173` | `npm run preview` port |
| `VITE_API_BASE` | `/api/v1` | Path prefix the client calls |
| `VITE_POLL_INTERVAL_MS` | `5000` | Base refresh cadence of the pages |
| `VITE_ALERT_POLL_MS` | `3000` | Alert poll cadence |

## Scripts

```bash
npm run dev       # dev server with the proxy
npm run build     # production bundle into dist/
npm run preview   # serve dist/, proxy still applied
```
