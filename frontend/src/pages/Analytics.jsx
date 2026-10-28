import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid2";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";

import BlockIcon from "@mui/icons-material/Block";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import SensorsIcon from "@mui/icons-material/Sensors";
import TimerIcon from "@mui/icons-material/Timer";

import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip as ChartTooltip,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import dayjs from "dayjs";

import { analytics, cameras } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import HourHeatmap from "../components/HourHeatmap";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { KIND_COLOR, LOCATION_GROUPS } from "../utils/constants";
import { formatDateTime, formatDuration, formatNumber, formatScore } from "../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip, Legend);

const WINDOWS = [
  { value: 1, get label() { return i18n.t("analytics.last24Hours"); } },
  { value: 7, get label() { return i18n.t("analytics.last7Days"); } },
  { value: 30, get label() { return i18n.t("analytics.last30Days"); } },
  { value: 90, get label() { return i18n.t("analytics.last90Days"); } },
];

// The busiest cameras are the story; the long tail stays in the table below.
const CAMERA_CHART_LIMIT = 10;

// Buckets are cut in the viewer's zone, so "busiest hour" means their hour.
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const formatPct = (value, digits = 1) =>
  value === null || value === undefined ? "—" : `${Number(value).toFixed(digits)}%`;
const share = (part, whole) => (whole ? (100 * part) / whole : null);

// InsightEye's FireDetectionsByCameraChart shades a bar darker as the camera's
// detection rate climbs past 10% and 30% of checks.
const RATE_STEPS = [10, 30];
const rateAlpha = (rate) => (rate >= RATE_STEPS[1] ? "ff" : rate >= RATE_STEPS[0] ? "cc" : "99");

function ChartCard({ title, subtitle, children }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="subtitle2">{title}</Typography>
        {subtitle && (
          <Typography variant="caption" color="text.secondary">
            {subtitle}
          </Typography>
        )}
        <Box sx={{ mt: 2 }}>{children}</Box>
      </CardContent>
    </Card>
  );
}

/** Detected to closed, one bar per stage, scaled to the largest stage. */
function Funnel({ stages }) {
  const max = Math.max(1, ...stages.map((stage) => stage.value));
  return (
    <Stack spacing={2.25}>
      {stages.map((stage) => (
        <Box key={stage.key}>
          <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={1}>
            <Typography variant="body2">{stage.label}</Typography>
            <Typography variant="body2" fontWeight={600}>
              {formatNumber(stage.value)}
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={(100 * stage.value) / max}
            color={stage.color || "primary"}
            sx={{ height: 8, borderRadius: 4, my: 0.5 }}
          />
          {stage.caption && (
            <Typography variant="caption" color="text.secondary">
              {stage.caption}
            </Typography>
          )}
        </Box>
      ))}
    </Stack>
  );
}

/**
 * Model accuracy & confidence audit: how sure the detector was about the
 * incidents in the window, with operator verdicts standing in for ground truth.
 */
