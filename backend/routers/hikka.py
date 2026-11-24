from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Character, Title
from ..schemas import (
    CharacterImageRequest, CharacterImageSuggestion, CharacterOut, HikkaAnimeResult, HikkaSlugRequest,
    PosterFromUrlRequest, TitleOut,
)
from ..services import character_match, character_sources, hikka_service

router = APIRouter(tags=["hikka"])


@router.get("/hikka/search", response_model=List[HikkaAnimeResult])
def search_hikka(query: str):
    try:
        return hikka_service.search_anime(query)
    except Exception as exc:
        raise HTTPException(502, f"Hikka API request failed: {exc}")


@router.post("/titles/{title_id}/poster-from-url", response_model=TitleOut)
def set_poster_from_url(title_id: int, body: PosterFromUrlRequest, db: Session = Depends(get_db)):
    """Store the Hikka CDN URL directly — poster loads live from the internet,
    nothing is downloaded or cached on disk."""
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    title.poster_path = body.image_url
    if body.hikka_slug:
        title.hikka_slug = body.hikka_slug
    db.commit()
    db.refresh(title)
    if title.shared_id:
        from ..services import sync_service
        sync_service.push_title(title_id, db)
    return TitleOut.model_validate(title)


@router.put("/titles/{title_id}/hikka-slug", response_model=TitleOut)
def set_hikka_slug(title_id: int, body: HikkaSlugRequest, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    title.hikka_slug = body.slug.strip() or None
    db.commit()
    db.refresh(title)
    return TitleOut.model_validate(title)


@router.post("/titles/{title_id}/find-character-images", response_model=List[CharacterImageSuggestion])
def find_character_images(title_id: int, db: Session = Depends(get_db)):
    """Matches this title's characters against Hikka's character list.
    Only an unambiguous near-exact match is applied automatically (and only to
    characters that have no portrait yet); everything else comes back as up to
    3 ranked candidates for the director to confirm with one click."""
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    if not title.hikka_slug:
        raise HTTPException(409, "Спершу виберіть аніме на Hikka для цього тайтлу")
    by_source: dict = {}
    hikka_error = None
    try:
        by_source["hikka"] = hikka_service.get_anime_characters(title.hikka_slug)
    except Exception as exc:
        hikka_error = exc
    # Extra sources are keyed by the MyAnimeList id Hikka stores for the anime.
    # Each one is best-effort: a source that is down/blocked is just left out.
    mal_id = character_sources.get_mal_id(title.hikka_slug)
    if mal_id:
        by_source["anilist"] = character_sources.fetch_anilist(mal_id)
        by_source["jikan"] = character_sources.fetch_jikan(mal_id)
    if not any(by_source.values()):
        raise HTTPException(502, f"Не вдалося отримати персонажів: {hikka_error or 'жодне джерело не відповіло'}")

    result: List[CharacterImageSuggestion] = []
    for ch in db.query(Character).filter(Character.title_id == title_id).all():
        ranked = character_match.rank_multi(ch.name, by_source)
        applied = False
        if ranked["auto"] and not ch.image_url:
            ch.image_url = ranked["auto"]["image"]
            applied = True
        result.append(CharacterImageSuggestion(
            character_id=ch.id, auto_applied=applied, candidates=ranked["candidates"],
        ))
    db.commit()
    return result


@router.put("/characters/{character_id}/image", response_model=CharacterOut)
def set_character_image(character_id: int, body: CharacterImageRequest, db: Session = Depends(get_db)):
    ch = db.get(Character, character_id)
    if not ch:
        raise HTTPException(404, "Character not found")
    url = (body.image_url or "").strip() or None
    if url and not url.startswith("https://"):
        raise HTTPException(422, "image_url має бути https-посиланням")
    ch.image_url = url
    try:
        from .characters import _remove_local_images
        _remove_local_images(ch.id)  # a manual upload is replaced by the new choice
    except Exception:
        pass
    db.commit()
    db.refresh(ch)
    return CharacterOut.model_validate(ch)
