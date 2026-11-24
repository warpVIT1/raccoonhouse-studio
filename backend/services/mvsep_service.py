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
docs) has 120+ active algorithms, but most of them (single instrument
isolators — tuba, banjo, clarinet…; TTS/voice cloning; song generation;
MIDI transcription; audio upscaling) are a different job entirely from
"isolate vocal from instrumental for dubbing": some don't even take an
audio file as input, others return stems that have nothing to do with
vocals/instrumental. Rather than hand-maintaining a static allowlist that
silently goes stale whenever mvsep.com adds/removes/reprices something,
get_public_categories() below builds the picker LIVE from mvsep.com's own
public GET /api/app/algorithms (see _get_cached_algorithms), filtered down
to algorithms that can produce a genuine vocal + full-instrumental pair —
see run_separation's "sum every non-vocal stem" approach, which is what
makes multistem entries like BS Roformer SW or MVSep DnR v3 (3+ stems, no
single file literally typed "Instrumental") work correctly rather than
quietly shipping an instrumental that's missing its drums/bass/effects.
Two shapes are filtered out because run_separation's own vocal/
instrumental-file checks would reject them with a clear error every single
time, so exposing them in the picker would just be false advertising of
something guaranteed to fail: zero vocal-typed output (e.g. DrumSep —
kick/snare/cymbals/…, no vocals stem at all) and multiple vocal-typed
outputs with no single unambiguous one (e.g. MVSep Karaoke, which splits
into lead+backing vocals — both stems match the vocal-type check, so
run_separation's "exactly one vocal file" guard would reject it too). See
_produces_exactly_one_vocal_stem for the exact rule. MVSep Male/Female
separation (zero non-vocal output — splits the vocal itself into male/
female) is excluded the same way since mvsep.com's own catalog carries no
output_stems metadata for it at all, which this filter already treats as
"can't confirm this shape, leave it out" — see get_male_female_models for
its own dedicated (also live) picker.
"""
import json
import os
import shutil
import time
from typing import Optional

import requests

MVSEP_API_BASE = "https://mvsep.com/api"

# In-memory cache for mvsep.com's own public GET /api/app/algorithms — the
# single source of truth get_public_categories() and get_male_female_models()
# both build their live, auto-updating pickers from, so a model mvsep.com
# adds/removes/reprices shows up here without an app update. Cached rather
# than fetched on every modal open (avoids a network round trip in the hot
# path and keeps the picker working during a brief mvsep.com outage) but
# still bounded so a real catalog change reaches users within hours, not
# only at the next release.
_ALGORITHMS_CACHE_TTL_SECONDS = 6 * 3600
_algorithms_cache: dict = {"data": None, "fetched_at": 0.0}


def _get_cached_algorithms() -> list[dict]:
    now = time.monotonic()
    if _algorithms_cache["data"] is not None and now - _algorithms_cache["fetched_at"] < _ALGORITHMS_CACHE_TTL_SECONDS:
        return _algorithms_cache["data"]
    try:
        resp = requests.get(f"{MVSEP_API_BASE}/app/algorithms", timeout=20)
        resp.raise_for_status()
        data = resp.json()
        _algorithms_cache["data"] = data
        _algorithms_cache["fetched_at"] = now
        return data
    except Exception:
        # Best-effort — keep serving the last good fetch (even stale) rather
        # than breaking the picker over a transient mvsep.com hiccup; only
        # truly empty if this is the very first call and it failed.
        return _algorithms_cache["data"] or []


def _stem_list(algorithm: dict) -> list[str]:
    """output_stems comes back as a JSON-encoded STRING inside the JSON
    response (confirmed live 2026-09-16), not a real array — decode it, or
    treat missing/malformed metadata as "no stems known" rather than
    guessing, since a wrong guess here is what would surface a
    guaranteed-to-fail model in the picker (see module docstring)."""
    raw = algorithm.get("output_stems")
    if not isinstance(raw, str):
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _produces_exactly_one_vocal_stem(stems: list[str]) -> bool:
    vocal_matches = [s for s in stems if s == "speech" or s.startswith("vocals")]
    return len(vocal_matches) == 1 and len(stems) > len(vocal_matches)


def _default_add_opt1(algorithm: dict) -> str:
    for f in algorithm.get("algorithm_fields") or []:
        if f.get("name") == "add_opt1":
            return str(f.get("default_key") or "")
    return ""


# mvsep.com's catalog carries no explicit premium/registered-only flag on
# the algorithm object itself (confirmed live 2026-09-16 — every Ensembles-
# group entry observed is premium-locked on the site, nothing else is), so
# this is a heuristic, not ground truth. Worst case a wrongly-unmarked
# premium model fails loudly with MVSep's own error on /separation/create
# (see run_separation) rather than silently misbehaving.
_PREMIUM_GROUPS = {"Ensembles"}

# spleeter (render_id=0) predates mvsep.com's own output_stems metadata —
# confirmed live 2026-09-16 it returns output_stems=None despite genuinely
# working (vocals + accompaniment), so the live filter above can't confirm
# its shape and would otherwise drop it. Kept as a single manually-verified
# exception rather than trusting metadata mvsep.com itself doesn't have.
_LEGACY_RENDER_IDS_WITHOUT_STEM_METADATA = {0}


def get_public_categories() -> list[dict]:
    """Live, auto-updating model picker — every active mvsep.com algorithm
    that can produce a genuine vocal + instrumental pair (see module
    docstring), grouped by mvsep.com's own algorithm_group. No secrets in
    here (just labels/ids/premium flags/price coefficients)."""
    models_by_group: dict[str, list[dict]] = {}
    for a in _get_cached_algorithms():
        if not a.get("is_active") or a.get("render_id") is None:
            continue
        stems = _stem_list(a)
        if not _produces_exactly_one_vocal_stem(stems) and a["render_id"] not in _LEGACY_RENDER_IDS_WITHOUT_STEM_METADATA:
            continue
        group_name = ((a.get("algorithm_group") or {}).get("name")) or "Інше"
        models_by_group.setdefault(group_name, []).append({
            "label": a["name"],
            "sepType": str(a["render_id"]),
            "addOpt1": _default_add_opt1(a),
            "premium": group_name in _PREMIUM_GROUPS,
            "priceCoefficient": a.get("price_coefficient", 1),
        })
    return [{"category": group, "models": models} for group, models in models_by_group.items()]


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
# goes through run_separation's vocal+instrumental logic above. sep_type=57;
# add_opt2 (0: "Extract directly" vs 1: "Extract vocals first") is left at
# its default of 0 because the input here is ALREADY a clean isolated vocal
# (see run_mvsep_male_female_split in separator_service.py, which requires
# Episode.vocal_only_stem_path to already exist before this ever runs) —
# asking MVSep to extract vocals again would be redundant, so only add_opt1
# (which underlying model) is exposed as a choice.
MALE_FEMALE_SEP_TYPE = "57"
MALE_FEMALE_ADD_OPT1 = "2"  # MelRoformer (2025.01) — kept as the default choice below

# Fallback only — used when the live catalog (get_male_female_models below)
# is unreachable or mvsep.com restructures this algorithm's fields. Last
# confirmed live 2026-09-16 against the live form's rendered <select> (SDR
# figures are mvsep.com's own). Order matches the live dropdown at that time.
MALE_FEMALE_MODELS = [
    ("BSRoformer by Sucial (SDR: 6.52)", "0"),
    ("BSRoformer by aufr33 (SDR: 8.18)", "3"),
    ("SCNet XL (SDR: 11.83)", "1"),
    ("MelRoformer (2025.01) (SDR: 13.03)", "2"),
]
# Same price_coefficient for all four — confirmed 2026-09-16 against
# GET /api/app/algorithms (render_id=57): no per-option price_rules on this
# algorithm's add_opt1 field, unlike some others (e.g. BS Roformer's overlap
# option).
MALE_FEMALE_PRICE_COEFFICIENT = 1


def get_male_female_models() -> list[dict]:
    """Live, auto-updating add_opt1 choices for MVSep Male/Female separation
    (render_id=57) — same cached catalog as get_public_categories(), scoped
    to this one algorithm's own model_type options, so a model mvsep.com
    adds/removes there shows up here too without an app update. Falls back
    to MALE_FEMALE_MODELS if the live catalog can't be read."""
    for a in _get_cached_algorithms():
        if a.get("render_id") != int(MALE_FEMALE_SEP_TYPE):
            continue
        for f in a.get("algorithm_fields") or []:
            if f.get("name") != "add_opt1":
                continue
            options = f.get("options")
            if isinstance(options, str):
                try:
                    options = json.loads(options)
                except (TypeError, ValueError):
                    options = None
            if isinstance(options, dict) and options:
                coefficient = a.get("price_coefficient", MALE_FEMALE_PRICE_COEFFICIENT)
                return [
                    {"label": label, "addOpt1": key, "priceCoefficient": coefficient}
                    for key, label in options.items()
                ]
    return [
        {"label": label, "addOpt1": add_opt1, "priceCoefficient": MALE_FEMALE_PRICE_COEFFICIENT}
        for label, add_opt1 in MALE_FEMALE_MODELS
    ]


def run_male_female_split(vocal_audio_path: str, output_dir: str, add_opt1: "str | None" = None, on_progress=None) -> dict:
    """Second stage of the "isolate vocal, then split by gender" chain —
    takes an ALREADY-isolated vocal file (not the original mixed audio) and
    returns {"<type>": path, ...} for every stem MVSep hands back (expected:
    two, but downloading by whatever "type" string actually comes back
    rather than hardcoding "male"/"female" — that exact wording isn't
    confirmed live, unlike run_separation's "Vocals"/"Other").

    `add_opt1` picks which underlying model (see get_male_female_models) —
    defaults to MALE_FEMALE_ADD_OPT1 (MelRoformer) when not given, same
    choice this always made before model selection existed. Not pre-
    validated against the live list here — MVSep itself rejects a bad
    add_opt1 with a clear error on /separation/create, and re-checking
    against a cache that might be stale would only risk a false rejection."""
    if add_opt1 is None:
        add_opt1 = MALE_FEMALE_ADD_OPT1

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    files = _create_and_wait(vocal_audio_path, MALE_FEMALE_SEP_TYPE, add_opt1, progress)
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