function ConfidenceAudit({ audit, baseOptions, theme, dismissed }) {
  const { t } = useTranslation();
  const summary = audit.summary;

  const histogram = useMemo(() => {
    const buckets = audit.histogram || [];
    const segment = { borderColor: theme.palette.background.paper, borderWidth: 1, borderRadius: 4 };
    return {
      data: {
        labels: buckets.map((bucket) => `${Math.round(bucket.min * 100)}–${Math.round(bucket.max * 100)}%`),
        datasets: [
          {
            label: t("analytics.incidents"),
            data: buckets.map((bucket) => bucket.count - bucket.false_positives),
            backgroundColor: KIND_COLOR.fire,
            ...segment,
          },
          {
            label: t("analytics.falsePositives"),
            data: buckets.map((bucket) => bucket.false_positives),
            backgroundColor: dismissed,
            ...segment,
          },
        ],
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...baseOptions.scales.x, stacked: true },
          y: { ...baseOptions.scales.y, stacked: true },
        },
        plugins: {
          ...baseOptions.plugins,
          tooltip: {
            callbacks: { title: (items) => (items.length ? `Confidence ${items[0].label}` : "") },
          },
        },
      },
    };
  }, [audit, baseOptions, theme, dismissed, t]);

  if (!summary.scored_events) {
    return (
      <ChartCard title={t("analytics.modelConfidenceAudit")} subtitle={t("analytics.noScoredIncidentsInThis")}>
        <Typography variant="body2" color="text.secondary">
          {t("analytics.incidentsRecordedWithoutADetector")}
        </Typography>
      </ChartCard>
    );
  }

  const facts = [
    { label: t("analytics.averageConfidence"), value: formatScore(summary.avg_confidence) },
    {
      label: t("analytics.range"),
      value: `${formatScore(summary.min_confidence, 0)} – ${formatScore(summary.max_confidence, 0)}`,
    },
    {
      label: t("analytics.belowV0", { v0: formatScore(summary.low_confidence_cutoff, 0) }),
      value: `${formatNumber(summary.low_confidence)} (${formatPct(summary.low_confidence_pct)})`,
    },
    { label: t("analytics.avgOnResolved"), value: formatScore(summary.avg_confidence_resolved) },
    { label: t("analytics.avgOnFalsePositives"), value: formatScore(summary.avg_confidence_false_positive) },
  ];

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle2">{t("analytics.modelConfidenceAudit")}</Typography>
        <Typography variant="caption" color="text.secondary">
          {t("analytics.peakDetectorConfidenceOfV0", { v0: formatNumber(summary.scored_events) })}
        </Typography>
        <Grid container spacing={3} sx={{ mt: 1 }}>
          <Grid size={{ xs: 12, lg: 8 }}>
            <Box sx={{ height: 260 }}>
              <Bar data={histogram.data} options={histogram.options} />
            </Box>
          </Grid>
          <Grid size={{ xs: 12, lg: 4 }}>
            <Stack spacing={1.25}>
              {facts.map((fact) => (
                <Stack key={fact.label} direction="row" justifyContent="space-between" spacing={2}>
                  <Typography variant="body2" color="text.secondary">
                    {fact.label}
                  </Typography>
                  <Typography variant="body2" fontWeight={600}>
                    {fact.value}
                  </Typography>
                </Stack>
              ))}
              <Typography variant="caption" color="text.disabled">
                {t("analytics.lowestPerKindThresholdV0", { v0: formatScore(summary.threshold, 0) })}
              </Typography>
            </Stack>
          </Grid>
        </Grid>
      </CardContent>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t("analytics.camera")}</TableCell>
              <TableCell align="right">{t("analytics.incidents")}</TableCell>
              <TableCell align="right">{t("analytics.avg")}</TableCell>
              <TableCell align="right">{t("analytics.minMax")}</TableCell>
              <TableCell align="right">{t("analytics.lowConfidence")}</TableCell>
              <TableCell align="right">{t("analytics.falsePositives")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {audit.by_camera.map((row) => (
              <TableRow key={row.camera_id || "deleted"} hover>
                <TableCell>{row.camera_name || t("analytics.deletedCamera")}</TableCell>
                <TableCell align="right">{formatNumber(row.events)}</TableCell>
                <TableCell align="right">{formatScore(row.avg_confidence)}</TableCell>
                <TableCell align="right">
                  {formatScore(row.min_confidence, 0)} – {formatScore(row.max_confidence, 0)}
                </TableCell>
                <TableCell align="right">{formatNumber(row.low_confidence)}</TableCell>
                <TableCell align="right">
                  {formatNumber(row.false_positives)} ({formatPct(row.false_positive_pct)})
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  );
}

export default function Analytics() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [days, setDays] = useState(7);
  const [cameraId, setCameraId] = useState("");
  const [groupBy, setGroupBy] = useState("building");
  const [threshold, setThreshold] = useState(5);

  const cameraList = useAsync(({ signal }) => cameras.list(undefined, { signal }), []);

  const { data, error, loading, refresh } = useAsync(
    ({ signal }) =>
      analytics.summary(
        { days, camera_id: cameraId || undefined, tz: TIMEZONE },
        { signal }
      ),
    [days, cameraId]
  );

  // Separate requests, so the main charts never wait on the rest.
  const audit = useAsync(
    ({ signal }) =>
      analytics.confidenceAudit(
        { days, camera_id: cameraId || undefined, tz: TIMEZONE },
        { signal }
      ),
    [days, cameraId]
  );
  const perCamera = useAsync(
    ({ signal }) => analytics.byCamera({ days, tz: TIMEZONE }, { signal }),
    [days]
  );
  const perLocation = useAsync(
    ({ signal }) => analytics.byLocation({ days, tz: TIMEZONE, group_by: groupBy }, { signal }),
    [days, groupBy]
  );
  const highRisk = useAsync(
    ({ signal }) =>
      analytics.highRisk({ days, tz: TIMEZONE, threshold_percentage: threshold }, { signal }),
    [days, threshold]
  );

  const summary = data?.data;
  const kpis = summary?.kpis;
  const hourly = summary?.window?.bucket === "hour";
  const hasEvents = Boolean(kpis?.events);
  const cameraRows = perCamera.data?.data?.cameras || [];

  // Muted grey is what a false positive already wears everywhere else in the
  // console (EVENT_STATUS_COLOR.FALSE_POSITIVE is "default"): it is noise the
  // operator dismissed, not an alarm in its own right.
  const dismissed = theme.palette.grey[500];

  const baseOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: theme.palette.text.secondary, maxRotation: 0, autoSkipPadding: 12 },
          grid: { display: false },
          border: { color: theme.palette.divider },
        },
        y: {
          beginAtZero: true,
          ticks: { color: theme.palette.text.secondary, precision: 0 },
          grid: { color: theme.palette.divider },
          border: { display: false },
        },
      },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: {
            color: theme.palette.text.secondary,
            boxWidth: 10,
            boxHeight: 10,
            useBorderRadius: true,
            borderRadius: 2,
          },
        },
      },
    }),
    [theme]
  );

  // A 1px surface-coloured edge on each segment leaves a 2px gap between them.
  const segment = useMemo(
    () => ({
      borderColor: theme.palette.background.paper,
      borderWidth: 1,
      borderSkipped: false,
      borderRadius: 4,
    }),
    [theme]
  );

  const trend = useMemo(() => {
    const points = summary?.series || [];
    return {
      data: {
        labels: points.map((point) =>
          dayjs(point.bucket_start).format(hourly ? "HH:mm" : "MMM D")
        ),
        datasets: [
          { label: t("analytics.fire"), data: points.map((point) => point.fire), backgroundColor: KIND_COLOR.fire, ...segment },
          { label: t("analytics.smoke"), data: points.map((point) => point.smoke), backgroundColor: KIND_COLOR.smoke, ...segment },
        ],
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...baseOptions.scales.x, stacked: true },
          y: { ...baseOptions.scales.y, stacked: true },
        },
        plugins: {
          ...baseOptions.plugins,
          tooltip: {
            callbacks: {
              title: (items) =>
                items.length
                  ? dayjs(points[items[0].dataIndex].bucket_start).format(
                      hourly ? "ddd MMM D, HH:00" : "ddd MMM D"
                    )
                  : "",
              footer: (items) => {
                const point = items.length ? points[items[0].dataIndex] : null;
                return point?.false_positives ? `${point.false_positives} dismissed as false` : "";
              },
            },
          },
        },
      },
    };
  }, [summary, hourly, baseOptions, segment, t]);

  // InsightEye's "Fire & Smoke Detections by Camera", over incidents.
  const byCamera = useMemo(() => {
    const rows = cameraRows.filter((row) => row.total_events).slice(0, CAMERA_CHART_LIMIT);
    const tooltipLines = (row, kind) => {
      const rate = row[`${kind}_detection_rate`];
      const first = row[`first_${kind}`];
      const last = row[`last_${kind}`];
      return [
        `${kind === "fire" ? "Fire" : "Smoke"}: ${formatNumber(row[`${kind}_events`])} incident(s)`,
        `  ${formatPct(rate, 2)} of ${formatNumber(row.checks)} checks`,
        `  on ${formatNumber(row[`days_with_${kind}`])} day(s)`,
        ...(first ? [`  first ${formatDateTime(first)}`, `  last ${formatDateTime(last)}`] : []),
      ];
    };
    return {
      height: Math.max(160, rows.length * 34 + 48),
      data: {
        labels: rows.map((row) => row.camera_name),
        datasets: ["fire", "smoke"].map((kind) => ({
          label: kind === "fire" ? "Fire" : "Smoke",
          data: rows.map((row) => row[`${kind}_events`]),
          backgroundColor: rows.map(
            (row) => KIND_COLOR[kind] + rateAlpha(row[`${kind}_detection_rate`] || 0)
          ),
          ...segment,
          barThickness: 14,
        })),
      },
      options: {
        ...baseOptions,
        indexAxis: "y",
        interaction: { mode: "index", axis: "y", intersect: false },
        scales: { x: baseOptions.scales.y, y: baseOptions.scales.x },
        plugins: {
          ...baseOptions.plugins,
          legend: {
            ...baseOptions.plugins.legend,
            labels: {
              ...baseOptions.plugins.legend.labels,
              // Bars are shaded by rate; the legend shows the kind's own colour.
              generateLabels: (chart) =>
                ChartJS.defaults.plugins.legend.labels
                  .generateLabels(chart)
                  .map((label, i) => ({ ...label, fillStyle: i === 0 ? KIND_COLOR.fire : KIND_COLOR.smoke })),
            },
          },
          tooltip: {
            callbacks: {
              label: (item) => tooltipLines(rows[item.dataIndex], item.datasetIndex === 0 ? "fire" : "smoke"),
            },
          },
        },
      },
    };
  }, [cameraRows, baseOptions, segment]);

  const byHour = useMemo(() => {
    const rows = summary?.by_hour || [];
    return {
      data: {
        labels: rows.map((row) => String(row.hour).padStart(2, "0")),
        datasets: [
          { label: t("analytics.fire"), data: rows.map((row) => row.fire), backgroundColor: KIND_COLOR.fire, ...segment },
          { label: t("analytics.smoke"), data: rows.map((row) => row.smoke), backgroundColor: KIND_COLOR.smoke, ...segment },
        ],
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...baseOptions.scales.x, stacked: true },
          y: { ...baseOptions.scales.y, stacked: true },
        },
        plugins: {
          ...baseOptions.plugins,
          tooltip: { callbacks: { title: (items) => (items.length ? `${items[0].label}:00` : "") } },
        },
      },
    };
  }, [summary, baseOptions, segment, t]);

  const funnel = summary?.funnel;
  const funnelStages = funnel
    ? [
        { key: "detected", label: t("analytics.incidentsDetected"), value: funnel.detected, color: "error" },
        {
          key: "acknowledged",
          label: t("analytics.acknowledged"),
          value: funnel.acknowledged,
          color: "warning",
          caption: funnel.detected
            ? `${formatPct(share(funnel.acknowledged, funnel.detected))} · median ${formatDuration(kpis.median_ack_s)} to acknowledge`
            : null,
        },
        {
          key: "resolved",
          label: t("analytics.resolved"),
          value: funnel.resolved,
          color: "success",
          caption: funnel.detected
            ? `${formatPct(share(funnel.resolved, funnel.detected))} · median ${formatDuration(kpis.median_resolve_s)} to resolve`
            : null,
        },
        {
          key: "false",
          label: t("analytics.falsePositives"),
          value: funnel.false_positives,
          color: "inherit",
          caption: funnel.detected ? `${formatPct(share(funnel.false_positives, funnel.detected))} of incidents` : null,
        },
      ]
    : [];

  const windowLabel = WINDOWS.find((option) => option.value === days)?.label.toLowerCase();
  const groupLabel = LOCATION_GROUPS.find((g) => g.value === groupBy)?.label || "Group";

  return (
    <Box>
      <PageHeader
        title={t("analytics.analytics")}
        subtitle={t("analytics.fireAndSmokeIncidentsWhen", { TIMEZONE })}
        actions={
          <>
            <TextField
              select
              size="small"
              label={t("analytics.camera")}
              value={cameraId}
              onChange={(event) => setCameraId(event.target.value)}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="">{t("analytics.allCameras")}</MenuItem>
              {(cameraList.data || []).map((camera) => (
                <MenuItem key={camera.camera_id} value={camera.camera_id}>
                  {camera.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label={t("analytics.window")}
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              sx={{ minWidth: 160 }}
            >
              {WINDOWS.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
          </>
        }
      />

      <ErrorState error={error} onRetry={refresh} title={t("analytics.couldNotLoadAnalytics")} />

      {!summary && loading ? (
        <Loading label={t("analytics.aggregating")} height={360} />
      ) : summary ? (
        // A refetch dims the previous numbers instead of blanking the page.
        <Box sx={{ opacity: loading ? 0.55 : 1, transition: "opacity 150ms" }}>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label={t("analytics.incidents")}
                value={formatNumber(kpis.events)}
                hint={t("analytics.v0FireV1SmokeV2", { v0: formatNumber(kpis.fire), v1: formatNumber(kpis.smoke), v2: formatNumber(kpis.open) })}
                icon={<LocalFireDepartmentIcon />}
                color="error"
              />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label={t("analytics.detectionRate")}
                value={formatPct(
                  kpis.checks ? (kpis.fire_detection_rate || 0) + (kpis.smoke_detection_rate || 0) : null,
                  2
                )}
                hint={t("analytics.fireV0SmokeV1Of", { v0: formatPct(kpis.fire_detection_rate, 2), v1: formatPct(kpis.smoke_detection_rate, 2), v2: formatNumber(kpis.checks) })}
                icon={<SensorsIcon />}
                color="warning"
              />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label={t("analytics.medianTimeToAcknowledge")}
                value={formatDuration(kpis.median_ack_s)}
                hint={t("analytics.resolveV0InViewV1", { v0: formatDuration(kpis.median_resolve_s), v1: formatDuration(kpis.avg_duration_s) })}
                icon={<TimerIcon />}
                color="info"
              />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label={t("analytics.falsePositiveRate")}
                value={formatPct(kpis.false_positive_pct)}
                hint={t("analytics.v0DismissedV1CameraS", { v0: formatNumber(kpis.false_positives), v1: formatNumber(kpis.cameras_affected) })}
                icon={<BlockIcon />}
                color="secondary"
              />
            </Grid>
          </Grid>

          {!hasEvents ? (
            <Card sx={{ mb: 2 }}>
              <EmptyState
                title={t("analytics.noIncidentsInTheWindowlabel", { windowLabel })}
                description={t("analytics.noCameraConfirmedFireOr")}
              />
            </Card>
          ) : (
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid size={12}>
                <ChartCard
                  title={hourly ? t("analytics.incidentsPerHour") : t("analytics.incidentsPerDay")}
                  subtitle={t("analytics.v0FireAndV1Smoke", { v0: formatNumber(kpis.fire), v1: formatNumber(kpis.smoke) })}
                >
                  <Box sx={{ height: 280 }}>
                    <Bar data={trend.data} options={trend.options} />
                  </Box>
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 6 }}>
                <ChartCard
                  title={t("analytics.fireSmokeByCamera")}
                  subtitle={t("analytics.incidentsPerCameraAllCameras")}
                >
                  {byCamera.data.labels.length ? (
                    <Box sx={{ height: byCamera.height }}>
                      <Bar data={byCamera.data} options={byCamera.options} />
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {perCamera.error || t("analytics.loading")}
                    </Typography>
                  )}
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 6 }}>
                <ChartCard title={t("analytics.byHourOfDay")} subtitle={t("analytics.whenIncidentsAreConfirmed")}>
                  <Box sx={{ height: 260 }}>
                    <Bar data={byHour.data} options={byHour.options} />
                  </Box>
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 8 }}>
                <ChartCard
                  title={t("analytics.weekdayHour")}
                  subtitle={t("analytics.incidentsByWeekdayAndHour")}
                >
                  <HourHeatmap cells={summary.heatmap} />
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 4 }}>
                <ChartCard title={t("analytics.triage")} subtitle={t("analytics.overTheWindowlabel", { windowLabel })}>
                  <Funnel stages={funnelStages} />
                </ChartCard>
              </Grid>

              <Grid size={12}>
                {audit.data?.data ? (
                  <ConfidenceAudit
                    audit={audit.data.data}
                    baseOptions={baseOptions}
                    theme={theme}
                    dismissed={dismissed}
                  />
                ) : (
                  <ErrorState
                    error={audit.error}
                    onRetry={audit.refresh}
                    title={t("analytics.couldNotLoadTheConfidence")}
                  />
                )}
              </Grid>
            </Grid>
          )}

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, lg: 6 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent sx={{ pb: 0 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                    <Box>
                      <Typography variant="subtitle2">{t("analytics.highRiskCameras")}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {t("analytics.atOrAboveTheDetection")}
                      </Typography>
                    </Box>
                    <TextField
                      size="small"
                      type="number"
                      label={t("analytics.threshold")}
                      value={threshold}
                      onChange={(event) =>
                        setThreshold(Math.min(100, Math.max(0, Number(event.target.value) || 0)))
                      }
                      slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
                      sx={{ width: 120 }}
                    />
                  </Stack>
                </CardContent>
                <ErrorState error={highRisk.error} onRetry={highRisk.refresh} />
                <TableContainer>
                  <Table size="small" data-testid="high-risk-table">
                    <TableHead>
                      <TableRow>
                        <TableCell>{t("analytics.camera")}</TableCell>
                        <TableCell align="right">{t("analytics.fire")}</TableCell>
                        <TableCell align="right">{t("analytics.smoke")}</TableCell>
                        <TableCell align="right">{t("analytics.detectionRate")}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(highRisk.data?.data?.cameras || []).map((row) => (
                        <TableRow key={row.camera_id} hover>
                          <TableCell>
                            <Button size="small" component={RouterLink} to={`/cameras/${row.camera_id}`} sx={{ p: 0, minWidth: 0 }}>
                              {row.camera_name}
                            </Button>
                          </TableCell>
                          <TableCell align="right">{formatNumber(row.fire_events)}</TableCell>
                          <TableCell align="right">{formatNumber(row.smoke_events)}</TableCell>
                          <TableCell align="right">{formatPct(row.total_detection_rate, 2)}</TableCell>
                        </TableRow>
                      ))}
                      {highRisk.data && !highRisk.data.data.cameras.length ? (
                        <TableRow>
                          <TableCell colSpan={4}>
                            <Typography variant="body2" color="text.secondary">
                              {t("analytics.noCameraReachesThresholdIn", { threshold, windowLabel })}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Card>
            </Grid>

            <Grid size={{ xs: 12, lg: 6 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent sx={{ pb: 0 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                    <Box>
                      <Typography variant="subtitle2">{t("analytics.byLocation")}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {t("analytics.everyCameraSNumbersAdded", { v0: groupLabel.toLowerCase() })}
                      </Typography>
                    </Box>
                    <TextField
                      select
                      size="small"
                      label={t("analytics.groupBy")}
                      value={groupBy}
                      onChange={(event) => setGroupBy(event.target.value)}
                      sx={{ minWidth: 140 }}
                    >
                      {LOCATION_GROUPS.map((group) => (
                        <MenuItem key={group.value} value={group.value}>
                          {group.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Stack>
                </CardContent>
                <ErrorState error={perLocation.error} onRetry={perLocation.refresh} />
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>{groupLabel}</TableCell>
                        <TableCell align="right">{t("analytics.cameras")}</TableCell>
                        <TableCell align="right">{t("analytics.fire")}</TableCell>
                        <TableCell align="right">{t("analytics.smoke")}</TableCell>
                        <TableCell align="right">{t("analytics.detectionRate")}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(perLocation.data?.data?.groups || []).map((row) => (
                        <TableRow key={row.group_name} hover>
                          <TableCell>{row.group_name}</TableCell>
                          <TableCell align="right">{formatNumber(row.cameras)}</TableCell>
                          <TableCell align="right">{formatNumber(row.fire_events)}</TableCell>
                          <TableCell align="right">{formatNumber(row.smoke_events)}</TableCell>
                          <TableCell align="right">{formatPct(row.total_detection_rate, 2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Card>
            </Grid>

            <Grid size={12}>
              <Card>
                <CardContent sx={{ pb: 0 }}>
                  <Typography variant="subtitle2">{t("analytics.cameraBreakdown")}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t("analytics.detectionRateIsTheShare")}
                  </Typography>
                </CardContent>
                <ErrorState error={perCamera.error} onRetry={perCamera.refresh} />
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>{t("analytics.camera")}</TableCell>
                        <TableCell align="right">{t("analytics.fire")}</TableCell>
                        <TableCell align="right">{t("analytics.smoke")}</TableCell>
                        <TableCell align="right">{t("analytics.daysFireSmoke")}</TableCell>
                        <TableCell align="right">{t("analytics.fireRate")}</TableCell>
                        <TableCell align="right">{t("analytics.smokeRate")}</TableCell>
                        <TableCell align="right">{t("analytics.checks")}</TableCell>
                        <TableCell>{t("analytics.lastFire")}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {cameraRows.map((row) => (
                        <TableRow key={row.camera_id} hover>
                          <TableCell>
                            <Button size="small" component={RouterLink} to={`/cameras/${row.camera_id}`} sx={{ p: 0, minWidth: 0 }}>
                              {row.camera_name}
                            </Button>
                          </TableCell>
                          <TableCell align="right">{formatNumber(row.fire_events)}</TableCell>
                          <TableCell align="right">{formatNumber(row.smoke_events)}</TableCell>
                          <TableCell align="right">
                            {formatNumber(row.days_with_fire)} / {formatNumber(row.days_with_smoke)}
                          </TableCell>
                          <TableCell align="right">{formatPct(row.fire_detection_rate, 2)}</TableCell>
                          <TableCell align="right">{formatPct(row.smoke_detection_rate, 2)}</TableCell>
                          <TableCell align="right">{formatNumber(row.checks)}</TableCell>
                          <TableCell>{row.last_fire ? formatDateTime(row.last_fire) : "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Card>
            </Grid>
          </Grid>
        </Box>
      ) : null}
    </Box>
  );
}
