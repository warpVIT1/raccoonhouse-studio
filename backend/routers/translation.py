from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, SubtitleLine
from ..schemas import TranslateRequest
from ..services import translation_service

router = APIRouter(tags=["translation"])


@router.post("/subtitle-lines/{line_id}/translate")
def translate_line(line_id: int, body: TranslateRequest, db: Session = Depends(get_db)):
    line = db.get(SubtitleLine, line_id)
    if not line:
        raise HTTPException(404)

    # Context comes from the real current DB state, not whatever the
    # frontend's own in-memory `subtitles` array happens to hold — avoids a
    # stale-context bug if another workspace/session edited a neighboring
    # line since this one last fetched the list.
    siblings = (
        db.query(SubtitleLine)
        .filter(SubtitleLine.episode_id == line.episode_id)
        .order_by(SubtitleLine.start_ms)
        .all()
    )
    idx = next((i for i, s in enumerate(siblings) if s.id == line.id), None)
    context_before = siblings[idx - 1].text if idx and idx > 0 else ""
    context_after = siblings[idx + 1].text if idx is not None and idx + 1 < len(siblings) else ""

    # MyMemory needs no key at all (see translation_service.translate_mymemory) —
    # DeepL/GPT/Gemini are gated on having one configured in Settings.
    api_key = None
    if body.provider != "mymemory":
        settings = db.get(AppSettings, 1)
        key_field = {"deepl": "deepl_api_key", "gpt": "openai_api_key", "gemini": "gemini_api_key"}[body.provider]
        api_key = getattr(settings, key_field, None) if settings else None
        if not api_key:
            provider_label = {"deepl": "DeepL", "gpt": "OpenAI", "gemini": "Gemini"}[body.provider]
            raise HTTPException(400, f"{provider_label} API-ключ не налаштовано в Налаштуваннях")

    try:
        text = translation_service.translate(body.provider, line.text, context_before, context_after, api_key)
    except translation_service.TranslationError as e:
        raise HTTPException(502, str(e))

    return {"text": text}
