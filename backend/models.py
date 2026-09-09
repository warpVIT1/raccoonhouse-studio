from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, Text, Boolean, Float, ForeignKey, DateTime, JSON
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
    # None = personal, local-only (today's behavior, unchanged). Set the
    # moment a title is created with the "Спільний з командою" toggle on —
    # see services/sync_service.py, the only writer of these two columns.
    # `team_id` is the Cloudflare-side team id (not a local FK — no local
    # table has one), kept alongside shared_id so a push/pull knows which
    # team's shared_titles row to talk to without a network round trip.
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    team_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

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
    # Display label for whichever method/model produced the CURRENT
    # vocal_stem_path (e.g. "BS-RoFormer", "Апекс", "МійАнсамбль") — purely
    # informational, used to label the outgoing file when a later run
    # archives it into stems/history/ (see separator_service.run_separation).
    last_separation_model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    original_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    original_bitrate: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    original_format: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="not_uploaded")
    # Subtitle/translation handoff stage — deliberately separate from
    # `status` above (that one's the audio/render pipeline, orthogonal to
    # this). "translating" -> "ready_for_director" once a translator sends
    # the episode on (see routers/episodes.py's /send-to-director).
    subtitle_stage: Mapped[str] = mapped_column(String(32), nullable=False, default="translating")
    # Opaque R2 object key (see cloudflare-signaling's /transfer/:id routes)
    # for the latest 480p hardsub proxy generated on "send to actors" — see
    # services/actor_video_service.py. None until the director has sent at
    # least once.
    actor_video_transfer_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    # See Title.shared_id's comment — mirrors that same shared/personal
    # split one level down, only ever set when the parent Title is shared.
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Last video_transfer_id this row is known to have already downloaded —
    # lets sync_service.pull_and_merge tell "the shared row's video changed
    # since we last pulled it" apart from "we already have this exact file,
    # skip re-downloading" without comparing file bytes.
    last_synced_video_transfer_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # The R2 transfer id for the RAW original video, known from the cloud
    # snapshot but NOT auto-downloaded (confirmed live 2026-08-19: every
    # teammate's install used to silently pull the full-size original the
    # moment a shared episode's video appeared, regardless of whether they
    # actually needed it locally — wasteful for a multi-GB file). None until
    # the episode has been imported/pushed at least once; see
    # routers/episodes.py's download-original-video for the on-demand pull
    # that actually fetches it using this id.
    remote_video_transfer_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # The plain filename as the importer's OS saw it (e.g.
    # "Show S01E05 [1080p].mkv") — kept distinct from original_file_path
    # (an absolute path, meaningless on another device) so a teammate who
    # downloads the original later gets the exact same filename back, not
    # a synthetic "shared_original.mp4". Also what the future Telegram
    # original-video channel post will use as the caption's real filename.
    original_filename: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    # Episode "Адмін" tab's translator status ("не взявся" vs "взявся") —
    # subtitle_stage alone can't distinguish these, it stays "translating"
    # for both. Set the first time a SubtitleLine is edited while stage is
    # still "translating" (see routers/subtitles.py's update_subtitle_line).
    translation_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Set when the sound engineer clicks "Готово" in the Адмін tab (only
    # enabled once every forwarded ActorAudioSubmission for this episode
    # has sent_to_sound_engineer_at set — see that field's own comment).
    sound_engineer_done_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Клінапер's uploaded result — the "cleaned" (signs/text erased) video
    # ready for dubbing, mirrors actor_video_transfer_id's R2-transfer-id
    # shape (opaque key, not a local path, so it syncs across team devices).
    # filename is the real name as the cleaner's OS saw it, same reasoning
    # as original_filename above.
    cleaned_video_transfer_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    cleaned_video_filename: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    cleaned_video_uploaded_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    title: Mapped["Title"] = relationship("Title", back_populates="episodes")
    subtitle_lines: Mapped[list["SubtitleLine"]] = relationship("SubtitleLine", back_populates="episode", cascade="all, delete-orphan")
    markers: Mapped[list["Marker"]] = relationship("Marker", back_populates="episode", cascade="all, delete-orphan")


class Character(Base):
    __tablename__ = "characters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Links this Character to a real team actor (their device_id) once picked
    # from the team-actors dropdown — null for old-style/ASS-derived
    # characters not yet tied to a real person. See sync's Worker
    # GET /team-actors and routers/characters.py's find-or-create-by-
    # team_device_id path.
    team_device_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    title: Mapped["Title"] = relationship("Title", back_populates="characters")
    dubber_maps: Mapped[list["CharacterDubberMap"]] = relationship("CharacterDubberMap", back_populates="character", cascade="all, delete-orphan")
    subtitle_lines: Mapped[list["SubtitleLine"]] = relationship("SubtitleLine", back_populates="character")


class Dubber(Base):
    __tablename__ = "dubbers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    # Explicit link to a local Profile (see routers/characters.py's PUT
    # /dubbers/{id}) — set once by a director/admin, not by the actor
    # themselves. This is what lets the "actor" role workspace answer "which
    # character is MINE": Dubber.profile_id -> this Dubber's
    # CharacterDubberMap rows -> Character, for whichever title is open.
    # Nullable — most Dubber rows (people who aren't RaccoonHouse Studio
    # users at all, just names in the credits) never get one.
    profile_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("profiles.id"), nullable=True)

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
    # ASS Dialogue fields parse_ass_file already reads off the source file
    # (subtitle_parser.py's `ev` dict) but, until now, were silently dropped
    # on import instead of reaching SubtitleLine — round-tripping an ASS
    # through this app quietly zeroed them out. Layer controls draw order
    # for overlapping lines; the margins override the style's own margins
    # per-line (repositioning one subtitle without touching its whole style,
    # e.g. to dodge a burned-in sign) — both real, non-karaoke ASS features.
    layer: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    margin_l: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    margin_r: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    margin_v: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    episode: Mapped["Episode"] = relationship("Episode", back_populates="subtitle_lines")
    character: Mapped[Optional["Character"]] = relationship("Character", back_populates="subtitle_lines")


