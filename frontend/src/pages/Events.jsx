import { Link as RouterLink, useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import RefreshIcon from "@mui/icons-material/Refresh";

import PageHeader from "../components/PageHeader";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { EventStatusChip, KindChip, LiveChip } from "../components/StatusChips";
import { cameras as cameraApi, events as eventApi } from "../api/endpoints";
import { ExportButton } from "@insighteye/ui";
import { useAsync } from "../hooks/useAsync";
import {
  EVENT_KINDS,
  EVENT_STATUSES,
  PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
} from "../utils/constants";
import {
  formatDateTime,
  formatDuration,
  formatScore,
  fromNow,
  incidentSeconds,
  titleCase,
} from "../utils/format";
import { useTranslation } from "react-i18next";

/** A yyyy-mm-dd input value as an ISO bound for the API: start or end of that local day. */
const dayBound = (value, end = false) =>
  value ? new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString() : undefined;

/**
 * Filters live in the query string rather than in component state, so a
 * filtered view is a real URL: it survives a reload, works with back/forward,
 * and can be linked to from the dashboard and from a camera's detail page.
 */
export default function Events() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();

  const status = params.get("status") || "";
  const kind = params.get("kind") || "";
  const live = params.get("live") || "";
  const cameraId = params.get("camera_id") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const page = Math.max(1, Number(params.get("page") || 1));
  const perPage = Number(params.get("per_page") || PAGE_SIZE);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current offset.
    if (key !== "page") next.delete("page");
    setParams(next);
  };

  const { data, error, loading, refresh } = useAsync(
    ({ signal }) =>
      eventApi.list(
        {
          ...(status && { status }),
          ...(kind && { kind }),
          ...(live && { live }),
          ...(cameraId && { camera_id: cameraId }),
          ...(from && { start: dayBound(from) }),
          ...(to && { end: dayBound(to, true) }),
          page,
          per_page: perPage,
        },
        { signal }
      ),
    [status, kind, live, cameraId, from, to, page, perPage]
  );

  const cameraList = useAsync(({ signal }) => cameraApi.list(undefined, { signal }), []);

  const rows = data?.events || [];
  const hasFilters = Boolean(status || kind || live || cameraId || from || to);

  return (
    <Box>
      <PageHeader
        title={t("events.incidents")}
        subtitle={t("events.everyFireAndSmokeIncident")}
        actions={[
          <ExportButton key="export" fetchBlob={() => eventApi.exportBlob({ status: status || undefined, kind: kind || undefined, live: live || undefined, camera_id: cameraId || undefined, start: from ? dayBound(from) : undefined, end: to ? dayBound(to, true) : undefined })} filenameStem="incidents" />,
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            {t("events.refresh")}
          </Button>,
        ]}
      />

      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2} flexWrap="wrap" useFlexGap>
          <TextField
            select
            label={t("events.status")}
            size="small"
            value={status}
            onChange={(event) => setParam("status", event.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">{t("events.allStatuses")}</MenuItem>
            {EVENT_STATUSES.map((value) => (
              <MenuItem key={value} value={value}>
                {titleCase(value)}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label={t("events.kind")}
            size="small"
            value={kind}
            onChange={(event) => setParam("kind", event.target.value)}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="">{t("events.fireAndSmoke")}</MenuItem>
            {EVENT_KINDS.map((value) => (
              <MenuItem key={value} value={value}>
                {titleCase(value)}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label={t("events.inView")}
            size="small"
            value={live}
            onChange={(event) => setParam("live", event.target.value)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="">{t("events.liveOrCleared")}</MenuItem>
            <MenuItem value="true">{t("events.stillLive")}</MenuItem>
            <MenuItem value="false">{t("events.cleared")}</MenuItem>
          </TextField>

          <TextField
            select
            label={t("events.camera")}
            size="small"
            value={cameraId}
            onChange={(event) => setParam("camera_id", event.target.value)}
            sx={{ minWidth: 220 }}
          >
            <MenuItem value="">{t("events.allCameras")}</MenuItem>
            {(cameraList.data || []).map((camera) => (
              <MenuItem key={camera.camera_id} value={camera.camera_id}>
                {camera.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            type="date"
            label={t("events.from")}
            size="small"
            value={from}
            onChange={(event) => setParam("from", event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            type="date"
            label={t("events.to")}
            size="small"
            value={to}
            onChange={(event) => setParam("to", event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />

          <Box sx={{ flex: 1 }} />
          {hasFilters ? (
            <Button onClick={() => setParams(new URLSearchParams())}>{t("events.clearFilters")}</Button>
          ) : null}
        </Stack>
      </Card>

      <ErrorState error={error} onRetry={refresh} />

      {loading && !data ? (
        <Loading label={t("events.loadingIncidents")} />
      ) : rows.length ? (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("events.kind")}</TableCell>
                  <TableCell>{t("events.camera")}</TableCell>
                  <TableCell>{t("events.detected")}</TableCell>
                  <TableCell align="right">{t("events.inView")}</TableCell>
                  <TableCell align="right">{t("events.peakConfidence")}</TableCell>
                  <TableCell>{t("events.status")}</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((event) => (
                  <TableRow key={event.event_id} hover data-testid="incident-row">
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Link component={RouterLink} to={`/events/${event.event_id}`} underline="none">
                          <KindChip kind={event.kind} sx={{ cursor: "pointer" }} />
                        </Link>
                        {event.live && <LiveChip live />}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {event.camera_id ? (
                        <Link
                          component={RouterLink}
                          to={`/cameras/${event.camera_id}`}
                          underline="hover"
                          color="text.secondary"
                          variant="body2"
                        >
                          {event.camera_name || t("events.unnamed")}
                        </Link>
                      ) : (
                        <Typography variant="body2" color="text.disabled">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Tooltip title={formatDateTime(event.detected_at)}>
                        <Typography variant="body2" color="text.secondary">
                          {fromNow(event.detected_at)}
                        </Typography>
                      </Tooltip>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2" color="text.secondary">
                        {formatDuration(incidentSeconds(event))}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption">{formatScore(event.peak_confidence)}</Typography>
                    </TableCell>
                    <TableCell>
                      <EventStatusChip status={event.status} />
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" component={RouterLink} to={`/events/${event.event_id}`}>
                        {t("events.review")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <TablePagination
            component="div"
            count={data?.total ?? 0}
            page={page - 1}
            rowsPerPage={perPage}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            onPageChange={(_, nextPage) => setParam("page", String(nextPage + 1))}
            onRowsPerPageChange={(event) => setParam("per_page", event.target.value)}
          />
        </Card>
      ) : (
        <Card>
          <EmptyState
            title={hasFilters ? t("events.nothingMatchesTheseFilters") : t("events.noIncidentsYet")}
            description={
              hasFilters
                ? t("events.tryWideningTheStatusKind")
                : t("events.incidentsAppearHereAsSoon")
            }
            icon={<LocalFireDepartmentIcon fontSize="inherit" />}
            action={
              hasFilters ? (
                <Button variant="outlined" onClick={() => setParams(new URLSearchParams())}>
                  {t("events.clearFilters")}
                </Button>
              ) : (
                <Button variant="outlined" component={RouterLink} to="/cameras">
                  {t("events.checkCameras")}
                </Button>
              )
            }
          />
        </Card>
      )}
    </Box>
  );
}
