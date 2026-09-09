from datetime import datetime
from typing import Optional, List, Dict, Literal
from pydantic import BaseModel


class TitleBase(BaseModel):
    name_ua: str
    name_original: str = ""
    poster_path: Optional[str] = None
    status: str = "new"
    show_key: Optional[str] = None


class TitleCreate(TitleBase):
    # Non-null = "Спільний з командою" was on at creation — the team to
    # share into (a profile can belong to more than one team, so the
    # frontend picks which). None = personal, today's behavior unchanged.
    # See services/sync_service.share_title, the only reader of this field.
    team_id: Optional[str] = None


class TitleUpdate(BaseModel):
    name_ua: Optional[str] = None
    name_original: Optional[str] = None
    poster_path: Optional[str] = None
    status: Optional[str] = None
    show_key: Optional[str] = None


class TitleOut(TitleBase):
    id: int
    episode_count: int = 0
    shared_id: Optional[str] = None
    team_id: Optional[str] = None
    # Resolved server-side (team_service.get_team) rather than left for the
    # frontend to look up — someone can be in several teams, so just
    # showing "спільний" next to a title's episode count isn't enough to
    # tell them apart (confirmed live 2026-08-18).
    team_name: Optional[str] = None

    model_config = {"from_attributes": True}


class EpisodeBase(BaseModel):
    season: int = 1
    number: int
    status: str = "not_uploaded"


class EpisodeCreate(EpisodeBase):
    pass


class EpisodeUpdate(BaseModel):
    season: Optional[int] = None
    number: Optional[int] = None
    duration: Optional[float] = None
    original_file_path: Optional[str] = None
    audio_stem_path: Optional[str] = None
    vocal_stem_path: Optional[str] = None
    original_size: Optional[int] = None
    original_bitrate: Optional[int] = None
    original_format: Optional[str] = None
    status: Optional[str] = None


class EpisodeOut(EpisodeBase):
    id: int
    title_id: int
    duration: Optional[float] = None
    original_file_path: Optional[str] = None
    audio_stem_path: Optional[str] = None
    vocal_stem_path: Optional[str] = None
    vocal_only_stem_path: Optional[str] = None
    original_size: Optional[int] = None
    original_bitrate: Optional[int] = None
    original_format: Optional[str] = None
    created_at: datetime
    subtitle_count: int = 0
    subtitle_stage: str = "translating"
    actor_video_transfer_id: Optional[str] = None
    remote_video_transfer_id: Optional[str] = None
    original_filename: Optional[str] = None
    cleaned_video_transfer_id: Optional[str] = None
    cleaned_video_filename: Optional[str] = None
    cleaned_video_uploaded_at: Optional[datetime] = None
    cleaned_video_sent_to_sound_engineer_at: Optional[datetime] = None
    shared_id: Optional[str] = None

    model_config = {"from_attributes": True}


class CharacterBase(BaseModel):
    name: str
    code: Optional[str] = None
    title_id: int
    team_device_id: Optional[str] = None


class CharacterCreate(CharacterBase):
    dubber_id: Optional[int] = None


class CharacterTeamActorUpdate(BaseModel):
    team_device_id: Optional[str] = None


class SendToActorRequest(BaseModel):
    character_id: int


class CharacterOut(CharacterBase):
    id: int
    dubber_id: Optional[int] = None
    dubber_name: Optional[str] = None

    model_config = {"from_attributes": True}


class DubberBase(BaseModel):
    name: str


class DubberCreate(DubberBase):
    profile_id: Optional[int] = None


class DubberUpdate(BaseModel):
    name: str
    profile_id: Optional[int] = None


class DubberOut(DubberBase):
    id: int
    profile_id: Optional[int] = None

    model_config = {"from_attributes": True}


class CharacterDubberMapCreate(BaseModel):
    character_id: int
    dubber_id: int
    title_id: int


class SubtitleLineBase(BaseModel):
    start_ms: int
    end_ms: int
    text: str = ""
    character_id: Optional[int] = None
    ass_style: str = "Default"
    is_overlap: bool = False
    layer: int = 0
    margin_l: int = 0
    margin_r: int = 0
    margin_v: int = 0
    source_actor_name: Optional[str] = None


class SubtitleLineCreate(SubtitleLineBase):
    pass


class SubtitleLineUpdate(BaseModel):
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    text: Optional[str] = None
    character_id: Optional[int] = None
    ass_style: Optional[str] = None
    is_overlap: Optional[bool] = None
    layer: Optional[int] = None
    margin_l: Optional[int] = None
    margin_r: Optional[int] = None
    margin_v: Optional[int] = None


