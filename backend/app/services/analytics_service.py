# app/services/analytics_service.py
"""Windowed aggregates behind the Analytics page.

The incident counts come from fire_event; detection *rates* ("fire in 3% of
checks", InsightEye's /analytics/fire/* numbers) come from
detection_sample_hourly. Everything is narrowed to a time window and
optionally one camera. Time buckets are cut in the viewer's timezone: "busiest
hour" is only useful in the hours the operator actually lives in, and a UTC
heatmap is off by the local offset.
"""

import logging
from datetime import timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple
from uuid import UUID

import asyncpg

from app.core.config import config
from app.core.database import db_manager

logger = logging.getLogger(__name__)


HISTOGRAM_BUCKETS = 10
LATEST_EVENTS = 50

# What analytics may group cameras by (InsightEye's group_by values).
LOCATION_GROUPS = ("building", "floor_level", "zone", "area", "location")


def _num(value: Any) -> Optional[float]:
    """numeric/Decimal and double alike, as a plain float (or None)."""
    return float(value) if value is not None else None


def _pct(part: int, whole: int) -> Optional[float]:
    return round(100.0 * part / whole, 1) if whole else None


def _rate(part: Optional[int], whole: Optional[int]) -> Optional[float]:
    """Share of checks, in percent with two decimals: detection rates are small."""
    return round(100.0 * (part or 0) / whole, 2) if whole else None


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if value is not None else None


