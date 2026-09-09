"""
MVSep (mvsep.com) cloud separation — the "credit" neural networks, distinct
from every other model in this app which runs locally via audio-separator.
One shared studio account/api_token (see team_service.get_mvsep_config),
so adding paid credits later needs no app update and no per-person MVSep
account — matches the explicit requirement that flipping this on for
everyone happens purely server-side (Cloudflare Worker), the same pattern
already used for Апекс/audio-separator version.

API confirmed live 2026-08-09 against the real endpoint with the studio's
own token (not just going off mvsep.com/en/full_api's docs) — sep_type=40/
add_opt1=81 returned algorithm="BS Roformer (vocals, instrumental)" and
real output files. The non-vocal stem comes back labeled "Other", NOT
"Instrumental" — _pick_stem_url below accounts for both spellings since
which one a given MVSep model uses isn't consistent.

mvsep.com's real full catalog (confirmed against the actual site, not just
docs) has 130+ sep_types, but almost all of them (single instrument
isolators — tuba, banjo, clarinet…; TTS/voice cloning; song generation;
MIDI transcription; audio upscaling) are a different job entirely from
"isolate vocal from instrumental for dubbing": some don't even take an
audio file as input, others return stems that have nothing to do with
vocals/instrumental. MVSEP_CATEGORIES below is restricted to sep_types that
can produce a genuine vocal + full-instrumental pair — see run_separation's
"sum every non-vocal stem" approach, which is what makes multistem entries
like BS Roformer SW or MVSep DnR v3 (3+ stems, no single file literally
typed "Instrumental") work correctly rather than quietly shipping an
instrumental that's missing its drums/bass/effects. Two categories of
model still can NEVER work here and are deliberately left out even though
they're technically "separation" too: anything with zero vocal-typed
output (e.g. DrumSep — kick/snare/cymbals/…, no vocals stem at all) and
anything with zero non-vocal output (e.g. MVSep Male/Female separation —
splits the vocal itself into male_vocals/female_vocals, nothing else) —
run_separation's own vocal/instrumental-file checks would reject both with
a clear error every single time, so exposing them in the picker would just
be false advertising of something guaranteed to fail.
"""
import os
import shutil
import time
from typing import Optional

import requests

MVSEP_API_BASE = "https://mvsep.com/api"

# (display label, sep_type, add_opt1 or "" if the algorithm takes none,
# premium — True for the mvsep.com-marked 🔒-only entries, which likely
# fail on a non-Premium account/token). Only sep_type=40/add_opt1=81 (BS
# Roformer) has been exercised against the real API so far; the rest are
# taken on faith from mvsep.com's own site listing/docs and should be
# spot-checked the first time each is actually used — MVSep returns a clear
# {"success": false, "data": {"message": ...}} on a bad id/unavailable
# model, so a wrong or premium-gated one fails loudly rather than silently
# misbehaving (see run_separation below).
MVSEP_CATEGORIES: list[tuple[str, list[tuple[str, str, str, bool]]]] = [
    ("Вокал / Інструментал", [
        ("BS Roformer (2025.07)", "40", "81", False),
        ("BS PolarFormer (124 bands)", "123", "163", False),
        ("MelBand Roformer (2024.10)", "48", "4", False),
        ("MDX23C (8K FFT)", "25", "7", False),
        ("SCNet", "46", "5", False),
        ("Demucs4 Vocals 2023", "27", "", False),
        ("MVSep Multichannel BS", "43", "0", False),
    ]),
    ("Мультистем (стеми сумуються в один інструментал)", [
        ("BS Roformer SW (vocals, bass, drums, guitar, piano, other)", "63", "", False),
        ("MVSep DnR v3 (speech, music, effects)", "56", "2", False),
    ]),
    ("Ансамблі (преміум)", [
        ("Ensemble (vocals, instrum)", "26", "7", True),
        ("Ensemble (vocals, instrum, bass, drums, other)", "28", "11", True),
    ]),
    ("Старі моделі", [
        ("Vit Large 23 (v2)", "33", "1", False),
        ("UVRv5 Demucs", "17", "0", False),
        ("MVSep Old Vocal Model", "19", "", False),
        ("spleeter", "0", "0", False),
    ]),
]
MVSEP_METHOD = "MVSep"