class SubtitleLineOut(SubtitleLineBase):
    id: int
    episode_id: int
    character_name: Optional[str] = None

    model_config = {"from_attributes": True}


class TranslateRequest(BaseModel):
    provider: Literal["deepl", "gpt", "mymemory", "gemini"]


class MarkerBase(BaseModel):
    reaper_name: str
    position_seconds: float
    confirmed: bool = False
    color: Optional[str] = None
    character_id: Optional[int] = None


class MarkerCreate(MarkerBase):
    pass


class MarkerUpdate(BaseModel):
    reaper_name: Optional[str] = None
    position_seconds: Optional[float] = None
    confirmed: Optional[bool] = None
    color: Optional[str] = None
    character_id: Optional[int] = None


class MarkerOut(MarkerBase):
    id: int
    episode_id: int

    model_config = {"from_attributes": True}


class MarkerColorAssign(BaseModel):
    color: str
    character_id: Optional[int] = None


class ActorAudioSubmitRequest(BaseModel):
    file_path: str
    character_id: Optional[int] = None
    # Set when this upload is the actor's corrected re-take in response to
    # a fix request on another submission — see ActorAudioSubmission.
    # fix_of_submission_id's own comment.
    fix_of_submission_id: Optional[int] = None


class CleanedVideoSubmitRequest(BaseModel):
    file_path: str


class ActorAudioSubmissionOut(BaseModel):
    id: int
    episode_id: int
    character_id: Optional[int] = None
    character_name: Optional[str] = None
    filename: str
    transfer_id: str
    uploaded_by_name: str
    created_at: datetime
    fix_requested_at: Optional[datetime] = None
    fix_requested_by_role: Optional[str] = None
    sent_to_sound_engineer_at: Optional[datetime] = None
    fix_message: Optional[str] = None
    fix_marker_count: int = 0
    fix_of_submission_id: Optional[int] = None
    accepted_at: Optional[datetime] = None
    accepted_by_name: Optional[str] = None

    model_config = {"from_attributes": True}


class ActorAudioFixMarkerOut(BaseModel):
    id: int
    submission_id: int
    label: str
    position_seconds: float
    color: Optional[str] = None

    model_config = {"from_attributes": True}


class ActorAudioFixMarkerImportRequest(BaseModel):
    file_path: str
    bpm: float = 120.0


class TitleRoleAssignmentOut(BaseModel):
    role: str
    device_id: str
    display_name: str

    model_config = {"from_attributes": True}


class TitleRoleAssignmentSet(BaseModel):
    device_id: Optional[str] = None  # null clears the assignment
    display_name: Optional[str] = None


class EpisodeRoleDeadlineOut(BaseModel):
    role: str
    character_id: Optional[int] = None
    deadline: Optional[datetime] = None

    model_config = {"from_attributes": True}


class EpisodeRoleDeadlineSet(BaseModel):
    deadline: Optional[datetime] = None


class EpisodeRoleAssignmentOut(BaseModel):
    role: str
    device_id: str
    display_name: str

    model_config = {"from_attributes": True}


class EpisodeRoleAssignmentSet(BaseModel):
    device_id: Optional[str] = None  # null clears the override, falls back to the title default
    display_name: Optional[str] = None


class EpisodeAdminPersonStatus(BaseModel):
    """One row in the episode "Адмін" tab — either a role slot
    (director/translator/sound_engineer/...) or an actor (character_id set,
    role == "actor")."""
    role: str
    character_id: Optional[int] = None
    character_name: Optional[str] = None
    device_id: Optional[str] = None
    display_name: Optional[str] = None
    status: Optional[str] = None
    badges: Dict[str, bool] = {}
    progress: Optional[str] = None  # e.g. "3/11" for the sound engineer
    deadline: Optional[datetime] = None


class ActorAudioFixRequest(BaseModel):
    message: str = ""
    from_role: str = "director"  # "director" or "sound_engineer" — see ActorAudioSubmission.fix_requested_by_role
    # Optional — a marker CSV to import alongside the text note, so both
    # land as ONE combined fix + ONE notification instead of two separate
    # ones (see request_actor_audio_fix's own docstring).
    marker_file_path: Optional[str] = None
    bpm: float = 120.0


class ActorAudioSendToSoundEngineerRequest(BaseModel):
    submission_ids: List[int]


class RemindRequest(BaseModel):
    role: str
    character_id: Optional[int] = None


class MarkerImportRequest(BaseModel):
    file_path: str
    # Reaper's own native marker CSV export writes positions as
    # Bar.Beat.Fraction (Measures.Beats ruler mode), not a plain timecode —
    # converting that back to seconds needs the project's actual tempo,
    # which the CSV never carries. Defaults to Reaper's own new-project
    # default; the frontend lets the user override it (see MarkersTab.tsx's
    # import button) since it's routinely changed per episode/dialogue.
    bpm: float = 120.0


