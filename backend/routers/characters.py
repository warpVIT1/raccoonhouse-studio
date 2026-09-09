from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional

from ..database import get_db
from ..models import AppSettings, Character, Dubber, CharacterDubberMap, Profile, Title
from ..schemas import (
    CharacterCreate, CharacterOut, CharacterTeamActorUpdate, DubberCreate, DubberUpdate, DubberOut,
    CharacterDubberMapCreate,
)

router = APIRouter(tags=["characters"])


@router.get("/characters", response_model=List[CharacterOut])
def list_characters(title_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(Character)
    if title_id:
        q = q.filter(Character.title_id == title_id)
    chars = q.all()
    result = []
    for c in chars:
        out = CharacterOut.model_validate(c)
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
    char = db.get(Character, char_id)
    if not char:
        raise HTTPException(404)
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