class AssStyleDef(Base):
    """The real [V4+ Styles] definition (font, size, colours, outline,
    position...) for one style NAME used by an episode's imported .ass file
    — SubtitleLine.ass_style only ever kept the name, not the actual look,
    since nothing downstream of import needed it before. Needed now to
    reconstruct an accurate ASS file for libass-based preview rendering
    (see VideoPlayer's JASSUB integration) instead of srt_exporter.py's old
    one-generic-style-for-everything fallback. `raw_fields` is the verbatim
    comma-joined value list from the original "Style:" line (already in the
    exact order/format a [V4+ Styles] section needs) — stored as one string
    rather than exploded into 20+ individual columns, since nothing needs to
    query/filter on individual style properties, only reproduce the line."""
    __tablename__ = "ass_style_defs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    episode_id: Mapped[int] = mapped_column(Integer, ForeignKey("episodes.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    raw_fields: Mapped[str] = mapped_column(Text, nullable=False)


class Marker(Base):
    __tablename__ = "markers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    episode_id: Mapped[int] = mapped_column(Integer, ForeignKey("episodes.id"), nullable=False)
    reaper_name: Mapped[str] = mapped_column(String(128), nullable=False)
    position_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    color: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)  # hex, e.g. "#E52128"
    # Which actor this marker belongs to — set in bulk by color (see
    # routers/markers.py's PUT .../markers/by-color) rather than one at a
    # time, mirrors SubtitleLine.character_id.
    character_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("characters.id"), nullable=True)
    # Only ever set when the parent Episode is shared — markers used to be
    # 100% local-only (confirmed live 2026-08-19: a remote actor's own CSV
    # download came back completely empty, since their install never had
    # any of these rows at all). Mirrors SubtitleLine.shared_id exactly,
    # same bulk-replace push/pull shape (see sync_service.py's
    # push_markers/pull_and_merge).
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    episode: Mapped["Episode"] = relationship("Episode", back_populates="markers")