# "Speech" is DnR-style models' name for the dialogue/vocal stem — not just
# "Vocals"/"Vocal" (confirmed against MVSep DnR v3's own stem naming).
_VOCAL_TYPES = {"vocals", "vocal", "speech"}

# Confirmed live 2026-08-09: BS Roformer SW (sep_type=63) returns 7 files
# for a model whose own algorithm_description says "generates 6 stems" —
# Vocals + Bass/Drums/Guitar/Piano/Other (the advertised 6) PLUS a bonus
# "Instrum" file that MVSep has ALREADY summed together for us server-side.
# Summing every non-vocal file ourselves (see run_separation) would double
# every instrument's volume in a case like this — once via its own stem,
# once again via Instrum. Whenever one of these aggregate-typed files shows
# up, it's used directly as instrumental_path instead of re-summing.
_INSTRUMENTAL_AGGREGATE_TYPES = {"instrumental", "accompaniment", "instrum"}


class MVSepError(Exception):
    pass


def _base() -> str:
    from . import discovery_service
    base = discovery_service.get_https_base()
    if not base:
        raise MVSepError("Онлайн-синхронізація вимкнена або недоступна")
    return base


def get_config() -> dict:
    """Full config INCLUDING api_token — internal use only (making the
    actual MVSep call). routers/teams.py's own GET /teams/mvsep-config
    strips the token before this ever reaches the frontend."""
    resp = requests.get(f"{_base()}/mvsep-config", timeout=15)
    resp.raise_for_status()
    return resp.json()


def _download(url: str, dest_path: str) -> None:
    with requests.get(url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)


def _sum_stems(paths: list[str], output_path: str) -> None:
    """Reconstitutes a full instrumental from N complementary non-vocal
    stems (e.g. bass+drums+guitar+piano+other, or music+effects) by SUMMING
    them — not averaging (separator_service._average_stems' job, for
    several competing GUESSES at the same thing in Ensemble Mode). These are
    disjoint slices of one original mix, so adding them back together is
    what reconstructs it; averaging would just make it quieter per stem
    added."""
    import numpy as np
    import soundfile as sf

    arrays = []
    sr = None
    for p in paths:
        data, s = sf.read(p, dtype="float32", always_2d=True)
        arrays.append(data)
        sr = s
    min_len = min(a.shape[0] for a in arrays)
    arrays = [a[:min_len] for a in arrays]
    summed = np.sum(np.stack(arrays, axis=0), axis=0)
    sf.write(output_path, summed, sr, subtype="PCM_24")


def _create_and_wait(audio_path: str, sep_type: str, add_opt1: str, progress, deadline_minutes: int = 20) -> list[dict]:
    """Shared upload+poll core behind both run_separation (vocal+instrumental)
    and run_male_female_split below — returns MVSep's raw `files` list
    ([{"type": ..., "url": ...}, ...]) so each caller can apply its own
    "which type means what" logic without duplicating the create/poll loop.
    add_opt1 may be "" for the handful of algorithms that take no extra
    option — omitted from the request entirely rather than sent as an empty
    value, since MVSep's own default-picking for those is undocumented and
    an empty string is more likely to be rejected outright than left off."""
    config = get_config()
    if not config.get("enabled"):
        raise MVSepError("MVSep вимкнено адміном програми")
    api_token = config.get("api_token")
    if not api_token:
        raise MVSepError("MVSep ще не налаштовано — адмін не вказав API-токен")

    progress(5, "Завантажую аудіо на MVSep…")
    data = {"api_token": api_token, "sep_type": sep_type, "output_format": "1"}
    if add_opt1:
        data["add_opt1"] = add_opt1
    with open(audio_path, "rb") as f:
        resp = requests.post(
            f"{MVSEP_API_BASE}/separation/create",
            data=data,
            files={"audiofile": (os.path.basename(audio_path), f)},
            timeout=120,
        )
    resp.raise_for_status()
    body = resp.json()
    if not body.get("success"):
        raise MVSepError(body.get("data", {}).get("message", "MVSep відхилив запит"))
    job_hash = body["data"]["hash"]

    progress(15, "Обробка на MVSep…")
    deadline = time.monotonic() + deadline_minutes * 60  # generous — a queued free-tier job can wait behind others
    while time.monotonic() < deadline:
        time.sleep(5)
        poll = requests.get(f"{MVSEP_API_BASE}/separation/get", params={"hash": job_hash}, timeout=30)
        poll.raise_for_status()
        result = poll.json()
        status = result.get("status")
        if status == "failed":
            raise MVSepError(result.get("data", {}).get("message", "MVSep не зміг обробити файл"))
        if status == "done":
            return result["data"]["files"]
        # "waiting" / "processing" — keep polling, surfacing MVSep's own
        # queue-position message when it has one so a long free-tier queue
        # doesn't look like a hang.
        msg = result.get("data", {}).get("message") or "Обробка на MVSep…"
        progress(15, msg)

    raise MVSepError("MVSep не відповів за відведений час")


