# app/core/config.py
"""Central application configuration loaded from environment variables and .env."""

from typing import Dict, List, Literal

from dotenv import load_dotenv
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()


class Settings(BaseSettings):
    """
    Central application configuration.
    Loaded from:
    - Environment variables
    - .env
    - Defaults below
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # =========================================================================
    # APPLICATION
    # =========================================================================
    app_name: str = "Fire & Smoke API"
    app_description: str = "Fire and smoke detection, alerting and incident triage"
    app_version: str = "1.0.0"
    app_api_prefix: str = "/api/v1"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_debug: bool = True
    environment: Literal["development", "staging", "production"] = "development"

    # =========================================================================
    # CORS
    # =========================================================================
    cors_origins: List[str] = ["http://localhost:3000", "http://localhost:8000"]
    cors_allow_credentials: bool = True
    cors_allow_methods: List[str] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    cors_allow_headers: List[str] = ["Content-Type", "Authorization", "X-Request-ID", "X-Workspace-Id"]

    # =========================================================================
    # AUTH
    # =========================================================================
    # No default: pydantic-settings refuses to build Settings without this set,
    # which is the right failure mode for a signing key. Generate one with:
    #   python -c "import secrets; print(secrets.token_urlsafe(48))"
    secret_key: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # Sent alongside the bearer token so <img src="..."> endpoints (camera
    # snapshots, incident frames, clips) can authenticate without a
    # header. Never accepted on a route that changes state -- see
    # app/api/deps.py.
    auth_cookie_name: str = "fs_access"
    auth_cookie_secure: bool = False
    auth_cookie_samesite: str = "lax"

    # There is no public signup. If app_user is empty at startup, one admin is
    # created from these three values -- see ensure_bootstrap_admin() in
    # app/services/user_service.py. Change the password immediately after.
    bootstrap_admin_username: str = "admin"
    bootstrap_admin_email: str = "admin@firesmoke.local"
    bootstrap_admin_password: str = "ChangeMe!123"

    # "Forgot your password?": a one-time code mailed to the account's email
    # (app/services/otp_service.py). Off while SMTP_HOST is empty.
    otp_ttl_seconds: int = 600
    otp_resend_seconds: int = 60
    otp_max_attempts: int = 5

    # =========================================================================
    # EMAIL (SMTP)
    # =========================================================================
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "Fire & Smoke <no-reply@firesmoke.local>"
    smtp_starttls: bool = True   # STARTTLS on smtp_port (587)
    smtp_ssl: bool = False       # implicit TLS instead (465)
    smtp_timeout_seconds: float = 20.0

    @model_validator(mode="after")
    def _refuse_insecure_production(self) -> "Settings":
        """In production, refuse to start with the shipped admin password or a
        session cookie that would travel over plain HTTP."""
        if self.environment == "production":
            problems = []
            if self.bootstrap_admin_password == "ChangeMe!123":
                problems.append("BOOTSTRAP_ADMIN_PASSWORD is still the default")
            if not self.auth_cookie_secure:
                problems.append("AUTH_COOKIE_SECURE must be true behind HTTPS")
            if len(self.secret_key) < 32:
                problems.append("SECRET_KEY must be at least 32 characters")
            if problems:
                raise ValueError("Insecure production settings: " + "; ".join(problems))
        return self

    @property
    def password_reset_enabled(self) -> bool:
        return bool(self.smtp_host)

    # =========================================================================
    # SIGN-IN PROTECTION (app/core/ratelimit.py)
    # =========================================================================
    # Failed sign-ins allowed per login name + address within the window,
    # then 429 until the oldest one ages out. 0 turns the limit off.
    login_max_failures: int = 5
    login_failure_window_s: int = 300
    # Password-reset mails one address may ask for per window.
    forgot_password_max_per_ip: int = 5
    forgot_password_window_s: int = 900

    # =========================================================================
    # IN-APP NOTIFICATIONS AND AUDIT (inbox_service.py, audit_service.py)
    # =========================================================================
    notification_ws_ping_s: float = 25.0
    notification_retention_days: int = 90
    audit_retention_days: int = 365
    # A running camera that has not delivered frames for this long raises a
    # "camera offline" notification, and one "back online" when it recovers.
    camera_offline_after_s: int = 60
    camera_health_interval_s: float = 15.0

    # =========================================================================
    # CONNECTION TESTS (app/services/rtsp_probe.py)
    # =========================================================================
    probe_timeout_seconds: float = 8.0
    probe_max_concurrency: int = 4

    # =========================================================================
    # LOGGING
    # =========================================================================
    log_level: str = "INFO"
    log_format: str = "%(asctime)s - %(name)s - %(levelname)s - [%(request_id)s] %(message)s"
    # One JSON object per line (time, level, logger, message, request_id) for
    # log shippers; LOG_FORMAT is ignored then.
    log_json: bool = False
    log_file_path: str = "logs/firesmoke.log"

    # =========================================================================
    # DATABASE
    # =========================================================================
    postgres_db: str = "firesmoke_db"
    postgres_user: str = "firesmoke"
    postgres_password: str = "firesmoke_pass"
    db_host: str = "db"
    db_port: int = 5432

    db_min_pool_size: int = 2
    db_max_pool_size: int = 10
    db_timeout: float = 30.0
    db_command_timeout: float = 60.0
    db_max_retries: int = 10
    db_retry_delay_base: int = 2
    db_retry_delay_max: int = 30

    # database/migrations, mounted read-only by docker-compose.yml. When this
    # path is missing (a checkout run outside Docker) the repo's own folder is
    # used -- see app/core/migrations.py.
    migrations_dir: str = "/app/migrations"

    @property
    def database_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.db_host}:{self.db_port}/{self.postgres_db}"
        )

    # =========================================================================
    # MODELS
    # =========================================================================
    model_device: str = "cpu"

    # InsightEye's fire & smoke detector (YOLO26n, 640 px, end-to-end NMS).
    # Its classes are named only "0", "1", "2"; InsightEye reads 0 as fire and
    # 1 as smoke and ignores 2 -- see backend/models/README.md.
    fire_model_path: str = "models/fire.pt"
    fire_input_size: int = 640
    # Model class id -> kind. A class missing here is ignored.
    fire_class_map: Dict[int, str] = {0: "fire", 1: "smoke"}
    # Per-kind confidence a box needs to count (InsightEye used 0.5 for both).
    fire_confidence: float = 0.5
    smoke_confidence: float = 0.5
    # FP16 inference on CUDA; ignored on CPU.
    fire_half: bool = True

    @property
    def detector_floor(self) -> float:
        """The lowest per-kind threshold: what the model itself is asked for."""
        return min(self.fire_confidence, self.smoke_confidence)

    # =========================================================================
    # RTSP / STREAM
    # =========================================================================
    rtsp_transport: str = "tcp"
    rtsp_buffer_size: int = 1
    rtsp_open_timeout: float = 15.0
    rtsp_read_failure_limit: int = 30
    rtsp_reconnect_delay_base: float = 2.0
    rtsp_reconnect_delay_max: float = 30.0

    frame_skip: int = 5
    target_process_fps: float = 5.0
    jpeg_quality: int = 85

    stream_start_stagger_delay: float = 2.0
    stream_worker_restart_delay: float = 5.0

    # Every live viewer costs one JPEG encode per frame; cap them so a wall of
    # open browser tabs cannot starve detection.
    max_mjpeg_clients: int = 4

    # =========================================================================
    # WORKER SUPERVISION
    # =========================================================================
    # Restarts workers that died, errored, or wedged inside a blocking read,
    # and starts enabled cameras that have no worker. Without it a camera whose
    # model load failed stays dark until someone notices by hand.
    worker_supervision_enabled: bool = True
    worker_supervision_interval_s: float = 15.0
    worker_restart_backoff_base_s: float = 5.0
    worker_restart_backoff_max_s: float = 300.0

    # =========================================================================
    # EVIDENCE CLIPS
    # =========================================================================
    # One annotated mp4 per incident: clip_pre_seconds before the moment it is
    # confirmed and clip_post_seconds after, so the clip shows how it started
    # and how it developed.
    clip_enabled: bool = True
    clip_dir: str = "data/clips"
    clip_pre_seconds: float = 20.0
    clip_post_seconds: float = 20.0
    clip_max_width: int = 960
    clip_jpeg_quality: int = 70

    # =========================================================================
    # OBJECT STORAGE (MinIO)
    # =========================================================================
    # Images and videos go to MinIO; Postgres keeps the records and object keys.
    # Empty endpoint = disabled: media stays in Postgres bytes / clip files.
    minio_endpoint: str = ""
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "firesmoke"
    minio_secure: bool = False

    # =========================================================================
    # RETENTION
    # =========================================================================
    retention_enabled: bool = True
    retention_interval_s: float = 21600.0  # 6 hours
    clip_retention_days: int = 30
    clip_max_total_mb: int = 5120

    # =========================================================================
    # FIRE / SMOKE INCIDENTS
    # =========================================================================
    # The detector runs this often per camera. Fire spreads in seconds, but a
    # frame twice a second is plenty to see it, and keeps a T4 free for many
    # cameras. (InsightEye ran it on every 10th sampled frame.)
    fire_detect_fps: float = 2.0
    # A kind is confirmed once it is seen in at least FIRE_CONFIRM_HITS of the
    # last FIRE_CONFIRM_WINDOW inferences: one flicker of orange light is not
    # a fire, but three sightings in five checks (2.5 s) are.
    fire_confirm_hits: int = 3
    fire_confirm_window: int = 5
    # An incident closes once the kind has not been seen for this long.
    fire_clear_after_s: float = 30.0
    # A kind seen again within this long of its last incident closing reopens
    # that incident instead of raising a new alert. InsightEye's 10 minutes,
    # here actually applied.
    fire_cooldown_s: float = 600.0

    # Email each active member of the workspace when an incident opens. Only
    # takes effect while SMTP_HOST is set; at most one mail per camera and
    # kind per FIRE_COOLDOWN_S.
    alert_email_enabled: bool = True

    @property
    def alert_email_active(self) -> bool:
        return self.alert_email_enabled and bool(self.smtp_host)

config = Settings()
