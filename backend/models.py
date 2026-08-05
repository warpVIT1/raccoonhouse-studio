from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, Text, Boolean, Float, ForeignKey, DateTime
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


class Title(Base):
    __tablename__ = "titles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name_ua: Mapped[str] = mapped_column(String(255), nullable=False)
    name_original: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    poster_path: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="new")  # new/in_progress/done
    show_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)  # for SRT filename

    episodes: Mapped[list["Episode"]] = relationship("Episode", back_populates="title", cascade="all, delete-orphan")
    characters: Mapped[list["Character"]] = relationship("Character", back_populates="title", cascade="all, delete-orphan")
    sign_styles: Mapped[list["SignStyle"]] = relationship("SignStyle", back_populates="title", cascade="all, delete-orphan")


class Episode(Base):
    __tablename__ = "episodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)
    season: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    duration: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    original_file_path: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    audio_stem_path: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    # Despite the name, this is the INSTRUMENTAL (original vocal removed) —
    # the track dubbing actually needs as a base to lay new voice over. Kept
    # the established column/API name to avoid rippling a rename through the
    # frontend; vocal_only_stem_path below holds the actual isolated-voice
    # stem, used internally for VAD-based marker detection only.
    vocal_stem_path: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    vocal_only_stem_path: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    original_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    original_bitrate: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    original_format: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="not_uploaded")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)

    title: Mapped["Title"] = relationship("Title", back_populates="episodes")
    subtitle_lines: Mapped[list["SubtitleLine"]] = relationship("SubtitleLine", back_populates="episode", cascade="all, delete-orphan")
    markers: Mapped[list["Marker"]] = relationship("Marker", back_populates="episode", cascade="all, delete-orphan")


class Character(Base):
    __tablename__ = "characters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    title: Mapped["Title"] = relationship("Title", back_populates="characters")
    dubber_maps: Mapped[list["CharacterDubberMap"]] = relationship("CharacterDubberMap", back_populates="character", cascade="all, delete-orphan")
    subtitle_lines: Mapped[list["SubtitleLine"]] = relationship("SubtitleLine", back_populates="character")


class Dubber(Base):
    __tablename__ = "dubbers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)

    character_maps: Mapped[list["CharacterDubberMap"]] = relationship("CharacterDubberMap", back_populates="dubber")


class CharacterDubberMap(Base):
    __tablename__ = "character_dubber_map"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    character_id: Mapped[int] = mapped_column(Integer, ForeignKey("characters.id"), nullable=False)
    dubber_id: Mapped[int] = mapped_column(Integer, ForeignKey("dubbers.id"), nullable=False)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)

    character: Mapped["Character"] = relationship("Character", back_populates="dubber_maps")
    dubber: Mapped["Dubber"] = relationship("Dubber", back_populates="character_maps")


class SubtitleLine(Base):
    __tablename__ = "subtitle_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    episode_id: Mapped[int] = mapped_column(Integer, ForeignKey("episodes.id"), nullable=False)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    character_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("characters.id"), nullable=True)
    ass_style: Mapped[str] = mapped_column(String(128), nullable=False, default="Default")
    is_overlap: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    episode: Mapped["Episode"] = relationship("Episode", back_populates="subtitle_lines")
    character: Mapped[Optional["Character"]] = relationship("Character", back_populates="subtitle_lines")


class Marker(Base):
    __tablename__ = "markers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    episode_id: Mapped[int] = mapped_column(Integer, ForeignKey("episodes.id"), nullable=False)
    reaper_name: Mapped[str] = mapped_column(String(128), nullable=False)
    position_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    color: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)  # hex, e.g. "#E52128"

    episode: Mapped["Episode"] = relationship("Episode", back_populates="markers")


class SignStyle(Base):
    __tablename__ = "sign_styles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)
    style_name: Mapped[str] = mapped_column(String(128), nullable=False)

    title: Mapped["Title"] = relationship("Title", back_populates="sign_styles")


