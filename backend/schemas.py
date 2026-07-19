from datetime import datetime
from typing import Optional, List
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
    power_share_enabled: bool = False
    manual_peer_host: Optional[str] = None
    manual_peer_port: int = 8765

    model_config = {"from_attributes": True}


class AppSettingsUpdate(BaseModel):
    reaper_path: Optional[str] = None
    separation_model: Optional[str] = None
    ensemble_default: Optional[bool] = None
    position_format: Optional[str] = None
    default_bpm: Optional[float] = None
    active_profile_id: Optional[int] = None
    power_share_enabled: Optional[bool] = None
    manual_peer_host: Optional[str] = None
    manual_peer_port: Optional[int] = None


class ProfileBase(BaseModel):
    name: str
    role: str = "Звукорежисер"
    color: str = "#E52128"


class ProfileCreate(ProfileBase):
    pass


class ProfileOut(ProfileBase):
    id: int

    model_config = {"from_attributes": True}


class PowerShareRequestIn(BaseModel):
    """Sent by the requester's machine to a peer's /power-share/consent-request."""
    requester_name: str
    requester_host: str
    requester_port: int = 8765
    title_id: int
    title_name: str
    episode_number: int
    task: str = "separate"  # "separate" (vocal isolation) | "import" (full ffmpeg import)


class PowerShareRespondIn(BaseModel):
    """Posted by the local user (on the peer machine) clicking Так/Ні."""
    request_id: str
    approved: bool


class PowerShareDecisionOut(BaseModel):
    request_id: str
    approved: bool
    reason: str = ""  # "approved" | "denied" | "timeout" | "remembered"


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


AppSettingsOut.model_rebuild()
