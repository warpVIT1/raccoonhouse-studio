from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, ApexModel, PersonalEnsembleModel, Profile
from ..schemas import (
    ApexModelCreate, ApexModelOut, ModelsOut, RegistryEntryOut,
    PersonalEnsembleModelCreate, PersonalEnsembleModelOut,
)
from ..services import separator_service

router = APIRouter(prefix="/models", tags=["models"])


def _active_profile(db: Session) -> "Profile | None":
    settings = db.get(AppSettings, 1)
    if not settings or not settings.active_profile_id:
        return None
    return db.get(Profile, settings.active_profile_id)


@router.get("", response_model=ModelsOut)
def get_models(db: Session = Depends(get_db)):
    return separator_service.list_model_choices(db)


@router.get("/registry", response_model=list[RegistryEntryOut])
def get_registry(method: str):
    if method not in separator_service.MODEL_CHOICES:
        raise HTTPException(400, f"Невідомий метод: {method}")
    return separator_service.registry_entries_for_method(method)


@router.get("/apex", response_model=list[ApexModelOut])
def get_apex_models(db: Session = Depends(get_db)):
    # Seeds the table from APEX_MODELS_DEFAULT on first-ever read (own
    # short-lived session — see _load_apex_models), then re-reads through
    # this endpoint's own session so the response reflects the committed rows.
    separator_service._load_apex_models()
    # Opportunistic pull from the shared Worker copy — whoever's admin last
    # pushed a change (see add/delete below) — so opening this panel is what
    # actually propagates edits to every other install, not a background
    # poll. Silently a no-op offline/unconfigured (see pull_apex_models).
    #
    # An EMPTY remote list is treated as "nobody has ever pushed yet," not
    # "the admin wants zero models" — confirmed live 2026-08-02: the very
    # first deploy of this sync (before any admin had pushed anything) wiped
    # every install's freshly-seeded default line-up down to nothing, because
    # the fresh Worker endpoint legitimately answers with `[]` until someone
    # pushes. An admin can still reach zero-then-rebuild by removing entries
    # one at a time (each remove pushes immediately — see delete_apex_model),
    # just never by this read-time sync alone.
    from ..services import discovery_service
    remote = discovery_service.pull_apex_models()
    if remote:
        separator_service.sync_apex_models_from_remote(db, remote)
    return db.query(ApexModel).order_by(ApexModel.id).all()


@router.post("/apex", response_model=ApexModelOut)
def add_apex_model(body: ApexModelCreate, db: Session = Depends(get_db)):
    if body.method not in separator_service.MODEL_CHOICES:
        raise HTTPException(400, f"Невідомий метод: {body.method}")
    label = body.label.strip()
    filename = body.filename.strip()
    if not label or not filename:
        raise HTTPException(400, "Вкажіть назву і файл моделі")

    separator_service._load_apex_models()  # ensure seeded before checking for a duplicate
    if db.query(ApexModel).filter_by(filename=filename).first():
        raise HTTPException(400, "Ця модель вже в складі Апекс")

    found, looks_vocal, stems = separator_service.check_registry_model(body.method, filename)
    if not found:
        raise HTTPException(
            400,
            f"Файл '{filename}' не знайдено в реєстрі audio-separator для методу {body.method} — "
            "перевірте точну назву файлу (з розширенням).",
        )
    if not looks_vocal:
        raise HTTPException(
            400,
            f"Ця модель не розділяє вокал/інструментал (її стеми: {', '.join(stems)}) — "
            "вона призначена для іншої задачі (наприклад, прибирання луни/шуму/ревербу). "
            "Оберіть модель, що дає стеми vocals/instrumental.",
        )

    row = ApexModel(method=body.method, label=label, filename=filename, arch=separator_service.MODEL_ARCH[body.method])
    db.add(row)
    db.commit()
    db.refresh(row)
    separator_service.push_apex_models_to_worker(db)
    return row


@router.delete("/apex/{model_id}")
def delete_apex_model(model_id: int, db: Session = Depends(get_db)):
    row = db.get(ApexModel, model_id)
    if not row:
        raise HTTPException(404, "Не знайдено")
    # Апекс's job loop divides by len(jobs) — an empty line-up would break
    # separation the next time someone runs it, not just look empty in the UI.
    if db.query(ApexModel).count() <= 1:
        raise HTTPException(400, "Апекс має містити хоча б одну модель — спершу додайте іншу")
    db.delete(row)
    db.commit()
    separator_service.push_apex_models_to_worker(db)
    return {"ok": True}


# --- "Мій ансамбль" — personal, per-profile, local-only (no Worker sync,
# unlike Апекс above) and starts EMPTY for every profile: the point is each
# person choosing their own set, not sharing one curated studio-wide list. ---

@router.get("/personal-ensemble", response_model=list[PersonalEnsembleModelOut])
def get_personal_ensemble(db: Session = Depends(get_db)):
    profile = _active_profile(db)
    if not profile:
        return []
    return (
        db.query(PersonalEnsembleModel)
        .filter_by(profile_id=profile.id)
        .order_by(PersonalEnsembleModel.id)
        .all()
    )


@router.post("/personal-ensemble", response_model=PersonalEnsembleModelOut)
def add_personal_ensemble_model(body: PersonalEnsembleModelCreate, db: Session = Depends(get_db)):
    profile = _active_profile(db)
    if not profile:
        raise HTTPException(400, "Оберіть профіль")
    if body.method not in separator_service.MODEL_CHOICES:
        raise HTTPException(400, f"Невідомий метод: {body.method}")
    label = body.label.strip()
    filename = body.filename.strip()
    if not label or not filename:
        raise HTTPException(400, "Вкажіть назву і файл моделі")

    if (
        db.query(PersonalEnsembleModel)
        .filter_by(profile_id=profile.id, filename=filename)
        .first()
    ):
        raise HTTPException(400, "Ця модель вже у вашому ансамблі")

    found, looks_vocal, stems = separator_service.check_registry_model(body.method, filename)
    is_downloaded_custom = filename in separator_service.downloaded_model_filenames()
    if not found and not is_downloaded_custom:
        raise HTTPException(
            400,
            f"Файл '{filename}' не знайдено в реєстрі audio-separator для методу {body.method} — "
            "перевірте точну назву файлу (з розширенням).",
        )
    if found and not looks_vocal:
        raise HTTPException(
            400,
            f"Ця модель не розділяє вокал/інструментал (її стеми: {', '.join(stems)}) — "
            "вона призначена для іншої задачі (наприклад, прибирання луни/шуму/ревербу). "
            "Оберіть модель, що дає стеми vocals/instrumental.",
        )

    row = PersonalEnsembleModel(
        profile_id=profile.id, method=body.method, label=label, filename=filename,
        arch=separator_service.MODEL_ARCH[body.method],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/personal-ensemble/{model_id}")
def delete_personal_ensemble_model(model_id: int, db: Session = Depends(get_db)):
    profile = _active_profile(db)
    if not profile:
        raise HTTPException(400, "Оберіть профіль")
    row = db.get(PersonalEnsembleModel, model_id)
    if not row or row.profile_id != profile.id:
        raise HTTPException(404, "Не знайдено")
    db.delete(row)
    db.commit()
    return {"ok": True}
