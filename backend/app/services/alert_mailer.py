# app/services/alert_mailer.py
"""The fire / smoke alert email (InsightEye's ``send_fire_alert_email``).

Sent when an incident opens, to every active member of the camera's workspace
(or, for a workspace nobody belongs to, every active admin). One mail per
camera and kind per FIRE_COOLDOWN_S, on top of the incident rule that already
folds a fire flickering in and out of view into one incident. Off unless
SMTP_HOST is set; never raises, never blocks a camera worker.
"""

import asyncio
import html
import logging
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any, Dict, List, Set, Tuple
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager
from app.services.event_service import event_service
from app.services.otp_service import OtpService

logger = logging.getLogger(__name__)

# Background sends; asyncio only keeps weak references to tasks.
_tasks: Set[asyncio.Task] = set()


class AlertMailer:
    def __init__(self) -> None:
        self.db_manager = db_manager
        # (camera_id, kind) -> monotonic time of the last mail
        self._last_sent: Dict[Tuple[UUID, str], float] = {}

    def notify(self, camera: Dict[str, Any], event: Dict[str, Any]) -> None:
        """Queue the alert for ``event`` (a fire_event row). Returns at once."""
        if not config.alert_email_active:
            return
        key = (camera["camera_id"], event["kind"])
        now = time.monotonic()
        last = self._last_sent.get(key)
        if last is not None and now - last < config.fire_cooldown_s:
            logger.info("Alert email for %s on %s suppressed (cooldown).", event["kind"], camera["name"])
            return
        self._last_sent[key] = now
        task = asyncio.create_task(self._send(camera, event), name=f"alert-mail-{event['event_id']}")
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)

    async def recipients(self, workspace_id: UUID) -> List[str]:
        rows = await self.db_manager.execute_query(
            """
            SELECT u.email FROM workspace_member m
            JOIN app_user u ON u.user_id = m.user_id
            WHERE m.workspace_id = $1 AND u.is_active AND u.email <> ''
            ORDER BY u.email
            """,
            (workspace_id,),
            fetch_all=True,
        )
        if not rows:
            rows = await self.db_manager.execute_query(
                "SELECT email FROM app_user WHERE role = 'admin' AND is_active AND email <> '' ORDER BY email",
                fetch_all=True,
            )
        return [row["email"] for row in rows]

    async def _send(self, camera: Dict[str, Any], event: Dict[str, Any]) -> None:
        try:
            to = await self.recipients(event["workspace_id"])
            if not to:
                logger.warning("No one to email about event %s.", event["event_id"])
                return
            message = self.message(camera, event, to)
            await asyncio.to_thread(OtpService._send_blocking, message)
            logger.info("Alert email for event %s sent to %s recipient(s).", event["event_id"], len(to))
        except Exception as e:
            logger.error("Could not email the alert for event %s: %s", event["event_id"], e)

    @staticmethod
    def location_text(camera: Dict[str, Any]) -> str:
        parts = [
            camera.get("building"),
            f"Floor {camera['floor_level']}" if camera.get("floor_level") else None,
            camera.get("zone"),
            camera.get("area"),
        ]
        text = " - ".join(p for p in parts if p)
        return text or camera.get("location") or "Unknown location"

    @classmethod
    def message(cls, camera: Dict[str, Any], event: Dict[str, Any], to: List[str]) -> EmailMessage:
        kind = event["kind"].upper()
        where = cls.location_text(camera)
        when = event.get("detected_at") or datetime.now(timezone.utc)
        when_text = when.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        confidence = event.get("peak_confidence")
        confidence_text = f"{confidence:.0%}" if confidence is not None else "n/a"
        headline = event_service.alert_message(event["kind"], where)

        message = EmailMessage()
        message["Subject"] = f"🚨 URGENT: {kind} DETECTED - {camera['name']}"
        message["From"] = config.smtp_from
        message["To"] = ", ".join(to)
        message.set_content(
            f"{headline}\n\n"
            f"Camera:     {camera['name']}\n"
            f"Status:     {kind}\n"
            f"Location:   {where}\n"
            f"Time:       {when_text}\n"
            f"Confidence: {confidence_text}\n\n"
            "Check the camera now and follow your site's emergency procedure.\n"
            f"Incident {event['event_id']} is open in {config.app_name}.\n"
        )
        rows = "".join(
            f"<li><strong>{html.escape(label)}:</strong> {html.escape(value)}</li>"
            for label, value in (
                ("Camera", camera["name"]),
                ("Status", kind),
                ("Location", where),
                ("Time", when_text),
                ("Confidence", confidence_text),
            )
        )
        message.add_alternative(
            f"<h2 style=\"color:#dc2626\">{html.escape(headline)}</h2>"
            f"<ul>{rows}</ul>"
            "<p>Check the camera now and follow your site's emergency procedure.</p>"
            f"<p style=\"color:#64748b\">Incident {event['event_id']} is open in "
            f"{html.escape(config.app_name)}.</p>",
            subtype="html",
        )
        return message


alert_mailer = AlertMailer()