def run_separation(audio_path: str, sep_type: str, add_opt1: str, output_dir: str, on_progress=None) -> dict:
    """Uploads audio_path to MVSep, polls until done, downloads the vocal +
    instrumental stems into output_dir. Returns {"vocal_path": ...,
    "instrumental_path": ..., "extra_stems": {...}}. extra_stems is empty
    for a normal 2-stem model; for a multistem one (e.g. "BS Roformer SW
    (vocals, bass, drums, guitar, piano, other)") it holds every individual
    non-vocal stem MVSep returned (bass/drums/guitar/piano/other — each kept
    as its own file, not just folded into instrumental_path's sum), keyed
    by MVSep's own stem-type name — the user wants every track MVSep hands
    back downloadable, not only the combined instrumental.
    Raises MVSepError with MVSep's own message on any failure — never
    silently falls back to something else, since a "credit" job failing
    should be visible, not quietly masked by a free local model.
    on_progress, if given, is called as (percent, message) — same
    convention as separate_file's own."""
    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    files = _create_and_wait(audio_path, sep_type, add_opt1, progress)
    vocal_files = [f for f in files if str(f.get("type", "")).strip().lower() in _VOCAL_TYPES]
    instrumental_files = [f for f in files if str(f.get("type", "")).strip().lower() not in _VOCAL_TYPES]
    # Exactly one vocal-typed stem and at least one non-vocal stem — a model
    # with zero vocal output (e.g. a pure drum separator) or zero non-vocal
    # output (e.g. Male/Female separation, which only ever returns
    # vocal-typed stems) fails right here with a clear message instead of
    # silently producing a nonsense file.
    if len(vocal_files) != 1 or not instrumental_files:
        raise MVSepError(f"MVSep повернув доріжки, непридатні для вокал+інструментал: {[f.get('type') for f in files]}")
    progress(70, "Завантажую результат…")
    os.makedirs(output_dir, exist_ok=True)
    vocal_path = os.path.join(output_dir, "mvsep_vocals.wav")
    _download(vocal_files[0]["url"], vocal_path)

    instrumental_path = os.path.join(output_dir, "mvsep_instrumental.wav")
    extra_stems: dict[str, str] = {}
    aggregate_files = [f for f in instrumental_files if str(f.get("type", "")).strip().lower() in _INSTRUMENTAL_AGGREGATE_TYPES]
    individual_files = [f for f in instrumental_files if f not in aggregate_files]

    # Every individual (non-aggregate) non-vocal stem is downloaded and KEPT
    # as its own file — the user wants every track MVSep hands back
    # downloadable, not only the combined instrumental.
    individual_paths = []
    total_downloads = len(individual_files) + (1 if aggregate_files or len(individual_files) != 1 else 0)
    done = 0
    for f in individual_files:
        stem_type = str(f.get("type") or "stem").strip().lower().replace(" ", "_")
        part_path = os.path.join(output_dir, f"mvsep_{stem_type}.wav")
        _download(f["url"], part_path)
        individual_paths.append(part_path)
        extra_stems[stem_type] = part_path
        done += 1
        progress(70 + int(done / max(total_downloads, 1) * 20), "Завантажую результат…")

    if aggregate_files:
        # MVSep already computed the full instrumental for us (e.g. BS
        # Roformer SW's bonus "Instrum" file alongside its individual
        # bass/drums/guitar/piano/other) — use it directly. Summing the
        # individual stems ourselves ON TOP of this would double-count
        # every one of them.
        progress(90, "Завантажую результат…")
        _download(aggregate_files[0]["url"], instrumental_path)
    elif len(individual_files) == 1:
        # Already downloaded above — it just also serves as THE
        # instrumental (the common 2-stem case, e.g. BS Roformer's Vocals+Other).
        shutil.copy2(individual_paths[0], instrumental_path)
    else:
        # No ready-made aggregate and more than one individual stem (e.g.
        # DnR-style speech+music+effects with no bonus combined file) — sum
        # them back together ourselves (see _sum_stems).
        _sum_stems(individual_paths, instrumental_path)

    progress(100, "Готово")
    return {"vocal_path": vocal_path, "instrumental_path": instrumental_path, "extra_stems": extra_stems}


