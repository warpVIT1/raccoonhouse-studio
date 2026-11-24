"""
Extra character-portrait sources besides Hikka, all keyed off the title's
MyAnimeList id (Hikka's own anime record carries it, so one link covers every
source):

- AniList (GraphQL, no key): https://graphql.anilist.co
- Jikan (MyAnimeList REST, no key): https://api.jikan.moe/v4

Every function returns the same dict shape as hikka_service.get_anime_characters
(name_ua/name_en/name_ja/synonyms/image/main/slug + "source") and NEVER raises:
a source that is down or blocked just contributes nothing, the others still work.
"""
import logging
import re
import time

import requests

from . import hikka_service

logger = logging.getLogger("rh.character_sources")

_TTL = 6 * 3600
_cache: dict[tuple[str, int | str], tuple[float, list[dict]]] = {}
_mal_cache: dict[str, int | None] = {}
# A source that failed is not retried for a while, so one blocked service
# (Jikan is unreachable from some networks) cannot slow every lookup down.
_down_until: dict[str, float] = {}
_DOWN_FOR = 600

_ANILIST_QUERY = """
query ($id: Int, $page: Int) {
  Media(idMal: $id, type: ANIME) {
    characters(page: $page, perPage: 50, sort: ROLE) {
      pageInfo { hasNextPage }
      edges { role node { id name { full native alternative } image { large } } }
    }
  }
}
"""

# Placeholder portraits sources serve when a character has no picture.
_PLACEHOLDER_RE = re.compile(r"(default\.|questionmark|/images/na\.|noimage)", re.IGNORECASE)


def _cached(source: str, key):
    hit = _cache.get((source, key))
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    return None


def _store(source: str, key, value: list[dict]) -> list[dict]:
    _cache[(source, key)] = (time.time(), value)
    return value


def get_mal_id(hikka_slug: str) -> int | None:
    """MyAnimeList id of a Hikka anime (None if Hikka doesn't know one)."""
    if hikka_slug in _mal_cache:
        return _mal_cache[hikka_slug]
    try:
        resp = requests.get(f"{hikka_service.HIKKA_BASE}/anime/{hikka_slug}", timeout=10)
        resp.raise_for_status()
        mal_id = resp.json().get("mal_id")
        mal_id = int(mal_id) if mal_id else None
    except Exception:
        logger.warning("get_mal_id failed for %s", hikka_slug, exc_info=True)
        return None  # not cached: a transient failure shouldn't stick
    _mal_cache[hikka_slug] = mal_id
    return mal_id


def fetch_anilist(mal_id: int) -> list[dict]:
    cached = _cached("anilist", mal_id)
    if cached is not None:
        return cached
    if time.time() < _down_until.get("anilist", 0):
        return []
    out: list[dict] = []
    try:
        page = 1
        while page <= 8:
            resp = requests.post(
                "https://graphql.anilist.co",
                json={"query": _ANILIST_QUERY, "variables": {"id": mal_id, "page": page}},
                timeout=(4, 12),
            )
            resp.raise_for_status()
            media = (resp.json().get("data") or {}).get("Media") or {}
            block = media.get("characters") or {}
            for edge in block.get("edges") or []:
                node = edge.get("node") or {}
                name = node.get("name") or {}
                image = (node.get("image") or {}).get("large")
                if not image or _PLACEHOLDER_RE.search(image):
                    continue
                out.append({
                    "slug": f"anilist-{node.get('id')}",
                    "name_ua": None,
                    "name_en": name.get("full"),
                    "name_ja": name.get("native"),
                    "synonyms": [n for n in (name.get("alternative") or []) if n],
                    "image": image,
                    "main": edge.get("role") == "MAIN",
                    "source": "anilist",
                })
            if not (block.get("pageInfo") or {}).get("hasNextPage"):
                break
            page += 1
    except Exception:
        logger.warning("fetch_anilist failed for mal_id=%s (skipping this source for %ss)", mal_id, _DOWN_FOR)
        _down_until["anilist"] = time.time() + _DOWN_FOR
        return out  # whatever was read before the failure; not cached
    return _store("anilist", mal_id, out)


def _jikan_name_variants(name: str) -> list[str]:
    # MyAnimeList writes people as "Last, First" — also offer "First Last".
    if "," in name:
        last, _, first = name.partition(",")
        return [f"{first.strip()} {last.strip()}".strip()]
    return []


def fetch_jikan(mal_id: int) -> list[dict]:
    cached = _cached("jikan", mal_id)
    if cached is not None:
        return cached
    if time.time() < _down_until.get("jikan", 0):
        return []
    out: list[dict] = []
    try:
        resp = requests.get(f"https://api.jikan.moe/v4/anime/{mal_id}/characters", timeout=(4, 10))
        resp.raise_for_status()
        for entry in resp.json().get("data") or []:
            ch = entry.get("character") or {}
            name = (ch.get("name") or "").strip()
            image = ((ch.get("images") or {}).get("jpg") or {}).get("image_url")
            if not name or not image or _PLACEHOLDER_RE.search(image):
                continue
            variants = _jikan_name_variants(name)
            out.append({
                "slug": f"jikan-{ch.get('mal_id')}",
                "name_ua": None,
                "name_en": variants[0] if variants else name,
                "name_ja": None,
                "synonyms": [name] if variants else [],
                "image": image,
                "main": (entry.get("role") or "").lower() == "main",
                "source": "jikan",
            })
    except Exception:
        logger.warning("fetch_jikan failed for mal_id=%s (skipping this source for %ss)", mal_id, _DOWN_FOR)
        _down_until["jikan"] = time.time() + _DOWN_FOR
        return []
    return _store("jikan", mal_id, out)
