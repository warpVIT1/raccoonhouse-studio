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
    vocal_stem_path: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
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
    power_share_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Manual fallback for when both PCs aren't on the same LAN (auto-discovery via
    # UDP broadcast can't cross the internet, or doesn't reliably cross a VPN mesh
    # like Hamachi/Radmin) — one pinned "connect directly to this PC" address.
    manual_peer_host: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    manual_peer_port: Mapped[int] = mapped_column(Integer, nullable=False, default=8765)


class Profile(Base):
    """A local user identity (who's operating this app instance) — separate from
    the Dubber list, which tracks voice actors mapped to characters."""
    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    role: Mapped[str] = mapped_column(String(128), nullable=False, default="Звукорежисер")
    color: Mapped[str] = mapped_column(String(32), nullable=False, default="#E52128")


class PowerShareConsent(Base):
    """Records that a peer already approved power-sharing for a given title, so
    the requester doesn't need to re-prompt them until work moves to a new title."""
    __tablename__ = "power_share_consents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    peer_host: Mapped[str] = mapped_column(String(255), nullable=False)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    decided_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