class AnalyticsService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def _window(self, days: int, tz: str) -> Dict[str, Any]:
        """The bucket grid, computed by Postgres so its tz database is the one used.

        One day is the last 24 hourly buckets; anything longer is ``days`` daily
        buckets ending with today. Both are aligned to bucket boundaries in
        ``tz``, so the first bucket is never a partial one.
        """
        bucket = "hour" if days == 1 else "day"
        step = timedelta(hours=1) if bucket == "hour" else timedelta(days=1)
        count = 24 if bucket == "hour" else days
        try:
            row = await self.db_manager.execute_query(
                """
                WITH t AS (SELECT date_trunc($1, NOW() AT TIME ZONE $2) AS end_local)
                SELECT end_local,
                       end_local - $3::interval                    AS start_local,
                       (end_local - $3::interval) AT TIME ZONE $2  AS start_at,
                       NOW()                                       AS now
                FROM t
                """,
                (bucket, tz, step * (count - 1)),
                fetch_one=True,
            )
        except asyncpg.exceptions.InvalidParameterValueError as e:
            # "time zone ... not recognized" - the caller's input, not our fault.
            raise ValueError(f"Unknown timezone: {tz}") from e
        return {"bucket": bucket, "step": step, **row}

    @staticmethod
    def _scope(
        start_at: Any, workspace_id: Optional[UUID], camera_id: Optional[UUID]
    ) -> Tuple[Tuple[Any, ...], str, str]:
        """(params, incident filter, camera filter) shared by every query.

        $1 is the window start, $2 the workspace (NULL = all of them), $3 the
        camera when one is given. The camera filter applies to ``c`` (camera).
        """
        base: Tuple[Any, ...] = (start_at, workspace_id) + ((camera_id,) if camera_id else ())
        workspace = "($2::uuid IS NULL OR {a}.workspace_id = $2)"
        event_where = "e.detected_at >= $1 AND " + workspace.format(a="e") + (
            " AND e.camera_id = $3" if camera_id else ""
        )
        camera_where = workspace.format(a="c") + (" AND c.camera_id = $3" if camera_id else "")
        return base, event_where, camera_where

    async def summary(
        self,
        days: int = 7,
        camera_id: Optional[UUID] = None,
        tz: str = "UTC",
        workspace_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        window = await self._window(days, tz)
        start_at = window["start_at"]

        base, event_where, camera_where = self._scope(start_at, workspace_id, camera_id)
        n = len(base)

        totals = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*)                                          AS events,
                   COUNT(*) FILTER (WHERE kind = 'fire')             AS fire,
                   COUNT(*) FILTER (WHERE kind = 'smoke')            AS smoke,
                   COUNT(*) FILTER (WHERE status = 'OPEN')           AS open,
                   COUNT(*) FILTER (WHERE cleared_at IS NULL)        AS live,
                   COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED')   AS acknowledged,
                   COUNT(*) FILTER (WHERE status = 'RESOLVED')       AS resolved,
                   COUNT(*) FILTER (WHERE status = 'FALSE_POSITIVE') AS false_positives,
                   COUNT(DISTINCT camera_id)                         AS cameras_affected,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (
                       ORDER BY EXTRACT(EPOCH FROM (acknowledged_at - detected_at))
                   ) FILTER (WHERE acknowledged_at IS NOT NULL)      AS median_ack_s,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (
                       ORDER BY EXTRACT(EPOCH FROM (resolved_at - detected_at))
                   ) FILTER (WHERE resolved_at IS NOT NULL)          AS median_resolve_s,
                   AVG(EXTRACT(EPOCH FROM (COALESCE(cleared_at, last_seen_at) - started_at)))
                                                                     AS avg_duration_s
            FROM fire_event e
            WHERE {event_where}
            """,
            base,
            fetch_one=True,
        )

        samples = await self.db_manager.execute_query(
            f"""
            SELECT COALESCE(SUM(s.checks), 0)     AS checks,
                   COALESCE(SUM(s.fire_hits), 0)  AS fire_hits,
                   COALESCE(SUM(s.smoke_hits), 0) AS smoke_hits
            FROM detection_sample_hourly s
            JOIN camera c ON c.camera_id = s.camera_id
            WHERE s.hour >= date_trunc('hour', $1::timestamptz) AND {camera_where}
            """,
            base,
            fetch_one=True,
        )

        # generate_series supplies the empty buckets a GROUP BY would drop.
        series_rows = await self.db_manager.execute_query(
            f"""
            WITH buckets AS (
                SELECT generate_series(${n + 1}::timestamp, ${n + 2}::timestamp, ${n + 3}::interval)
                       AS bucket_start
            ),
            ev AS (
                SELECT date_trunc(${n + 4}, e.detected_at AT TIME ZONE ${n + 5}) AS bucket_start,
                       e.kind, e.status
                FROM fire_event e
                WHERE {event_where}
            )
            SELECT b.bucket_start,
                   COUNT(ev.kind)                                       AS events,
                   COUNT(*) FILTER (WHERE ev.kind = 'fire')             AS fire,
                   COUNT(*) FILTER (WHERE ev.kind = 'smoke')            AS smoke,
                   COUNT(*) FILTER (WHERE ev.status = 'FALSE_POSITIVE') AS false_positives
            FROM buckets b
            LEFT JOIN ev ON ev.bucket_start = b.bucket_start
            GROUP BY b.bucket_start
            ORDER BY b.bucket_start
            """,
            base
            + (window["start_local"], window["end_local"], window["step"], window["bucket"], tz),
            fetch_all=True,
        )

        heatmap_rows = await self.db_manager.execute_query(
            f"""
            SELECT EXTRACT(DOW  FROM e.detected_at AT TIME ZONE ${n + 1})::int AS weekday,
                   EXTRACT(HOUR FROM e.detected_at AT TIME ZONE ${n + 1})::int AS hour,
                   COUNT(*)                                                  AS events,
                   COUNT(*) FILTER (WHERE e.kind = 'fire')                   AS fire,
                   COUNT(*) FILTER (WHERE e.kind = 'smoke')                  AS smoke
            FROM fire_event e
            WHERE {event_where}
            GROUP BY weekday, hour
            ORDER BY weekday, hour
            """,
            base + (tz,),
            fetch_all=True,
        )

        kind_rows = await self.db_manager.execute_query(
            f"""
            SELECT e.kind,
                   COUNT(*)                                            AS events,
                   AVG(e.peak_confidence)                              AS avg_confidence,
                   COUNT(*) FILTER (WHERE e.status = 'FALSE_POSITIVE') AS false_positives,
                   AVG(EXTRACT(EPOCH FROM (COALESCE(e.cleared_at, e.last_seen_at) - e.started_at)))
                                                                       AS avg_duration_s
            FROM fire_event e
            WHERE {event_where}
            GROUP BY e.kind
            ORDER BY events DESC, e.kind
            """,
            base,
            fetch_all=True,
        )

        events = totals["events"]
        kpis = {
            "events": events,
            "fire": totals["fire"],
            "smoke": totals["smoke"],
            "open": totals["open"],
            "live": totals["live"],
            "cameras_affected": totals["cameras_affected"],
            "false_positives": totals["false_positives"],
            "false_positive_pct": _pct(totals["false_positives"], events),
            "median_ack_s": _num(totals["median_ack_s"]),
            "median_resolve_s": _num(totals["median_resolve_s"]),
            "avg_duration_s": _num(totals["avg_duration_s"]),
            "checks": samples["checks"],
            "fire_detection_rate": _rate(samples["fire_hits"], samples["checks"]),
            "smoke_detection_rate": _rate(samples["smoke_hits"], samples["checks"]),
        }

        by_hour = {h: {"hour": h, "events": 0, "fire": 0, "smoke": 0} for h in range(24)}
        by_weekday = {d: {"weekday": d, "events": 0, "fire": 0, "smoke": 0} for d in range(7)}
        for row in heatmap_rows:
            for bucket in (by_hour[row["hour"]], by_weekday[row["weekday"]]):
                for key in ("events", "fire", "smoke"):
                    bucket[key] += row[key]

        return {
            "window": {
                "start": start_at,
                "end": window["now"],
                "bucket": window["bucket"],
                "tz": tz,
            },
            "kpis": kpis,
            # Naive local timestamps: they are wall-clock times in ``tz``.
            "series": [
                {
                    "bucket_start": row["bucket_start"].isoformat(),
                    "events": row["events"],
                    "fire": row["fire"],
                    "smoke": row["smoke"],
                    "false_positives": row["false_positives"],
                }
                for row in series_rows
            ],
            "heatmap": [
                {"weekday": r["weekday"], "hour": r["hour"], "events": r["events"]} for r in heatmap_rows
            ],
            "by_hour": list(by_hour.values()),
            "by_weekday": list(by_weekday.values()),
            "by_kind": [
                {
                    **row,
                    "avg_confidence": _num(row["avg_confidence"]),
                    "avg_duration_s": _num(row["avg_duration_s"]),
                    "false_positive_pct": _pct(row["false_positives"], row["events"]),
                }
                for row in kind_rows
            ],
            "funnel": {
                "detected": events,
                "acknowledged": events - totals["open"],
                "resolved": totals["resolved"],
                "false_positives": totals["false_positives"],
            },
        }

    async def _camera_rows(
        self,
        days: int,
        tz: str,
        workspace_id: Optional[UUID],
        camera_id: Optional[UUID] = None,
    ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """(window, one row per camera of the workspace) with incident counts,
        days with fire / smoke, first and last sightings and detection rates --
        InsightEye's /analytics/fire/detections-by-camera, over incidents."""
        window = await self._window(days, tz)
        base, _, camera_where = self._scope(window["start_at"], workspace_id, camera_id)
        n = len(base)
        rows = await self.db_manager.execute_query(
            f"""
            WITH ev AS (
                SELECT e.camera_id,
                       COUNT(*) FILTER (WHERE e.kind = 'fire')                       AS fire_events,
                       COUNT(*) FILTER (WHERE e.kind = 'smoke')                      AS smoke_events,
                       COUNT(*) FILTER (WHERE e.status = 'FALSE_POSITIVE')           AS false_positives,
                       COUNT(*) FILTER (WHERE e.status = 'OPEN')                     AS open,
                       COUNT(DISTINCT (e.detected_at AT TIME ZONE ${n + 1})::date)
                           FILTER (WHERE e.kind = 'fire')                            AS days_with_fire,
                       COUNT(DISTINCT (e.detected_at AT TIME ZONE ${n + 1})::date)
                           FILTER (WHERE e.kind = 'smoke')                           AS days_with_smoke,
                       COUNT(DISTINCT (e.detected_at AT TIME ZONE ${n + 1})::date)  AS days_with_any,
                       MIN(e.detected_at) FILTER (WHERE e.kind = 'fire')             AS first_fire,
                       MAX(e.detected_at) FILTER (WHERE e.kind = 'fire')             AS last_fire,
                       MIN(e.detected_at) FILTER (WHERE e.kind = 'smoke')            AS first_smoke,
                       MAX(e.detected_at) FILTER (WHERE e.kind = 'smoke')            AS last_smoke,
                       AVG(e.peak_confidence)                                        AS avg_confidence
                FROM fire_event e
                WHERE e.detected_at >= $1
                GROUP BY e.camera_id
            ),
            smp AS (
                SELECT s.camera_id, SUM(s.checks) AS checks,
                       SUM(s.fire_hits) AS fire_hits, SUM(s.smoke_hits) AS smoke_hits
                FROM detection_sample_hourly s
                WHERE s.hour >= date_trunc('hour', $1::timestamptz)
                GROUP BY s.camera_id
            )
            SELECT c.camera_id, c.name AS camera_name, c.location, c.building, c.floor_level,
                   c.zone, c.area, c.enabled,
                   COALESCE(ev.fire_events, 0)     AS fire_events,
                   COALESCE(ev.smoke_events, 0)    AS smoke_events,
                   COALESCE(ev.false_positives, 0) AS false_positives,
                   COALESCE(ev.open, 0)            AS open,
                   COALESCE(ev.days_with_fire, 0)  AS days_with_fire,
                   COALESCE(ev.days_with_smoke, 0) AS days_with_smoke,
                   COALESCE(ev.days_with_any, 0)   AS days_with_any,
                   ev.first_fire, ev.last_fire, ev.first_smoke, ev.last_smoke, ev.avg_confidence,
                   COALESCE(smp.checks, 0)         AS checks,
                   COALESCE(smp.fire_hits, 0)      AS fire_hits,
                   COALESCE(smp.smoke_hits, 0)     AS smoke_hits
            FROM camera c
            LEFT JOIN ev  ON ev.camera_id  = c.camera_id
            LEFT JOIN smp ON smp.camera_id = c.camera_id
            WHERE {camera_where}
            ORDER BY COALESCE(ev.fire_events, 0) + COALESCE(ev.smoke_events, 0) DESC,
                     COALESCE(ev.fire_events, 0) DESC, c.name
            """,
            base + (tz,),
            fetch_all=True,
        )
        return window, [self._camera_row(row) for row in rows]

    @staticmethod
    def _camera_row(row: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(row)
        out["total_events"] = row["fire_events"] + row["smoke_events"]
        out["fire_detection_rate"] = _rate(row["fire_hits"], row["checks"])
        out["smoke_detection_rate"] = _rate(row["smoke_hits"], row["checks"])
        out["total_detection_rate"] = _rate(row["fire_hits"] + row["smoke_hits"], row["checks"])
        out["avg_confidence"] = _num(row["avg_confidence"])
        out["false_positive_pct"] = _pct(row["false_positives"], out["total_events"])
        for key in ("first_fire", "last_fire", "first_smoke", "last_smoke"):
            out[key] = _iso(row[key])
        return out

    @staticmethod
    def _camera_summary(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
        return {
            "total_cameras": len(rows),
            "cameras_with_fire": sum(1 for r in rows if r["fire_events"]),
            "cameras_with_smoke": sum(1 for r in rows if r["smoke_events"]),
            "cameras_with_any": sum(1 for r in rows if r["total_events"]),
            "total_fire_events": sum(r["fire_events"] for r in rows),
            "total_smoke_events": sum(r["smoke_events"] for r in rows),
            "total_events": sum(r["total_events"] for r in rows),
        }

    async def by_camera(
        self, days: int = 7, tz: str = "UTC", workspace_id: Optional[UUID] = None
    ) -> Dict[str, Any]:
        window, rows = await self._camera_rows(days, tz, workspace_id)
        return {
            "window": {"start": window["start_at"], "end": window["now"], "tz": tz},
            "summary": self._camera_summary(rows),
            "cameras": rows,
        }

    async def by_location(
        self,
        group_by: str = "building",
        days: int = 7,
        tz: str = "UTC",
        workspace_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """The per-camera numbers added up per building / floor / zone / area /
        location (cameras without one count as "Unknown")."""
        if group_by not in LOCATION_GROUPS:
            raise ValueError(f"group_by must be one of {', '.join(LOCATION_GROUPS)}")
        window, rows = await self._camera_rows(days, tz, workspace_id)
        groups: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            name = (row.get(group_by) or "").strip() or "Unknown"
            g = groups.setdefault(
                name,
                {"group_name": name, "cameras": 0, "fire_events": 0, "smoke_events": 0,
                 "false_positives": 0, "checks": 0, "fire_hits": 0, "smoke_hits": 0,
                 "first_detection": None, "last_detection": None},
            )
            g["cameras"] += 1
            for key in ("fire_events", "smoke_events", "false_positives", "checks", "fire_hits", "smoke_hits"):
                g[key] += row[key]
            firsts = [v for v in (row["first_fire"], row["first_smoke"], g["first_detection"]) if v]
            lasts = [v for v in (row["last_fire"], row["last_smoke"], g["last_detection"]) if v]
            g["first_detection"] = min(firsts) if firsts else None
            g["last_detection"] = max(lasts) if lasts else None
        out = []
        for g in groups.values():
            g["total_events"] = g["fire_events"] + g["smoke_events"]
            g["fire_detection_rate"] = _rate(g["fire_hits"], g["checks"])
            g["smoke_detection_rate"] = _rate(g["smoke_hits"], g["checks"])
            g["total_detection_rate"] = _rate(g["fire_hits"] + g["smoke_hits"], g["checks"])
            out.append(g)
        out.sort(key=lambda g: (-g["total_events"], -g["fire_events"], g["group_name"]))
        return {
            "window": {"start": window["start_at"], "end": window["now"], "tz": tz},
            "group_by": group_by,
            "groups": out,
        }

    async def high_risk(
        self,
        threshold_percentage: float = 5.0,
        days: int = 7,
        tz: str = "UTC",
        workspace_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """Cameras whose fire + smoke detection rate is at least the threshold,
        or that had a fire incident at all (InsightEye's high-risk-cameras)."""
        window, rows = await self._camera_rows(days, tz, workspace_id)
        risky = [
            r for r in rows
            if (r["total_detection_rate"] or 0) >= threshold_percentage or r["fire_events"]
        ]
        risky.sort(
            key=lambda r: (-(r["total_detection_rate"] or 0), -r["fire_events"], -r["smoke_events"])
        )
        rates = [r["total_detection_rate"] for r in risky if r["total_detection_rate"] is not None]
        return {
            "window": {"start": window["start_at"], "end": window["now"], "tz": tz},
            "threshold_percentage": threshold_percentage,
            "summary": {
                **self._camera_summary(risky),
                "high_risk_count": len(risky),
                "avg_total_detection_rate": round(sum(rates) / len(rates), 2) if rates else None,
            },
            "cameras": risky,
        }

    async def confidence_audit(
        self,
        days: int = 7,
        camera_id: Optional[UUID] = None,
        tz: str = "UTC",
        workspace_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """Model accuracy & confidence audit (InsightEye evidence_analytics.confidence_audit).

        How sure the detector was about the alerts in the window: totals, a
        10-bucket histogram over [0, 1], the spread per camera and the latest
        scored alerts. Operator verdicts stand in for ground truth, so each part
        also counts false positives. ``low_confidence`` counts alerts within 0.1
        of the detector threshold, the ones most worth a second look.
        """
        window = await self._window(days, tz)
        start_at = window["start_at"]
        threshold = float(config.detector_floor)
        low_cutoff = round(min(1.0, threshold + 0.1), 4)

        base, where, _ = self._scope(start_at, workspace_id, camera_id)
        n = len(base)
        scored = f"{where} AND e.peak_confidence IS NOT NULL"
        low = f"${n + 1}"

        totals = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*)                                                  AS events,
                   COUNT(e.peak_confidence)                                  AS scored_events,
                   AVG(e.peak_confidence)::float                                  AS avg_confidence,
                   MIN(e.peak_confidence)::float                                  AS min_confidence,
                   MAX(e.peak_confidence)::float                                  AS max_confidence,
                   COUNT(*) FILTER (WHERE e.peak_confidence < {low})              AS low_confidence,
                   COUNT(*) FILTER (WHERE e.status = 'ACKNOWLEDGED')         AS acknowledged,
                   COUNT(*) FILTER (WHERE e.status = 'RESOLVED')             AS resolved,
                   COUNT(*) FILTER (WHERE e.status = 'FALSE_POSITIVE')       AS false_positives,
                   AVG(e.peak_confidence) FILTER (WHERE e.status = 'RESOLVED')::float
                                                                             AS avg_confidence_resolved,
                   AVG(e.peak_confidence) FILTER (WHERE e.status = 'FALSE_POSITIVE')::float
                                                                             AS avg_confidence_false_positive
            FROM fire_event e
            WHERE {where}
            """,
            base + (low_cutoff,),
            fetch_one=True,
        )

        bucket_rows = await self.db_manager.execute_query(
            f"""
            SELECT LEAST(width_bucket(e.peak_confidence, 0, 1, {HISTOGRAM_BUCKETS}), {HISTOGRAM_BUCKETS})
                       AS b,
                   COUNT(*)                                            AS count,
                   COUNT(*) FILTER (WHERE e.status = 'FALSE_POSITIVE') AS false_positives
            FROM fire_event e
            WHERE {scored}
            GROUP BY 1
            """,
            base,
            fetch_all=True,
        )
        by_bucket = {row["b"]: row for row in bucket_rows}
        step = 1 / HISTOGRAM_BUCKETS
        histogram = [
            {
                "bucket": f"{(i - 1) * step:.1f}-{i * step:.1f}",
                "min": round((i - 1) * step, 2),
                "max": round(i * step, 2),
                "count": by_bucket[i]["count"] if i in by_bucket else 0,
                "false_positives": by_bucket[i]["false_positives"] if i in by_bucket else 0,
            }
            for i in range(1, HISTOGRAM_BUCKETS + 1)
        ]

        camera_rows = await self.db_manager.execute_query(
            f"""
            SELECT e.camera_id,
                   c.name                                              AS camera_name,
                   COUNT(*)                                            AS events,
                   AVG(e.peak_confidence)::float                            AS avg_confidence,
                   MIN(e.peak_confidence)::float                            AS min_confidence,
                   MAX(e.peak_confidence)::float                            AS max_confidence,
                   COUNT(*) FILTER (WHERE e.peak_confidence < {low})        AS low_confidence,
                   COUNT(*) FILTER (WHERE e.status = 'FALSE_POSITIVE') AS false_positives
            FROM fire_event e
            LEFT JOIN camera c ON c.camera_id = e.camera_id
            WHERE {scored}
            GROUP BY e.camera_id, c.name
            ORDER BY avg_confidence DESC NULLS LAST, camera_name
            """,
            base + (low_cutoff,),
            fetch_all=True,
        )

        latest = await self.db_manager.execute_query(
            f"""
            SELECT e.event_id, e.detected_at, e.camera_id, c.name AS camera_name,
                   e.kind, e.peak_confidence::float AS confidence, e.status
            FROM fire_event e
            LEFT JOIN camera c ON c.camera_id = e.camera_id
            WHERE {scored}
            ORDER BY e.detected_at DESC, e.event_id DESC
            LIMIT {LATEST_EVENTS}
            """,
            base,
            fetch_all=True,
        )

        scored_events = totals["scored_events"]
        return {
            "window": {"start": start_at, "end": window["now"], "tz": tz},
            "summary": {
                **totals,
                "low_confidence_pct": _pct(totals["low_confidence"], scored_events),
                "false_positive_pct": _pct(totals["false_positives"], totals["events"]),
                "threshold": threshold,
                "low_confidence_cutoff": low_cutoff,
            },
            "histogram": histogram,
            "by_camera": [
                {**row, "false_positive_pct": _pct(row["false_positives"], row["events"])}
                for row in camera_rows
            ],
            "latest": latest,
        }


analytics_service = AnalyticsService()