class ImportVideoRequest(BaseModel):
    file_path: str
    episode_number: int
    season: int = 1


class ActorReaperProjectRequest(BaseModel):
    character_id: int


class SeparateVocalsRequest(BaseModel):
    model: str = "MDX-Net"
    ensemble: bool = False


class AssImportRequest(BaseModel):
    file_path: str
    # False when the director/translator explicitly chose "Очистити" in the
    # confirm dialog shown whenever the CURRENT episode already has actor
    # assignments before importing over them (see SubtitleGrid's own
    # handleAssImport) — default True keeps today's behavior (carry
    # matching-timing assignments forward) for callers that don't ask.
    preserve_assignments: bool = True


class SignStylesUpdate(BaseModel):
    style_names: List[str]


class JobStatusOut(BaseModel):
    id: str
    type: str
    status: str
    percent: int
    message: str
    episode_id: Optional[int] = None
    result: Optional[dict] = None


class WaveformResponse(BaseModel):
    samples: List[float]
    duration: float
    sample_rate: int


class AppSettingsOut(BaseModel):
    reaper_path: Optional[str] = None
    separation_model: str = "MDX-Net"
    ensemble_default: bool = False
    position_format: str = "time"
    default_bpm: Optional[float] = None
    available_models: List[str] = []
    active_profile_id: Optional[int] = None
    active_profile: Optional["ProfileOut"] = None
    power_share_enabled: bool = True
    power_share_auto_approve: bool = False
    online_signaling_enabled: bool = True
    online_signaling_url: Optional[str] = None
    show_feedback_inbox: bool = False
    gpu_enabled: bool = False
    # Read-only, computed — not stored, just reported for the Settings UI to
    # decide what to show (hide the toggle entirely with no NVIDIA GPU;
    # switch "Enable" to "Download" vs. just "Enable" depending on whether
    # the runtime is already cached from a previous install).
    gpu_available: bool = False
    gpu_runtime_installed: bool = False
    # Same "read-only, computed" reasoning as the GPU fields above — see
    # lib_runtime_service.py. audio_separator_update_version is only set
    # when the admin-published remote version differs from what's active.
    audio_separator_version: str = "0.44.3"
    audio_separator_update_version: Optional[str] = None
    beta_features_enabled: bool = False
    # Read-only, computed — see device_identity_service.py. Shown in Settings
    # so a user can read it off to give to a team admin for an invite.
    device_id: str = ""
    deepl_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    sound_engineer_filename_template: Optional[str] = None
    backup_directory: Optional[str] = None

    model_config = {"from_attributes": True}


class AudioSeparatorVersionIn(BaseModel):
    version: str
    wheel_url: str


class AppSettingsUpdate(BaseModel):
    reaper_path: Optional[str] = None
    separation_model: Optional[str] = None
    ensemble_default: Optional[bool] = None
    position_format: Optional[str] = None
    default_bpm: Optional[float] = None
    active_profile_id: Optional[int] = None
    power_share_enabled: Optional[bool] = None
    power_share_auto_approve: Optional[bool] = None
    online_signaling_enabled: Optional[bool] = None
    online_signaling_url: Optional[str] = None
    show_feedback_inbox: Optional[bool] = None
    gpu_enabled: Optional[bool] = None
    beta_features_enabled: Optional[bool] = None
    deepl_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    sound_engineer_filename_template: Optional[str] = None
    backup_directory: Optional[str] = None


class ProfileBase(BaseModel):
    name: str
    role: str = "Звукорежисер"
    # Job-title roles (see models.RoleCatalog) — a profile can hold several
    # at once. None/omitted means "none picked yet", not "no change" (unlike
    # password below) — routers/profiles.py's Profile(**data) / setattr loop
    # always overwrites this the same way every other plain field does.
    roles: Optional[List[str]] = None
    color: str = "#E52128"
    # Only ever True when set via ProfileModal's admin-password flow — see
    # Profile.is_admin's comment for why this lives per-profile, not on
    # AppSettings. Present here (rather than only on ProfileOut) so
    # ProfileCreate can carry it through Profile(**body.model_dump()) in
    # routers/profiles.py with no extra plumbing.
    is_admin: bool = False


class ProfileCreate(ProfileBase):
    # Optional, plaintext in transit (localhost only, same trust model as
    # everything else in this API) — hashed before storage, never round-
    # tripped back out. None means "no password" on create, and "leave
    # whatever's already set unchanged" on update (routers/profiles.py
    # handles that distinction explicitly rather than blindly overwriting
    # password_hash on every edit).
    password: Optional[str] = None


