# Console captures

Screenshots of the console on the shared InsightEye UI (`frontend/packages/insighteye-ui`), taken from a scratch stack loaded with `database/seed.sql`.

| Folder | Look |
|---|---|
| `screenshots/desktop-dark/` | 1440×900, dark (default) |
| `screenshots/desktop-light/` | 1440×900, light |
| `screenshots/desktop-ar/` | 1440×900, dark, Arabic, right to left |
| `screenshots/phone/` | 390×844, dark |

Each folder has the same pages: login, dashboard, cameras, a camera, live wall, incidents, an incident, notifications, analytics, workers & config, workspaces, users, audit log.

**Retaking them.** Run `frontend/packages/insighteye-ui/scripts/capture.mjs` in the Playwright image on the stack's network. Pass `APP_KEY=fire-smoke`, the admin credentials and `PAGES`; the script's header shows the full command.
