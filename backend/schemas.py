from datetime import datetime
from typing import Optional, List, Dict
from pydantic import BaseModel


class TitleBase(BaseModel):
    name_ua: str
    name_original: str = ""
    poster_path: Optional[str] = None
    status: str = "new"
    show_key: Optional[str] = None


class TitleCreate(TitleBase):
    pass


class TitleUpdate(BaseModel):
    name_ua: Optional[str] = None
    name_original: Optional[str] = None
    poster_path: Optional[str] = None
    status: Optional[str] = None
    show_key: Optional[str] = None


class TitleOut(TitleBase):
    id: int
    episode_count: int = 0

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

    model_config = {"from_attributes": True}


class CharacterBase(BaseModel):
    name: str
    code: Optional[str] = None
    title_id: int


class CharacterCreate(CharacterBase):
    dubber_id: Optional[int] = None


class CharacterOut(CharacterBase):
    id: int
    dubber_id: Optional[int] = None
    dubber_name: Optional[str] = None

    model_config = {"from_attributes": True}


class DubberBase(BaseModel):
    name: str


class DubberCreate(DubberBase):
    pass


class DubberOut(DubberBase):
    id: int

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


class SubtitleLineCreate(SubtitleLineBase):
    pass


class SubtitleLineUpdate(BaseModel):
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    text: Optional[str] = None
    character_id: Optional[int] = None
    ass_style: Optional[str] = None
    is_overlap: Optional[bool] = None


class SubtitleLineOut(SubtitleLineBase):
    id: int
    episode_id: int
    character_name: Optional[str] = None

    model_config = {"from_attributes": True}


class MarkerBase(BaseModel):
    reaper_name: str
    position_seconds: float
    confirmed: bool = False
    color: Optional[str] = None


class MarkerCreate(MarkerBase):
    pass


class MarkerUpdate(BaseModel):
    reaper_name: Optional[str] = None
    position_seconds: Optional[float] = None
    confirmed: Optional[bool] = None
    color: Optional[str] = None


class MarkerOut(MarkerBase):
    id: int
    episode_id: int

    model_config = {"from_attributes": True}


class ImportVideoRequest(BaseModel):
    file_path: str
    episode_number: int
    season: int = 1


class SeparateVocalsRequest(BaseModel):
    model: str = "MDX-Net"
    ensemble: bool = False


class AssImportRequest(BaseModel):
    file_path: str


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

    model_config = {"from_attributes": True}


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


class ProfileBase(BaseModel):
    name: str
    role: str = "Звукорежисер"
    color: str = "#E52128"
    # Only ever True when set via ProfileModal's admin-password flow — see
    # Profile.is_admin's comment for why this lives per-profile, not on
    # AppSettings. Present here (rather than only on ProfileOut) so
    # ProfileCreate can carry it through Profile(**body.model_dump()) in
    # routers/profiles.py with no extra plumbing.
    is_admin: bool = False


class ProfileCreate(ProfileBase):
    pass


class ProfileOut(ProfileBase):
    id: int

    model_config = {"from_attributes": True}


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
    message: str
    created_at: str


class SeparationReportOut(BaseModel):
    id: str
    profile_name: str
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


AppSettingsOut.model_rebuild()
