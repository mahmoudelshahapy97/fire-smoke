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

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip, Legend);

const WINDOWS = [
  { value: 1, label: "Last 24 hours" },
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
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
  const summary = audit.summary;

  const histogram = useMemo(() => {
    const buckets = audit.histogram || [];
    const segment = { borderColor: theme.palette.background.paper, borderWidth: 1, borderRadius: 4 };
    return {
      data: {
        labels: buckets.map((bucket) => `${Math.round(bucket.min * 100)}–${Math.round(bucket.max * 100)}%`),
        datasets: [
          {
            label: "Incidents",
            data: buckets.map((bucket) => bucket.count - bucket.false_positives),
            backgroundColor: KIND_COLOR.fire,
            ...segment,
          },
          {
            label: "False positives",
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
  }, [audit, baseOptions, theme, dismissed]);

  if (!summary.scored_events) {
    return (
      <ChartCard title="Model confidence audit" subtitle="No scored incidents in this window">
        <Typography variant="body2" color="text.secondary">
          Incidents recorded without a detector confidence are left out of the audit.
        </Typography>
      </ChartCard>
    );
  }

  const facts = [
    { label: "Average confidence", value: formatScore(summary.avg_confidence) },
    {
      label: "Range",
      value: `${formatScore(summary.min_confidence, 0)} – ${formatScore(summary.max_confidence, 0)}`,
    },
    {
      label: `Below ${formatScore(summary.low_confidence_cutoff, 0)}`,
      value: `${formatNumber(summary.low_confidence)} (${formatPct(summary.low_confidence_pct)})`,
    },
    { label: "Avg on resolved", value: formatScore(summary.avg_confidence_resolved) },
    { label: "Avg on false positives", value: formatScore(summary.avg_confidence_false_positive) },
  ];

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle2">Model confidence audit</Typography>
        <Typography variant="caption" color="text.secondary">
          Peak detector confidence of {formatNumber(summary.scored_events)} incidents. Operator
          verdicts stand in for ground truth: false positives clustering at low confidence point to
          the threshold, high-confidence ones to the scene.
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
                Lowest per-kind threshold {formatScore(summary.threshold, 0)}: a box below it is
                never counted.
              </Typography>
            </Stack>
          </Grid>
        </Grid>
      </CardContent>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Camera</TableCell>
              <TableCell align="right">Incidents</TableCell>
              <TableCell align="right">Avg</TableCell>
              <TableCell align="right">Min – max</TableCell>
              <TableCell align="right">Low confidence</TableCell>
              <TableCell align="right">False positives</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {audit.by_camera.map((row) => (
              <TableRow key={row.camera_id || "deleted"} hover>
                <TableCell>{row.camera_name || "Deleted camera"}</TableCell>
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
          { label: "Fire", data: points.map((point) => point.fire), backgroundColor: KIND_COLOR.fire, ...segment },
          { label: "Smoke", data: points.map((point) => point.smoke), backgroundColor: KIND_COLOR.smoke, ...segment },
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
  }, [summary, hourly, baseOptions, segment]);

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
          { label: "Fire", data: rows.map((row) => row.fire), backgroundColor: KIND_COLOR.fire, ...segment },
          { label: "Smoke", data: rows.map((row) => row.smoke), backgroundColor: KIND_COLOR.smoke, ...segment },
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
  }, [summary, baseOptions, segment]);

  const funnel = summary?.funnel;
  const funnelStages = funnel
    ? [
        { key: "detected", label: "Incidents detected", value: funnel.detected, color: "error" },
        {
          key: "acknowledged",
          label: "Acknowledged",
          value: funnel.acknowledged,
          color: "warning",
          caption: funnel.detected
            ? `${formatPct(share(funnel.acknowledged, funnel.detected))} · median ${formatDuration(kpis.median_ack_s)} to acknowledge`
            : null,
        },
        {
          key: "resolved",
          label: "Resolved",
          value: funnel.resolved,
          color: "success",
          caption: funnel.detected
            ? `${formatPct(share(funnel.resolved, funnel.detected))} · median ${formatDuration(kpis.median_resolve_s)} to resolve`
            : null,
        },
        {
          key: "false",
          label: "False positives",
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
        title="Analytics"
        subtitle={`Fire and smoke incidents: when, where, how often the detector sees them, and how fast they were handled. Times in ${TIMEZONE}.`}
        actions={
          <>
            <TextField
              select
              size="small"
              label="Camera"
              value={cameraId}
              onChange={(event) => setCameraId(event.target.value)}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="">All cameras</MenuItem>
              {(cameraList.data || []).map((camera) => (
                <MenuItem key={camera.camera_id} value={camera.camera_id}>
                  {camera.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="Window"
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

      <ErrorState error={error} onRetry={refresh} title="Could not load analytics" />

      {!summary && loading ? (
        <Loading label="Aggregating…" height={360} />
      ) : summary ? (
        // A refetch dims the previous numbers instead of blanking the page.
        <Box sx={{ opacity: loading ? 0.55 : 1, transition: "opacity 150ms" }}>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label="Incidents"
                value={formatNumber(kpis.events)}
                hint={`${formatNumber(kpis.fire)} fire · ${formatNumber(kpis.smoke)} smoke · ${formatNumber(kpis.open)} open`}
                icon={<LocalFireDepartmentIcon />}
                color="error"
              />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label="Detection rate"
                value={formatPct(
                  kpis.checks ? (kpis.fire_detection_rate || 0) + (kpis.smoke_detection_rate || 0) : null,
                  2
                )}
                hint={`fire ${formatPct(kpis.fire_detection_rate, 2)} · smoke ${formatPct(kpis.smoke_detection_rate, 2)} of ${formatNumber(kpis.checks)} checks`}
                icon={<SensorsIcon />}
                color="warning"
              />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label="Median time to acknowledge"
                value={formatDuration(kpis.median_ack_s)}
                hint={`resolve: ${formatDuration(kpis.median_resolve_s)} · in view ${formatDuration(kpis.avg_duration_s)} on average`}
                icon={<TimerIcon />}
                color="info"
              />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard
                label="False-positive rate"
                value={formatPct(kpis.false_positive_pct)}
                hint={`${formatNumber(kpis.false_positives)} dismissed · ${formatNumber(kpis.cameras_affected)} camera(s) affected`}
                icon={<BlockIcon />}
                color="secondary"
              />
            </Grid>
          </Grid>

          {!hasEvents ? (
            <Card sx={{ mb: 2 }}>
              <EmptyState
                title={`No incidents in the ${windowLabel}`}
                description="No camera confirmed fire or smoke in this window. Try a longer window or another camera."
              />
            </Card>
          ) : (
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid size={12}>
                <ChartCard
                  title={hourly ? "Incidents per hour" : "Incidents per day"}
                  subtitle={`${formatNumber(kpis.fire)} fire and ${formatNumber(kpis.smoke)} smoke incidents`}
                >
                  <Box sx={{ height: 280 }}>
                    <Bar data={trend.data} options={trend.options} />
                  </Box>
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 6 }}>
                <ChartCard
                  title="Fire & smoke by camera"
                  subtitle="Incidents per camera, all cameras; darker bars see it in more of their checks (10% / 30%)"
                >
                  {byCamera.data.labels.length ? (
                    <Box sx={{ height: byCamera.height }}>
                      <Bar data={byCamera.data} options={byCamera.options} />
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {perCamera.error || "Loading…"}
                    </Typography>
                  )}
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 6 }}>
                <ChartCard title="By hour of day" subtitle="When incidents are confirmed">
                  <Box sx={{ height: 260 }}>
                    <Bar data={byHour.data} options={byHour.options} />
                  </Box>
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 8 }}>
                <ChartCard
                  title="Weekday × hour"
                  subtitle="Incidents by weekday and hour of day — hover a cell for the count"
                >
                  <HourHeatmap cells={summary.heatmap} />
                </ChartCard>
              </Grid>

              <Grid size={{ xs: 12, lg: 4 }}>
                <ChartCard title="Triage" subtitle={`Over the ${windowLabel}`}>
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
                    title="Could not load the confidence audit"
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
                      <Typography variant="subtitle2">High-risk cameras</Typography>
                      <Typography variant="caption" color="text.secondary">
                        At or above the detection-rate threshold, or with any fire incident.
                      </Typography>
                    </Box>
                    <TextField
                      size="small"
                      type="number"
                      label="Threshold %"
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
                        <TableCell>Camera</TableCell>
                        <TableCell align="right">Fire</TableCell>
                        <TableCell align="right">Smoke</TableCell>
                        <TableCell align="right">Detection rate</TableCell>
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
                              No camera reaches {threshold}% in the {windowLabel}.
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
                      <Typography variant="subtitle2">By location</Typography>
                      <Typography variant="caption" color="text.secondary">
                        Every camera's numbers added up per {groupLabel.toLowerCase()}.
                      </Typography>
                    </Box>
                    <TextField
                      select
                      size="small"
                      label="Group by"
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
                        <TableCell align="right">Cameras</TableCell>
                        <TableCell align="right">Fire</TableCell>
                        <TableCell align="right">Smoke</TableCell>
                        <TableCell align="right">Detection rate</TableCell>
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
                  <Typography variant="subtitle2">Camera breakdown</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Detection rate is the share of the detector's checks that saw fire or smoke; days
                    count the days with at least one incident.
                  </Typography>
                </CardContent>
                <ErrorState error={perCamera.error} onRetry={perCamera.refresh} />
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Camera</TableCell>
                        <TableCell align="right">Fire</TableCell>
                        <TableCell align="right">Smoke</TableCell>
                        <TableCell align="right">Days (fire / smoke)</TableCell>
                        <TableCell align="right">Fire rate</TableCell>
                        <TableCell align="right">Smoke rate</TableCell>
                        <TableCell align="right">Checks</TableCell>
                        <TableCell>Last fire</TableCell>
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