class ActorAudioSubmission(Base):
    """A recorded audio track an actor uploaded ("Здати" button — see
    ActorWorkspace.tsx) for a given episode. No per-line/marker linkage at
    all — just "here are however many files I recorded", left for the
    sound engineer to sort out in Reaper using the already-exported
    marker CSV/reascript, matching how a real studio actually works (the
    actor doesn't slice their own takes). Uploaded to the same R2 transfer
    relay everything else here uses (see discovery_service.upload_transfer),
    never stored locally on the receiving end — this row is metadata only."""
    __tablename__ = "actor_audio_submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    episode_id: Mapped[int] = mapped_column(Integer, ForeignKey("episodes.id"), nullable=False)
    character_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("characters.id"), nullable=True)
    filename: Mapped[str] = mapped_column(String(256), nullable=False)
    transfer_id: Mapped[str] = mapped_column(String(128), nullable=False)
    uploaded_by_device_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    uploaded_by_name: Mapped[str] = mapped_column(String(128), nullable=False, default="?")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    # Only ever set when the parent Episode is shared — without this, the
    # director/sound-engineer's own "Звукові доріжки" tab was permanently
    # empty on any install other than the actor's own (confirmed live
    # 2026-08-19, same class of bug as Marker before today's fix). See
    # sync_service.py's push_actor_audio_submission/pull_and_merge.
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Episode "Адмін" tab's production-status readout (see routers/
    # actor_audio.py's request_actor_audio_fix/send_actor_audio_to_sound_engineer)
    # — this submission's status is derived from these two, newest wins:
    # no fix/no forward yet = "на перевірці", fix_requested_at newer than
    # sent_to_sound_engineer_at = "фікси", sent_to_sound_engineer_at set = "готово".
    fix_requested_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # "director" or "sound_engineer" — whichever role's tab actually sent
    # the fix note, so the actor's Telegram text correctly attributes it
    # (both the director's and sound engineer's "Звук" tabs call the same
    # request-fix endpoint).
    fix_requested_by_role: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    sent_to_sound_engineer_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # The fix note's actual text, persisted (previously only ever sent as a
    # one-shot Telegram message — an actor without/ignoring Telegram had no
    # way to see it in-app at all). See routers/actor_audio.py's
    # request_actor_audio_fix.
    fix_message: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    # Set when this row IS an actor's corrected re-take in response to
    # another submission's fix request (see routers/actor_audio.py's
    # submit_actor_audio `fix_of_submission_id` param) — points at the
    # ORIGINAL submission being fixed, not the other way around, since one
    # original can in principle get re-fixed more than once. Plain FK, no
    # ORM relationship object (self-referential + cascade would complicate
    # deletes for no real benefit — every read site just does a plain
    # db.get() when it needs the original's filename/character).
    fix_of_submission_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("actor_audio_submissions.id"), nullable=True)
    # The director's explicit sign-off gate on a fix re-take (see
    # routers/actor_audio.py's accept_actor_audio_fix) — only once this is
    # set does the track actually get forwarded to the sound engineer,
    # instead of the director's own multi-select bulk send (which stays the
    # path for first-time, non-fix submissions).
    accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    accepted_by_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    episode: Mapped["Episode"] = relationship("Episode")
    fix_markers: Mapped[list["ActorAudioFixMarker"]] = relationship(
        "ActorAudioFixMarker", cascade="all, delete-orphan", order_by="ActorAudioFixMarker.position_seconds",
    )


class ActorAudioFixMarker(Base):
    """A specific in-track fix location, imported from a Reaper-exported
    marker CSV (same round-trippable shape as routers/markers.py's own
    import_markers_csv — see that function's docstring) — the director or
    sound engineer downloads the actor's submission, reviews it in Reaper,
    drops markers at the spots that need a retake, exports Reaper's marker
    CSV, and imports it here instead of (or alongside) a plain text note.
    One import call REPLACES the whole set for a submission (see
    routers/actor_audio.py's import_fix_markers) — a fresh review pass
    supersedes the previous one rather than accumulating duplicates."""
    __tablename__ = "actor_audio_fix_markers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    submission_id: Mapped[int] = mapped_column(Integer, ForeignKey("actor_audio_submissions.id"), nullable=False)
    label: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    position_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    color: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    # Only set once the parent submission is shared — same posture as every
    # other shared child row in this file (see Marker.shared_id).
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)


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
    # Gates experimental features still being tested with a small group
    # before wider rollout (first candidate: MVSep cloud separation) — off by
    # default so nobody sees an unfinished feature without opting in first.
    beta_features_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # In-app subtitle translation (Translator role only — see
    # TranslatorWorkspace/SubtitleEditBox). Deliberately per-install, not
    # studio-wide like MVSep's token (services/team_service.py): each studio
    # brings its own DeepL/OpenAI account, so this is a plain local column
    # round-tripped through GET/PUT /settings like everything else here,
    # not the Cloudflare-Worker-backed shared-secret pattern MVSep uses.
    deepl_api_key: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    openai_api_key: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    # Gemini 2.5 Flash/Pro ranks among the strongest LLMs specifically for
    # Ukrainian as a target language (2026 translation benchmarks) — this
    # studio's actual target locale — hence a third provider alongside
    # DeepL/GPT rather than just recommending GPT more.
    gemini_api_key: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    # Sound engineer's own custom filename template for downloading actor
    # audio submissions (see routers/actor_audio.py's get_actor_audio_url) —
    # placeholders like &title/&series/&episode/&character/&actor, in
    # whatever order the sound engineer wants. Empty (the default) means
    # "keep the actor's own original filename" — the director's own
    # download always gets the untouched original regardless of this
    # setting, only a profile holding the sound_engineer role gets the
    # templated name.
    sound_engineer_filename_template: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    # Where the pre-update backup of personal (non-shared) data gets
    # written (see backup_service.py) — overrides the NSIS-installer-time
    # choice (resources/installer.nsh's custom page, written to
    # backup-location.txt next to the exe) without needing a reinstall.
    # Null means "use the installer's choice, or the fixed fallback if
    # even that's missing" — see backup_service.get_backup_dir.
    backup_directory: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)