class AppSettings(Base):
    """Single-row table (id always 1) holding app-wide user preferences."""
    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    reaper_path: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    separation_model: Mapped[str] = mapped_column(String(32), nullable=False, default="MDX-Net")
    ensemble_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    position_format: Mapped[str] = mapped_column(String(16), nullable=False, default="time")  # time | bars_beats
    default_bpm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    active_profile_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("profiles.id"), nullable=True)
    # This is a private app for a closed group, not a public release — the
    # whole point of Power Share is that everyone who has it is already
    # part of the same trusted circle, so both this and online_signaling_*
    # below default to already-connected rather than requiring an opt-in
    # step per machine.
    power_share_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Every incoming power-share request still prompts this machine's own UI
    # for a Так/Ні click by default (per-title consent still gets remembered
    # after the first Так either way, see PowerShareConsent) — this is an
    # explicit opt-in to skip that prompt entirely and approve everyone
    # automatically, for someone who's fine lending their PC to anyone in the
    # group without being asked each time.
    power_share_auto_approve: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # GPU acceleration is opt-in and off by default — enabling it triggers a
    # one-time ~2.5GB CUDA runtime download (see gpu_runtime_service.py). Off
    # by default so a fresh install never silently starts a large background
    # download nobody asked for.
    gpu_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # The only discovery/transport mechanism for Power Share — a small
    # Cloudflare Worker (cloudflare-signaling/) that tracks who's online,
    # relays the consent handshake between two specific peers, and store-
    # and-forwards the actual job file through its R2 bucket (see
    # discovery_service.py / power_share_service.py). Nothing connects to a
    # peer's IP directly anymore, so this is on by default, pointed at the
    # group's own deployed Worker — see power_share_enabled's comment above
    # for why. Redeploying cloudflare-signaling/ to a different URL means
    # updating this default (existing installs keep whatever they already
    # have — this only affects fresh app_settings rows).
    online_signaling_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    online_signaling_url: Mapped[Optional[str]] = mapped_column(
        String(512), nullable=True, default="wss://raccoonhouse-signaling.raccoonhause.workers.dev/"
    )
    # Local-only opt-in — shows the incoming "Пропозиції та скарги" inbox in
    # Settings on THIS install. Every install can still submit feedback
    # regardless of this flag; it only gates who sees what others submitted.
    # No server-side auth backs this (matching every other Power Share
    # endpoint's trust model — see cloudflare-signaling/src/index.ts), so
    # this is the only thing standing between a teammate's install and the
    # incoming list, same posture as power_share_auto_approve above.
    show_feedback_inbox: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Profile(Base):
    """A local user identity (who's operating this app instance) — separate from
    the Dubber list, which tracks voice actors mapped to characters."""
    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    role: Mapped[str] = mapped_column(String(128), nullable=False, default="Звукорежисер")
    color: Mapped[str] = mapped_column(String(32), nullable=False, default="#E52128")
    # Set only via ProfileModal's "type admin as your role → enter password"
    # flow (see routers/settings.py's verify-admin-password endpoint) — gates
    # seeing the feedback inbox and editing Апекс's line-up. Deliberately a
    # property of THIS profile, not a single install-wide flag: it used to
    # live on AppSettings, which meant unlocking it once stayed unlocked for
    # every profile on the same install, even after switching to a non-admin
    # one — confirmed live as a real gap, not just theoretical. Reading
    # AppSettings.active_profile.is_admin instead fixes that, since switching
    # the active profile now genuinely changes what's visible. This is a
    # convenience gate for a closed trusted circle, explicitly NOT real
    # security — anyone with local access to this machine's own backend API
    # could set it directly; the password only stops a casual click.
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class PowerShareConsent(Base):
    """Records that a peer already approved power-sharing for a given title, so
    the requester doesn't need to re-prompt them until work moves to a new title."""
    __tablename__ = "power_share_consents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Historically a bare IP (back when peers dialed each other directly) —
    # now the peer's Worker-assigned signaling id, since nothing connects to
    # a peer's IP anymore. Column name kept as-is to avoid a schema migration
    # (this project has no Alembic; init_db() is a plain create_all()).
    peer_host: Mapped[str] = mapped_column(String(255), nullable=False)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    decided_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class ApexModel(Base):
    """The current line-up for "Апекс" (see separator_service.py's
    APEX_MODELS_DEFAULT) — DB-backed rather than hardcoded so the curator
    (whoever runs this install) can add/remove which models Апекс averages
    without a full PyInstaller rebuild + redeploy, which used to be the only
    way to change this. Seeded once from APEX_MODELS_DEFAULT the first time
    it's read (see separator_service._load_apex_models) if this table is
    still empty — existing installs keep today's line-up until edited.
    Order doesn't affect the result (Апекс unweighted-averages every entry),
    so there's no explicit position column to manage."""
    __tablename__ = "apex_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    method: Mapped[str] = mapped_column(String(32), nullable=False)  # one of MODEL_CHOICES's keys — needed to derive arch
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    arch: Mapped[str] = mapped_column(String(16), nullable=False)  # "mdx" | "vr" | "demucs" | "mdxc"
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class PersonalEnsembleModel(Base):
    """One profile's own "Мій ансамбль" line-up — same shape as ApexModel,
    but scoped to profile_id and starting EMPTY for every profile (no
    seeding, unlike Апекс's APEX_MODELS_DEFAULT) since the point is each
    person picking their own set rather than everyone sharing the admin's
    curated one. Purely local to this install/profile, never synced through
    the Worker — Апекс is the shared, studio-wide ensemble; this is the
    personal one."""
    __tablename__ = "personal_ensemble_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[int] = mapped_column(Integer, ForeignKey("profiles.id"), nullable=False)
    method: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    arch: Mapped[str] = mapped_column(String(16), nullable=False)  # "mdx" | "vr" | "demucs" | "mdxc"
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class ModelRating(Base):
    """One profile's 1-5 star opinion on one registry model (see the Model
    Browser — routers/model_browser.py). One row per (method, filename,
    profile_name); re-rating updates the existing row rather than adding a
    new one. Synced across every install via the same Cloudflare Worker
    feedback/reports/Апекс already use (see discovery_service's
    submit_model_rating/list_model_ratings) — the point of a shared browser
    is the whole studio's opinion on a model, not just this one install's."""
    __tablename__ = "model_ratings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    method: Mapped[str] = mapped_column(String(32), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    profile_name: Mapped[str] = mapped_column(String(128), nullable=False)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)  # 1-5
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class DownloadedCustomModel(Base):
    """Local record of one Model Browser catalog entry (the shared,
    server-side catalog itself lives in Cloudflare D1 — see
    routers/model_browser.py's /models/catalog, not this table) that has
    actually been downloaded onto THIS install. Exists so separation can
    resolve a custom model's architecture/config file at job time without a
    network round-trip to the Worker — works fully offline once downloaded,
    same as every built-in model. Replaces the old install-local-only
    CustomSeparationModel table, which this Model Browser feature supersedes
    entirely (see git history for the removed /models/custom endpoints)."""
    __tablename__ = "downloaded_custom_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    method: Mapped[str] = mapped_column(String(32), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    arch: Mapped[str] = mapped_column(String(16), nullable=False)  # "mdx" | "vr" | "demucs" | "mdxc"
    config_yaml_filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