class ProfileOut(ProfileBase):
    id: int
    # Computed — never the hash itself. Tells the frontend to prompt for a
    # password before activating this profile.
    has_password: bool = False
    # Telegram login fields — read-only here (never part of
    # ProfileCreate/update; set only via the dedicated /telegram-login flow).
    telegram_id: Optional[int] = None
    telegram_username: Optional[str] = None
    avatar_url: Optional[str] = None

    model_config = {"from_attributes": True}


class RoleCatalogItem(BaseModel):
    key: str
    label: str
    sort_order: int = 0

    model_config = {"from_attributes": True}


class RoleCatalogCreate(BaseModel):
    key: str
    label: str


class ProfileActivateIn(BaseModel):
    password: Optional[str] = None


class TeamCreateIn(BaseModel):
    name: str
    password: str
    credits_enabled: bool = False


class TeamJoinIn(BaseModel):
    name: str
    password: str
    display_name: str


class TeamInviteIn(BaseModel):
    team_id: str
    invited_device_id: str


class TeamInviteRespondIn(BaseModel):
    invite_id: str
    accept: bool
    display_name: str


class PowerShareRespondIn(BaseModel):
    """Posted by the local user (on the peer machine) clicking Так/Ні."""
    request_id: str
    approved: bool


class HikkaAnimeResult(BaseModel):
    slug: Optional[str] = None
    title_ua: Optional[str] = None
    title_en: Optional[str] = None
    title_ja: Optional[str] = None
    image: Optional[str] = None
    episodes_total: Optional[int] = None
    status: Optional[str] = None


class PosterFromUrlRequest(BaseModel):
    image_url: str


class ApexModelCreate(BaseModel):
    method: str
    label: str
    filename: str


class ApexModelOut(BaseModel):
    id: int
    method: str
    label: str
    filename: str
    arch: str

    model_config = {"from_attributes": True}


class PersonalEnsembleModelCreate(BaseModel):
    method: str
    label: str
    filename: str


class PersonalEnsembleModelOut(BaseModel):
    id: int
    method: str
    label: str
    filename: str
    arch: str

    model_config = {"from_attributes": True}


class ModelChoiceOut(BaseModel):
    label: str
    file: str
    custom: bool = False
    id: Optional[int] = None


class ModelsOut(BaseModel):
    methods: List[str]
    choices: Dict[str, List[ModelChoiceOut]]


class RegistryEntryOut(BaseModel):
    label: str
    filename: str
    stems: List[str]
    is_vocal_separator: Optional[bool] = None


class ModelDownloadRequest(BaseModel):
    method: str
    filename: str
    source: str = "registry"  # "registry" | "custom"
    label: Optional[str] = None
    arch: Optional[str] = None
    download_url: Optional[str] = None
    config_yaml_url: Optional[str] = None


class ModelSubmitRequest(BaseModel):
    url: str


class ModelConfirmRequest(BaseModel):
    method: str
    filename: str
    label: str
    arch: str
    download_url: str
    config_yaml_url: Optional[str] = None
    source_url: str
    notes: Optional[str] = None


class ModelRatingIn(BaseModel):
    method: str
    filename: str
    rating: int


class ModelRatingOut(BaseModel):
    method: str
    filename: str
    profile_name: str
    rating: int

    model_config = {"from_attributes": True}


class ModelDescriptionIn(BaseModel):
    description: str


class ModelDescriptionOut(BaseModel):
    filename: str
    description: str
    updated_by: str
    updated_at: str


class AdminUnlockRequest(BaseModel):
    password: str


class FeedbackCreate(BaseModel):
    message: str


class FeedbackOut(BaseModel):
    id: str
    nickname: str
    device_id: Optional[str] = None
    message: str
    created_at: str


class SeparationReportOut(BaseModel):
    id: str
    profile_name: str
    device_id: Optional[str] = None
    user_timezone: str
    episode_label: str
    model: str
    ensemble: bool
    distributed: bool
    peers_used: List[str]
    duration_seconds: float
    status: str
    error_message: Optional[str] = None
    warnings: List[str] = []
    started_at_utc: str
    created_at: str


class ErrorReportCreate(BaseModel):
    message: str
    stack: Optional[str] = None
    context: str = "renderer"


class ErrorReportOut(BaseModel):
    id: str
    device_id: Optional[str] = None
    profile_name: str
    message: str
    stack: Optional[str] = None
    context: str
    created_at: str


AppSettingsOut.model_rebuild()