class Profile(Base):
    """A local user identity (who's operating this app instance) — separate from
    the Dubber list, which tracks voice actors mapped to characters."""
    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # Legacy free-text field — NOT a real job title anymore now that `roles`
    # below exists, kept unchanged because typing exactly "admin" into it is
    # still the deliberately-unadvertised admin-unlock trigger (see
    # ProfileModal.tsx's isAdminRole). Never shown as "the" role in the UI
    # going forward; `roles` is the one that actually reflects what someone
    # does in the studio.
    role: Mapped[str] = mapped_column(String(128), nullable=False, default="Звукорежисер")
    # Job-title roles (клінапер/звукорежисер/перекладач/режисер/актор by
    # default — see RoleCatalog below) — a profile can hold several at once.
    # Stored as a JSON list of RoleCatalog.key values, not labels, so
    # renaming a role in the catalog doesn't require touching every profile
    # that holds it. RoleCatalog is admin-editable and NOT hardcoded, so
    # this list can reference roles added long after this column existed.
    roles: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
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
    # Optional — most profiles have none. Lets several people share one PC
    # without anyone able to just click into a profile that holds team-admin/
    # app-admin capabilities (those are granted per-device via
    # device_identity_service.py, not per-profile, so anyone picking that
    # profile on this machine would otherwise inherit them for free). Hashed,
    # never the plaintext — see routers/profiles.py.
    password_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # Telegram login (see routers/profiles.py's /telegram-login endpoints) —
    # all nullable/optional since a profile can still be created the old
    # manual way. telegram_id is the durable link back to the Telegram
    # account (unique — one Telegram account can't silently take over a
    # second local profile); avatar_url is Telegram's own profile photo URL,
    # fetched fresh on each login rather than downloaded/cached locally.
    telegram_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, unique=True)
    telegram_username: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    avatar_url: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)

    @property
    def has_password(self) -> bool:
        """Plain Python property, not a column — picked up by ProfileOut's
        from_attributes=True the same way a real column would be, without
        ever exposing password_hash itself over the API."""
        return bool(self.password_hash)


class RoleCatalog(Base):
    """The set of job-title roles a Profile can hold (see Profile.roles) —
    seeded with 5 defaults on first run (see database.py's
    _seed_default_roles) but explicitly NOT hardcoded: an app-admin can add/
    rename/remove entries later via routers/profiles.py's /role-catalog
    endpoints, no app update needed. Local-only (not Cloudflare/D1-synced
    like Team system data) — unlike team membership or MVSep config, there's
    no cross-machine consistency requirement for what job titles exist."""
    __tablename__ = "role_catalog"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class TitleRoleAssignment(Base):
    """Who currently holds a non-actor studio role (director/translator/
    sound_engineer/cleaner/etc.) for a shared title — actor casting stays
    entirely separate (Character.team_device_id, the director's own job via
    the "Ролі" tab, deliberately untouched by this table). Lives at the
    TITLE level (not per-episode) so every episode automatically sees the
    same assignment with no copy-on-create step. Edited only by a team
    admin or the app admin (see team_service.can_manage_team) via the
    title's "Команда тайтлу" panel. See sync_service.py's
    push_title_role_assignment/pull_and_merge for how this reaches
    teammates' installs, and discovery_service.notify_role_for_title for
    how it redirects today's whole-role broadcasts to just this person."""
    __tablename__ = "title_role_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title_id: Mapped[int] = mapped_column(Integer, ForeignKey("titles.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(64), nullable=False)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class EpisodeRoleDeadline(Base):
    """A deadline for one role's work on one episode — always per-episode
    (never copied forward like TitleRoleAssignment, a deadline is
    inherently time-bound). `character_id` is set only for the `actor`
    role (one deadline per actor/character on this episode, since acting
    is many-per-episode); null for the singular roles. Drives the Адмін
    tab's "Нагадати" button and the automatic late-submission alert to
    every team admin (see routers/episodes.py's admin-tab endpoints)."""
    __tablename__ = "episode_role_deadlines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    episode_id: Mapped[int] = mapped_column(Integer, ForeignKey("episodes.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(64), nullable=False)
    character_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("characters.id"), nullable=True)
    deadline: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class EpisodeRoleAssignment(Base):
    """An override of TitleRoleAssignment for ONE specific episode only — e.g.
    a different translator covering just this one episode while the title's
    regular one is on a break. No `character_id` (same as TitleRoleAssignment
    — actor casting stays entirely separate). Resolution order everywhere a
    role needs to become a device_id: this table first (by episode_id+role),
    then TitleRoleAssignment as the title-wide default — see
    sync_service.py's resolve_role_device."""
    __tablename__ = "episode_role_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    episode_id: Mapped[int] = mapped_column(Integer, ForeignKey("episodes.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(64), nullable=False)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    shared_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


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
