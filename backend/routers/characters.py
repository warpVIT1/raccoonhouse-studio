import base64
import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session
from typing import List, Optional

from ..database import DATA_DIR, get_db
from ..models import (
    ActorAudioSubmission, AppSettings, Character, Dubber, CharacterDubberMap, Episode, Marker, Profile, SubtitleLine, Title,
)
from ..schemas import (
    CharacterCreate, CharacterOut, CharacterTeamActorUpdate, DubberCreate, DubberUpdate, DubberOut,
    CharacterDubberMapCreate, CharacterImageUpload, CharacterRenameRequest, RolesFromSubtitlesOut, SkippedRoleName,
)

router = APIRouter(tags=["characters"])


@router.get("/characters", response_model=List[CharacterOut])
def list_characters(title_id: Optional[int] = None, episode_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(Character)
    if title_id:
        q = q.filter(Character.title_id == title_id)
    chars = q.all()
    # One grouped query for every character's line count instead of one count
    # per character: per episode when asked, otherwise across the title.
    counts_q = db.query(SubtitleLine.character_id, func.count(SubtitleLine.id)).filter(
        SubtitleLine.character_id.isnot(None)
    )
    if episode_id:
        counts_q = counts_q.filter(SubtitleLine.episode_id == episode_id)
    elif title_id:
        counts_q = counts_q.join(Episode, SubtitleLine.episode_id == Episode.id).filter(Episode.title_id == title_id)
    line_counts = dict(counts_q.group_by(SubtitleLine.character_id).all())
    result = []
    for c in chars:
        out = CharacterOut.model_validate(c)
        out.line_count = line_counts.get(c.id, 0)
        # Resolve dubber
        mapping = db.query(CharacterDubberMap).filter(
            CharacterDubberMap.character_id == c.id,
            CharacterDubberMap.title_id == c.title_id,
        ).first()
        if mapping:
            dubber = db.get(Dubber, mapping.dubber_id)
            out.dubber_id = mapping.dubber_id
            out.dubber_name = dubber.name if dubber else None
        result.append(out)
    return result


@router.post("/characters", response_model=CharacterOut, status_code=201)
def create_character(body: CharacterCreate, db: Session = Depends(get_db)):
    # Picking a team actor from the АКТОР dropdown reuses an existing
    # Character already tied to that actor's device_id in this title
    # instead of creating a duplicate row every time (mirrors how Dubber
    # creation upserts by name above).
    if body.team_device_id:
        existing = db.query(Character).filter(
            Character.title_id == body.title_id,
            Character.team_device_id == body.team_device_id,
        ).first()
        if existing:
            out = CharacterOut.model_validate(existing)
            mapping = db.query(CharacterDubberMap).filter(
                CharacterDubberMap.character_id == existing.id,
                CharacterDubberMap.title_id == existing.title_id,
            ).first()
            if mapping:
                dubber = db.get(Dubber, mapping.dubber_id)
                out.dubber_id = mapping.dubber_id
                out.dubber_name = dubber.name if dubber else None
            return out

    char = Character(title_id=body.title_id, name=body.name, code=body.code, team_device_id=body.team_device_id)
    db.add(char)
    db.flush()
    if body.dubber_id:
        db.add(CharacterDubberMap(character_id=char.id, dubber_id=body.dubber_id, title_id=body.title_id))
    db.commit()
    db.refresh(char)
    title = db.get(Title, body.title_id)
    if title and title.shared_id:
        from ..services import sync_service
        sync_service.push_character(char.id, db)
    out = CharacterOut.model_validate(char)
    if body.dubber_id:
        dubber = db.get(Dubber, body.dubber_id)
        out.dubber_id = body.dubber_id
        out.dubber_name = dubber.name if dubber else None
    return out


@router.put("/characters/{char_id}", response_model=CharacterOut)
def update_character(char_id: int, body: CharacterCreate, db: Session = Depends(get_db)):
    char = db.get(Character, char_id)
    if not char:
        raise HTTPException(404)
    char.name = body.name
    char.code = body.code
    if body.dubber_id is not None:
        mapping = db.query(CharacterDubberMap).filter(
            CharacterDubberMap.character_id == char_id,
            CharacterDubberMap.title_id == body.title_id,
        ).first()
        if mapping:
            mapping.dubber_id = body.dubber_id
        else:
            db.add(CharacterDubberMap(character_id=char_id, dubber_id=body.dubber_id, title_id=body.title_id))
    db.commit()
    db.refresh(char)
    out = CharacterOut.model_validate(char)
    if body.dubber_id:
        dubber = db.get(Dubber, body.dubber_id)
        out.dubber_id = body.dubber_id
        out.dubber_name = dubber.name if dubber else None
    return out


@router.delete("/characters/{char_id}", status_code=204)
def delete_character(char_id: int, db: Session = Depends(get_db)):
    """Removes a character from the roster. Cloud delete FIRST, local
    delete only after it actually succeeds — same strict posture as
    routers/titles.py's delete_title, closing the exact same bug class:
    confirmed live 2026-09-10 that this used to be a purely local delete,
    so the cloud's shared_characters row stayed alive forever and a
    re-added actor got a brand new duplicate row instead of reusing it
    (visible as the same actor listed twice in the Marker Manager Reaper
    script's cast list). Un-assigns (never deletes) any subtitle lines/
    markers/audio submissions that referenced this character — removing a
    roster slot shouldn't destroy real content, just its character tag."""
    char = db.get(Character, char_id)
    if not char:
        raise HTTPException(404)
    if char.shared_id and char.title.team_id:
        from ..services import device_identity_service, sync_service
        settings = db.get(AppSettings, 1)
        profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
        if not profile:
            raise HTTPException(400, "Немає активного профілю")
        device_id = device_identity_service.get_profile_id(profile.name)
        if not sync_service.delete_shared_character(char.shared_id, char.title.team_id, device_id, strict=True):
            raise HTTPException(502, "Не вдалося видалити персонажа у хмарі — спробуйте ще раз")
    _remove_local_images(char_id)
    db.query(SubtitleLine).filter(SubtitleLine.character_id == char_id).update({"character_id": None})
    db.query(Marker).filter(Marker.character_id == char_id).update({"character_id": None})
    db.query(ActorAudioSubmission).filter(ActorAudioSubmission.character_id == char_id).update({"character_id": None})
    db.query(CharacterDubberMap).filter(CharacterDubberMap.character_id == char_id).delete()
    db.delete(char)
    db.commit()


@router.put("/characters/{char_id}/team-actor", response_model=CharacterOut)
def assign_team_actor(char_id: int, body: CharacterTeamActorUpdate, db: Session = Depends(get_db)):
    """Sets (or, with a null body, clears) ONLY `team_device_id` — kept
    separate from `update_character`/`CharacterCreate`, which unconditionally
    overwrites `name`/`code` on every call and isn't safe to reuse for a
    single-field patch. This is what DirectorWorkspace's "Персонажі цього
    тайтлу" panel now uses to assign a real team actor (see
    `GET /teams/{team_id}/actors`), the same field the subtitle grid's own
    АКТОР dropdown sets — so a character an actor already picked for
    themselves shows up pre-selected here too, since it's the same field
    rather than two separately-tracked assignments."""
    char = db.get(Character, char_id)
    if not char:
        raise HTTPException(404)
    char.team_device_id = body.team_device_id
    db.commit()
    db.refresh(char)
    if char.shared_id:
        from ..services import sync_service
        sync_service.push_character_team_actor(char.id, db)
    out = CharacterOut.model_validate(char)
    mapping = db.query(CharacterDubberMap).filter(
        CharacterDubberMap.character_id == char.id,
        CharacterDubberMap.title_id == char.title_id,
    ).first()
    if mapping:
        dubber = db.get(Dubber, mapping.dubber_id)
        out.dubber_id = mapping.dubber_id
        out.dubber_name = dubber.name if dubber else None
    return out


@router.get("/dubbers", response_model=List[DubberOut])
def list_dubbers(db: Session = Depends(get_db)):
    return db.query(Dubber).all()


@router.post("/dubbers", response_model=DubberOut, status_code=201)
def create_dubber(body: DubberCreate, db: Session = Depends(get_db)):
    # Upsert by name
    existing = db.query(Dubber).filter(Dubber.name == body.name).first()
    if existing:
        return existing
    dubber = Dubber(name=body.name, profile_id=body.profile_id)
    db.add(dubber)
    db.commit()
    db.refresh(dubber)
    return dubber


@router.put("/dubbers/{dubber_id}", response_model=DubberOut)
def update_dubber(dubber_id: int, body: DubberUpdate, db: Session = Depends(get_db)):
    # Was missing entirely before — a Dubber could be created but never
    # renamed or linked to a Profile (see profile_id's own comment) except
    # by hand-editing the database.
    dubber = db.get(Dubber, dubber_id)
    if not dubber:
        raise HTTPException(404)
    dubber.name = body.name
    dubber.profile_id = body.profile_id
    db.commit()
    db.refresh(dubber)
    return dubber


@router.delete("/dubbers/{dubber_id}", status_code=204)
def delete_dubber(dubber_id: int, db: Session = Depends(get_db)):
    # Was missing entirely before (pre-existing gap, not something a
    # feature this session touched) — a Dubber added by mistake had no way
    # to be removed except by hand-editing the database.
    dubber = db.get(Dubber, dubber_id)
    if not dubber:
        raise HTTPException(404)
    db.query(CharacterDubberMap).filter(CharacterDubberMap.dubber_id == dubber_id).delete()
    db.delete(dubber)
    db.commit()


@router.post("/character-dubber-map", status_code=204)
def set_dubber_mapping(body: CharacterDubberMapCreate, db: Session = Depends(get_db)):
    existing = db.query(CharacterDubberMap).filter(
        CharacterDubberMap.character_id == body.character_id,
        CharacterDubberMap.title_id == body.title_id,
    ).first()
    if existing:
        existing.dubber_id = body.dubber_id
    else:
        db.add(CharacterDubberMap(**body.model_dump()))
    db.commit()


@router.get("/titles/{title_id}/my-character", response_model=List[CharacterOut])
def my_characters(title_id: int, db: Session = Depends(get_db)):
    """Resolves which Character(s) belong to the ACTIVE profile in this
    title — what the "actor" role workspace needs to know "which subtitle
    lines/markers are mine". Two independent paths, unioned together:
    (1) legacy: profile -> linked Dubber (Dubber.profile_id) -> every
    Character that Dubber voices (CharacterDubberMap) — the Director's
    "Ролі" tab assignment.
    (2) profile's own team_device_id -> every Character directly tied to it
    (Character.team_device_id, set via the subtitle grid's АКТОР dropdown —
    see the just-shipped actor-dropdown feature). Without this second path,
    an actor picked straight from the team-actor dropdown would never see
    their own lines here at all, since that flow never touches Dubber/
    CharacterDubberMap — confirmed live 2026-08-17 as the reason a director-
    assigned actor saw the Telegram ping but nothing in their own app.
    Empty list (not 404) if there's no active profile or neither path
    resolves anything — a normal "nothing to show yet" state, not an error."""
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    if not profile:
        return []

    result: list[CharacterOut] = []
    seen_char_ids: set[int] = set()

    dubber = db.query(Dubber).filter(Dubber.profile_id == profile.id).first()
    if dubber:
        mappings = db.query(CharacterDubberMap).filter(
            CharacterDubberMap.dubber_id == dubber.id,
            CharacterDubberMap.title_id == title_id,
        ).all()
        for m in mappings:
            char = db.get(Character, m.character_id)
            if char and char.id not in seen_char_ids:
                out = CharacterOut.model_validate(char)
                out.dubber_id = dubber.id
                out.dubber_name = dubber.name
                result.append(out)
                seen_char_ids.add(char.id)

    from ..services import device_identity_service
    team_device_id = device_identity_service.get_profile_id(profile.name)
    team_chars = db.query(Character).filter(
        Character.title_id == title_id, Character.team_device_id == team_device_id,
    ).all()
    for char in team_chars:
        if char.id in seen_char_ids:
            continue
        result.append(CharacterOut.model_validate(char))
        seen_char_ids.add(char.id)

    return result


# ASS "Name" values that are never a speaking role: on-screen signs, episode
# titles, songs/karaoke, comments, the unnamed default. Their lines are left
# unassigned instead of becoming a bogus "SIGN" actor slot.
_NON_ROLE_PREFIX_RE = re.compile(r"^(sign|eptitle|karaoke|credit|надпис|титр|пісн|пiсн)", re.IGNORECASE)
_NON_ROLE_EXACT = {"default", "title", "text", "note", "notes", "comment", "song", "songs", "sing"}


def _role_skip_reason(name: str) -> Optional[str]:
    if not re.search(r"\w", name, re.UNICODE):
        return "empty"
    if re.search(r"[/,]", name):
        return "overlap"
    stripped = name.strip()
    # "OP"/"ED" only in capitals: a character can legitimately be called "Ed".
    if _NON_ROLE_PREFIX_RE.match(stripped) or stripped.casefold() in _NON_ROLE_EXACT or stripped in ("OP", "ED"):
        return "non-role"
    return None


@router.post("/episodes/{ep_id}/roles-from-subtitles", response_model=RolesFromSubtitlesOut)
def build_roles_from_subtitles(ep_id: int, db: Session = Depends(get_db)):
    """Turns the ASS "Name" column of this episode's lines into the title's
    roster: one Character per distinct speaking name (matched case-
    insensitively against existing characters, never duplicated), then tags
    every still-unassigned line with it. Lines that already have a character
    are never touched, so re-running after a re-import is safe."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    rows = (
        db.query(SubtitleLine.source_actor_name, func.count(SubtitleLine.id))
        .filter(SubtitleLine.episode_id == ep_id, SubtitleLine.source_actor_name.isnot(None))
        .group_by(SubtitleLine.source_actor_name)
        .all()
    )
    existing: dict[str, Character] = {}
    for c in db.query(Character).filter(Character.title_id == ep.title_id).all():
        # Both the current name and the original subtitle name resolve to the
        # role, so a role renamed to Ukrainian is still found by its ASS name.
        existing.setdefault(c.name.strip().casefold(), c)
        if c.source_name:
            existing.setdefault(c.source_name.strip().casefold(), c)
    result = RolesFromSubtitlesOut()
    new_characters: List[Character] = []
    name_to_char: dict[str, Character] = {}

    for raw_name, count in rows:
        name = (raw_name or "").strip()
        if _role_skip_reason(name):
            result.skipped.append(SkippedRoleName(name=name or "—", count=count))
            continue
        key = name.casefold()
        char = existing.get(key)
        if char:
            # Same name in another case ("PERU"/"peru") reuses the character
            # created a moment ago; only count genuinely pre-existing ones.
            if not any(char is c for c in new_characters):
                result.existing += 1
        else:
            char = Character(title_id=ep.title_id, name=name, source_name=name)
            db.add(char)
            existing[key] = char
            new_characters.append(char)
            result.created += 1
        if not char.source_name:
            char.source_name = name  # backfill roles created before this column existed
        name_to_char[raw_name] = char

    db.flush()
    for raw_name, char in name_to_char.items():
        updated = (
            db.query(SubtitleLine)
            .filter(
                SubtitleLine.episode_id == ep_id,
                SubtitleLine.source_actor_name == raw_name,
                SubtitleLine.character_id.is_(None),
            )
            .update({"character_id": char.id}, synchronize_session=False)
        )
        result.assigned_lines += updated
    db.commit()

    title = db.get(Title, ep.title_id)
    if title and title.shared_id:
        try:
            from ..services import sync_service
            for char in new_characters:
                sync_service.push_character(char.id, db)
            if result.assigned_lines:
                sync_service.push_subtitle_lines(ep_id, db)
        except Exception:
            from ..services.power_share_service import app_logger
            app_logger.exception("roles-from-subtitles: cloud push failed for episode %s", ep_id)
    return result


@router.put("/characters/{char_id}/name", response_model=CharacterOut)
def rename_character(char_id: int, body: CharacterRenameRequest, db: Session = Depends(get_db)):
    """Renames a role (typically original -> Ukrainian). The original name is
    remembered in source_name so rebuilding roles from subtitles still matches."""
    char = db.get(Character, char_id)
    if not char:
        raise HTTPException(404, "Character not found")
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(422, "Ім'я не може бути порожнім")
    if new_name.casefold() != char.name.strip().casefold():
        clash = (
            db.query(Character)
            .filter(Character.title_id == char.title_id, Character.id != char.id)
            .all()
        )
        if any(c.name.strip().casefold() == new_name.casefold() for c in clash):
            raise HTTPException(409, "Роль з таким ім'ям вже є")
    if not char.source_name:
        char.source_name = char.name
    char.name = new_name
    db.commit()
    db.refresh(char)
    if char.shared_id:
        try:
            from ..services import sync_service
            sync_service.push_character_team_actor(char.id, db)  # carries the name too
        except Exception:
            from ..services.power_share_service import app_logger
            app_logger.exception("rename_character: cloud push failed for character %s", char_id)
    return CharacterOut.model_validate(char)


# --- Manually chosen portraits -------------------------------------------
# The renderer downsizes the picked/pasted image and sends it as a data URL;
# it is stored as a plain file under <data>/character_images/ and served back
# through GET /characters/{id}/image-file (character.image_url then holds that
# relative API path with a cache-busting version).
_IMAGE_DIR = Path(DATA_DIR) / "character_images"
_MAX_IMAGE_BYTES = 3 * 1024 * 1024
_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp);base64,(.+)$", re.DOTALL)


def _sniff_image_ext(raw: bytes) -> Optional[str]:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def _remove_local_images(char_id: int) -> None:
    if not _IMAGE_DIR.is_dir():
        return
    for p in _IMAGE_DIR.glob(f"{char_id}.*"):
        try:
            p.unlink()
        except OSError:
            pass


@router.put("/characters/{character_id}/image-upload", response_model=CharacterOut)
def upload_character_image(character_id: int, body: CharacterImageUpload, db: Session = Depends(get_db)):
    ch = db.get(Character, character_id)
    if not ch:
        raise HTTPException(404, "Character not found")
    m = _DATA_URL_RE.match(body.data_url.strip())
    if not m:
        raise HTTPException(422, "Очікується зображення png/jpeg/webp")
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except Exception:
        raise HTTPException(422, "Пошкоджені дані зображення")
    if len(raw) > _MAX_IMAGE_BYTES:
        raise HTTPException(413, "Зображення завелике (максимум 3 МБ)")
    ext = _sniff_image_ext(raw)
    if not ext:
        raise HTTPException(422, "Файл не схожий на png/jpeg/webp")
    _IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    _remove_local_images(character_id)
    (_IMAGE_DIR / f"{character_id}.{ext}").write_bytes(raw)
    ch.image_url = f"/api/characters/{character_id}/image-file?v={int(time.time())}"
    db.commit()
    db.refresh(ch)
    return CharacterOut.model_validate(ch)


@router.get("/characters/{character_id}/image-file")
def get_character_image_file(character_id: int):
    for ext, media in (("png", "image/png"), ("jpg", "image/jpeg"), ("webp", "image/webp")):
        p = _IMAGE_DIR / f"{character_id}.{ext}"
        if p.is_file():
            return FileResponse(str(p), media_type=media, headers={"Cache-Control": "private, max-age=86400"})
    raise HTTPException(404, "No image")
