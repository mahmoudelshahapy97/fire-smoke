import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import CloudIcon from "@mui/icons-material/Cloud";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import NotificationsIcon from "@mui/icons-material/NotificationsActive";
import RefreshIcon from "@mui/icons-material/Refresh";
import VideocamIcon from "@mui/icons-material/Videocam";

import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import {
  EventStatusChip,
  KindChip,
  LiveChip,
  LiveStatusChip,
  WorkerChip,
} from "../components/StatusChips";
import { cameras, events, system } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { usePolling } from "../hooks/usePolling";
import { POLL_INTERVAL_MS } from "../utils/constants";
import { cameraPlace, formatNumber, fromNow } from "../utils/format";
import { useTranslation } from "react-i18next";

function CameraTile({ camera, worker }) {
  const status = worker?.running ? worker.status : null;
  const alerting = status === "fire" || status === "smoke";
  return (
    <Card
      variant="outlined"
      sx={{
        height: "100%",
        borderColor: alerting ? (status === "fire" ? "error.main" : "warning.main") : "divider",
        borderWidth: alerting ? 2 : 1,
      }}
    >
      <CardActionArea
        component={RouterLink}
        to={`/cameras/${camera.camera_id}`}
        sx={{ height: "100%" }}
        data-testid="camera-tile"
      >
        <CardContent>
          <Stack spacing={1}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
              {camera.name}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {cameraPlace(camera)}
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <LiveStatusChip status={status} />
              <WorkerChip worker={worker} />
            </Stack>
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  // The counters and the camera states are worth polling: a fire has to show
  // up without anyone reaching for refresh.
  const stats = usePolling(({ signal }) => events.stats(undefined, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 2,
  });
  const recent = usePolling(({ signal }) => events.list({ per_page: 8 }, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 2,
  });
  const workers = usePolling(({ signal }) => system.workers({ signal }), {
    intervalMs: POLL_INTERVAL_MS,
  });

  // Cameras change only when a person edits them, so one fetch is enough.
  const cameraList = useAsync(({ signal }) => cameras.list(undefined, { signal }), []);

  const eventStats = stats.data?.data || {};
  const allCameras = cameraList.data || [];
  const workerById = Object.fromEntries(
    (workers.data?.data?.workers || []).map((w) => [w.camera_id, w])
  );
  const watching = allCameras.filter((c) => workerById[c.camera_id]?.connected).length;
  const alerting = allCameras.filter((c) => {
    const status = workerById[c.camera_id]?.status;
    return status === "fire" || status === "smoke";
  }).length;

  const refreshAll = () => {
    stats.refresh();
    recent.refresh();
    workers.refresh();
    cameraList.refresh();
  };

  return (
    <Box>
      <PageHeader
        title={t("dashboard.dashboard")}
        subtitle={t("dashboard.whatEveryCameraSeesRight")}
        actions={[
          <Button key="refresh" onClick={refreshAll} startIcon={<RefreshIcon />}>
            {t("dashboard.refresh")}
          </Button>,
        ]}
      />

      <ErrorState error={stats.error} onRetry={stats.refresh} title={t("dashboard.couldNotLoadTheCounters")} />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.openAlerts")}
            value={formatNumber(eventStats.open ?? 0)}
            hint={t("dashboard.v0StillInView", { v0: formatNumber(eventStats.live ?? 0) })}
            icon={<NotificationsIcon />}
            color="error"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.fireLast24h")}
            value={formatNumber(eventStats.fire_24h ?? 0)}
            hint={
              eventStats.last_event_at
                ? t("dashboard.latestIncidentV0", { v0: fromNow(eventStats.last_event_at) })
                : t("dashboard.nothingYet")
            }
            icon={<LocalFireDepartmentIcon />}
            color="error"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.smokeLast24h")}
            value={formatNumber(eventStats.smoke_24h ?? 0)}
            hint={t("dashboard.incidentsNotSingleSightings")}
            icon={<CloudIcon />}
            color="warning"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.camerasWatching")}
            value={`${formatNumber(watching)} / ${formatNumber(allCameras.length)}`}
            hint={alerting ? t("dashboard.alertingSeeingFireOrSmoke", { alerting }) : t("dashboard.noneAlerting")}
            icon={<VideocamIcon />}
            color={alerting ? "error" : "success"}
          />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <Card>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 2 }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("dashboard.cameras")}
              </Typography>
              <Link component={RouterLink} to="/cameras" variant="body2">
                {t("dashboard.manage")}
              </Link>
            </Stack>
            <Divider />
            <Box sx={{ p: 2 }}>
              {cameraList.loading && !cameraList.data ? (
                <Loading label={t("dashboard.loadingCameras")} height={140} />
              ) : allCameras.length ? (
                <Grid container spacing={2}>
                  {allCameras.map((camera) => (
                    <Grid key={camera.camera_id} size={{ xs: 12, sm: 6, md: 4, xl: 3 }}>
                      <CameraTile camera={camera} worker={workerById[camera.camera_id]} />
                    </Grid>
                  ))}
                </Grid>
              ) : (
                <EmptyState
                  title={t("dashboard.noCameras")}
                  description={t("dashboard.registerAnRtspSourceTo")}
                  icon={<VideocamIcon fontSize="inherit" />}
                  action={
                    <Button
                      component={RouterLink}
                      to="/cameras/new"
                      variant="contained"
                      size="small"
                    >
                      {t("dashboard.addACamera")}
                    </Button>
                  }
                />
              )}
            </Box>
          </Card>
        </Grid>

        <Grid size={{ xs: 12 }}>
          <Card>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 2 }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("dashboard.recentIncidents")}
              </Typography>
              <Link component={RouterLink} to="/events" variant="body2">
                {t("dashboard.viewAll")}
              </Link>
            </Stack>
            <Divider />

            {recent.error ? (
              <Box sx={{ p: 2 }}>
                <ErrorState error={recent.error} onRetry={recent.refresh} />
              </Box>
            ) : recent.loading && !recent.data ? (
              <Loading label={t("dashboard.loadingIncidents")} />
            ) : recent.data?.events?.length ? (
              <List disablePadding>
                {recent.data.events.map((event) => (
                  <ListItemButton
                    key={event.event_id}
                    component={RouterLink}
                    to={`/events/${event.event_id}`}
                    divider
                  >
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <KindChip kind={event.kind} />
                          <EventStatusChip status={event.status} />
                          {event.live && <LiveChip live />}
                        </Stack>
                      }
                      secondary={`${event.camera_name || t("dashboard.unknownCamera")} · ${
                        event.location_text || ""
                      } · ${fromNow(event.detected_at)}`}
                      secondaryTypographyProps={{ sx: { mt: 0.5 } }}
                    />
                  </ListItemButton>
                ))}
              </List>
            ) : (
              <EmptyState
                title={t("dashboard.noIncidentsYet")}
                description={t("dashboard.anIncidentAppearsHereOnce")}
              />
            )}
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
