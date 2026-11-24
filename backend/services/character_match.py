"""
Matching local Character names (typed by hand or taken from ASS styles) to
Hikka's character catalog entries.

Local names are usually Ukrainian ("Фрірен") but may be Latin ("Frieren"),
upper-case, or carry suffixes like "(дитинство)". Hikka entries carry
name_ua / name_en / name_ja plus synonyms. Everything is compared after
normalisation and Cyrillic->Latin transliteration so "Фрірен" == "Frieren".

Only an UNAMBIGUOUS, near-exact match is ever applied automatically — the rest
are returned as ranked candidates for a human to confirm.
"""
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Optional

AUTO_MIN_SCORE = 0.93   # best candidate must be this close to a name variant
AUTO_MIN_GAP = 0.12     # ...and this far ahead of the runner-up
CANDIDATE_MIN_SCORE = 0.5
MAX_CANDIDATES = 3

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "h", "ґ": "g", "д": "d", "е": "e", "є": "ye",
    "ж": "zh", "з": "z", "и": "y", "і": "i", "ї": "yi", "й": "y", "к": "k", "л": "l",
    "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ь": "",
    "ю": "yu", "я": "ya", "ъ": "", "ы": "y", "э": "e", "ё": "e",
}
# Spelling variants that differ only by convention, folded after translit.
_FOLD = [("kh", "h"), ("ph", "f"), ("ck", "k"), ("c", "k"), ("w", "v"), ("x", "ks"),
         ("y", "i"), ("j", "i"), ("ou", "u"), ("oo", "u"), ("ee", "i"), ("ii", "i")]


def _strip_decor(name: str) -> str:
    # "Фрірен (дитинство)" / "Fern [main]" -> core name; the decoration is
    # dropped only for the secondary comparison, never the primary one.
    return re.sub(r"[\(\[\{].*?[\)\]\}]", " ", name)


def _norm(name: str) -> str:
    name = unicodedata.normalize("NFKC", name).lower()
    name = re.sub(r"[_\-\.]+", " ", name)
    name = re.sub(r"[^\w\s]", " ", name, flags=re.UNICODE)
    return re.sub(r"\s+", " ", name).strip()


def _translit(name: str) -> str:
    out = "".join(_TRANSLIT.get(ch, ch) for ch in name)
    for a, b in _FOLD:
        out = out.replace(a, b)
    # collapse doubled letters ("fren" vs "frenn")
    return re.sub(r"(.)\1+", r"\1", out)


def _variants(*names: Optional[str]) -> list[str]:
    seen, out = set(), []
    for n in names:
        if not n:
            continue
        for candidate in (n, _strip_decor(n)):
            norm = _norm(candidate)
            if norm and norm not in seen:
                seen.add(norm)
                out.append(norm)
    return out


def _score_pair(local: str, remote: str) -> float:
    if local == remote:
        return 1.0
    lt, rt = _translit(local), _translit(remote)
    if lt == rt:
        return 0.97
    ltoks, rtoks = lt.split(), rt.split()
    if ltoks and rtoks:
        # "Фрірен" vs "Frieren Glitit": every local token is a full token of
        # the remote name (or vice versa) -> a given-name/family-name hit.
        if set(ltoks) <= set(rtoks) or set(rtoks) <= set(ltoks):
            return 0.88 if min(len(ltoks), len(rtoks)) == 1 else 0.92
        # same tokens in a different order ("Frieren Glitit" / "Glitit Frieren")
        if sorted(ltoks) == sorted(rtoks):
            return 0.95
    ratio = SequenceMatcher(None, lt, rt).ratio()
    # Fuzzy ratio never reaches the auto threshold on its own.
    return min(ratio, 0.86)


def score_character(local_name: str, remote: dict) -> float:
    locals_ = _variants(local_name)
    remotes = _variants(
        remote.get("name_ua"), remote.get("name_en"), remote.get("name_ja"),
        *(remote.get("synonyms") or []),
    )
    best = 0.0
    for lv in locals_:
        for rv in remotes:
            best = max(best, _score_pair(lv, rv))
    return best


def rank_candidates(local_name: str, remote_chars: list[dict]) -> dict:
    """Returns {"candidates": [...top matches with score...], "auto": candidate|None}."""
    scored = []
    for rc in remote_chars:
        if not rc.get("image"):
            continue  # nothing to show for this entry
        s = score_character(local_name, rc)
        if s >= CANDIDATE_MIN_SCORE:
            scored.append({
                "slug": rc.get("slug"),
                "name_ua": rc.get("name_ua"),
                "name_en": rc.get("name_en"),
                "name_ja": rc.get("name_ja"),
                "image": rc.get("image"),
                "main": bool(rc.get("main")),
                "source": rc.get("source") or "hikka",
                "score": round(s, 3),
            })
    scored.sort(key=lambda c: (c["score"], c["main"]), reverse=True)
    top = scored[:MAX_CANDIDATES]
    auto = None
    if top and top[0]["score"] >= AUTO_MIN_SCORE:
        runner_up = top[1]["score"] if len(top) > 1 else 0.0
        if top[0]["score"] - runner_up >= AUTO_MIN_GAP:
            auto = top[0]
    return {"candidates": top, "auto": auto}


SOURCE_PRIORITY = ("hikka", "anilist", "jikan")
MAX_MERGED_CANDIDATES = 6


def rank_multi(local_name: str, by_source: dict) -> dict:
    """Ranks one local name against several sources at once.

    Auto-apply uses the FIRST source (in SOURCE_PRIORITY order) that is itself
    unambiguous: the same character appearing in two sources must not count as
    a tie. Candidates shown to the director are merged from every source,
    best score first (ties broken by source priority), de-duplicated by image,
    each tagged with where it came from.
    """
    auto = None
    merged: list[dict] = []
    for source in SOURCE_PRIORITY:
        remote = by_source.get(source)
        if not remote:
            continue
        ranked = rank_candidates(local_name, remote)
        if auto is None and ranked["auto"]:
            auto = ranked["auto"]
        merged.extend(ranked["candidates"])
    order = {name: i for i, name in enumerate(SOURCE_PRIORITY)}
    merged.sort(key=lambda c: (-c["score"], order.get(c["source"], 99), not c["main"]))
    seen: set[str] = set()
    top: list[dict] = []
    for c in merged:
        if c["image"] in seen:
            continue
        seen.add(c["image"])
        top.append(c)
        if len(top) >= MAX_MERGED_CANDIDATES:
            break
    return {"candidates": top, "auto": auto}