# Male/Female separation splits an already-isolated vocal into male_vocals/
# female_vocals — no instrumental output at all, so it deliberately never
# goes through run_separation's vocal+instrumental logic above. sep_type=57,
# add_opt1=2 (MelRoformer, mvsep.com's own default); add_opt2 (0: "Extract
# directly" vs 1: "Extract vocals first") is left at its default of 0
# because the input here is ALREADY a clean isolated vocal (see
# run_mvsep_male_female_split in separator_service.py, which requires
# Episode.vocal_only_stem_path to already exist before this ever runs) —
# asking MVSep to extract vocals again would be redundant.
MALE_FEMALE_SEP_TYPE = "57"
MALE_FEMALE_ADD_OPT1 = "2"


def run_male_female_split(vocal_audio_path: str, output_dir: str, on_progress=None) -> dict:
    """Second stage of the "isolate vocal, then split by gender" chain —
    takes an ALREADY-isolated vocal file (not the original mixed audio) and
    returns {"<type>": path, ...} for every stem MVSep hands back (expected:
    two, but downloading by whatever "type" string actually comes back
    rather than hardcoding "male"/"female" — that exact wording isn't
    confirmed live, unlike run_separation's "Vocals"/"Other")."""
    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    files = _create_and_wait(vocal_audio_path, MALE_FEMALE_SEP_TYPE, MALE_FEMALE_ADD_OPT1, progress)
    if len(files) < 2:
        raise MVSepError(f"MVSep повернув недостатньо доріжок для розділення за статтю: {[f.get('type') for f in files]}")
    progress(70, "Завантажую результат…")
    os.makedirs(output_dir, exist_ok=True)
    result: dict[str, str] = {}
    for i, f in enumerate(files):
        stem_type = str(f.get("type") or f"stem_{i}").strip().lower().replace(" ", "_")
        path = os.path.join(output_dir, f"mvsep_{stem_type}.wav")
        _download(f["url"], path)
        result[stem_type] = path
        progress(70 + int((i + 1) / len(files) * 25), "Завантажую результат…")
    progress(100, "Готово")
    return result


def get_public_categories() -> list[dict]:
    """MVSEP_CATEGORIES reshaped for the frontend — no secrets in here (just
    labels/ids/premium flags), unlike get_config()."""
    return [
        {
            "category": category,
            "models": [
                {"label": label, "sepType": sep_type, "addOpt1": add_opt1, "premium": premium}
                for label, sep_type, add_opt1, premium in models
            ],
        }
        for category, models in MVSEP_CATEGORIES
    ]


def get_balance() -> dict:
    """Studio-wide MVSep credit balance — confirmed live 2026-08-09 against
    GET /api/app/user, which (unlike every other MVSep endpoint used here)
    echoes the api_token back in its own response body, so this must NEVER
    forward the raw response — only the one field the UI actually needs."""
    config = get_config()
    api_token = config.get("api_token")
    if not api_token:
        raise MVSepError("MVSep ще не налаштовано — адмін не вказав API-токен")
    resp = requests.get(f"{MVSEP_API_BASE}/app/user", params={"api_token": api_token}, timeout=15)
    resp.raise_for_status()
    body = resp.json()
    if not body.get("success"):
        raise MVSepError(body.get("message", "Не вдалося отримати баланс MVSep"))
    data = body.get("data", {})
    return {"premium_minutes": data.get("premium_minutes"), "premium_enabled": bool(data.get("premium_enabled"))}
