"""
In-app subtitle translation — Translator role only (see TranslatorWorkspace/
SubtitleEditBox). Two providers, picked per-click rather than one global
"active" setting, since quality/cost tradeoffs differ per line:

  - DeepL: has a first-class `context` API parameter built exactly for
    "translate this one line, but don't lose the surrounding meaning" —
    strong specifically on EN<->UK, the pair that matters for this studio.
  - GPT (OpenAI): handles slang/tone/sarcasm better via a prompt that
    includes the surrounding dialogue directly, at higher cost/latency.

Deliberately NOT the MVSep pattern (services/mvsep_service.py) — that's a
studio-wide shared token via the Cloudflare Worker's D1, because MVSep
credits are a shared studio expense. DeepL/OpenAI keys are per-install (each
studio brings its own account), so they live as plain columns on the local
AppSettings row instead (see routers/translation.py).
"""
import requests

TRANSLATE_TARGET_LANG = "UK"


class TranslationError(Exception):
    pass


def _deepl_base_url(api_key: str) -> str:
    # DeepL's own documented convention: free-tier keys always end in ":fx".
    return "https://api-free.deepl.com" if api_key.endswith(":fx") else "https://api.deepl.com"


def translate_deepl(text: str, context: str, api_key: str) -> str:
    if not text.strip():
        return text
    try:
        resp = requests.post(
            f"{_deepl_base_url(api_key)}/v2/translate",
            headers={"Authorization": f"DeepL-Auth-Key {api_key}"},
            json={
                "text": [text],
                "target_lang": TRANSLATE_TARGET_LANG,
                **({"context": context} if context.strip() else {}),
            },
            timeout=15,
        )
    except requests.RequestException as e:
        raise TranslationError(f"DeepL: не вдалося з'єднатися ({e})")
    if resp.status_code == 403:
        raise TranslationError("DeepL: невірний API-ключ")
    if not resp.ok:
        raise TranslationError(f"DeepL: помилка {resp.status_code}")
    translations = resp.json().get("translations") or []
    if not translations:
        raise TranslationError("DeepL: порожня відповідь")
    return translations[0]["text"]


_LLM_SYSTEM_PROMPT = (
    "You translate anime dubbing subtitle lines from their source language "
    "into Ukrainian. You will be given the line before, the line to "
    "translate, and the line after, for context (tone, continuity, pronouns). "
    "Translate ONLY the middle line. Never translate or repeat back the "
    "context lines. Preserve the register (casual/formal, exclamations) of "
    "the original. Reply with ONLY the translated line — no quotes, no "
    "explanation, no alternate options."
)


def translate_gpt(text: str, context_before: str, context_after: str, api_key: str) -> str:
    if not text.strip():
        return text
    user_parts = []
    if context_before.strip():
        user_parts.append(f"[Попередній рядок, НЕ перекладати]: {context_before}")
    user_parts.append(f"[Рядок для перекладу]: {text}")
    if context_after.strip():
        user_parts.append(f"[Наступний рядок, НЕ перекладати]: {context_after}")
    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": _LLM_SYSTEM_PROMPT},
                    {"role": "user", "content": "\n".join(user_parts)},
                ],
                "temperature": 0.3,
            },
            timeout=20,
        )
    except requests.RequestException as e:
        raise TranslationError(f"GPT: не вдалося з'єднатися ({e})")
    if resp.status_code == 401:
        raise TranslationError("GPT: невірний API-ключ")
    if not resp.ok:
        raise TranslationError(f"GPT: помилка {resp.status_code}")
    choices = resp.json().get("choices") or []
    if not choices:
        raise TranslationError("GPT: порожня відповідь")
    return choices[0]["message"]["content"].strip()


def translate_gemini(text: str, context_before: str, context_after: str, api_key: str) -> str:
    # 2026 translation benchmarks rank Gemini 2.5 Flash/Pro among the
    # strongest LLMs specifically for Ukrainian as a target language — this
    # studio's actual target locale, not a generic "also try this one".
    if not text.strip():
        return text
    user_parts = []
    if context_before.strip():
        user_parts.append(f"[Попередній рядок, НЕ перекладати]: {context_before}")
    user_parts.append(f"[Рядок для перекладу]: {text}")
    if context_after.strip():
        user_parts.append(f"[Наступний рядок, НЕ перекладати]: {context_after}")
    try:
        resp = requests.post(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json={
                "contents": [{"role": "user", "parts": [{"text": "\n".join(user_parts)}]}],
                "systemInstruction": {"parts": [{"text": _LLM_SYSTEM_PROMPT}]},
                "generationConfig": {"temperature": 0.3},
            },
            timeout=20,
        )
    except requests.RequestException as e:
        raise TranslationError(f"Gemini: не вдалося з'єднатися ({e})")
    if resp.status_code in (400, 403):
        raise TranslationError("Gemini: невірний API-ключ")
    if not resp.ok:
        raise TranslationError(f"Gemini: помилка {resp.status_code}")
    candidates = resp.json().get("candidates") or []
    if not candidates:
        raise TranslationError("Gemini: порожня відповідь")
    parts = candidates[0].get("content", {}).get("parts") or []
    if not parts:
        raise TranslationError("Gemini: порожня відповідь")
    return parts[0]["text"].strip()


def translate_mymemory(text: str) -> str:
    """MyMemory (mymemory.translated.net) — the only provider here needing
    NO API key at all: DeepL retired its recurring-free API tier in favor of
    a one-time trial (July 2026), and the well-known public LibreTranslate
    mirrors (translate.argosopentech.com, libretranslate.de, etc.) were
    confirmed unreachable/broken when checked live 2026-08-16 — a known
    reliability problem with community-run free instances. MyMemory has no
    `context` concept (a plain GET of one string, matched against its own
    translation-memory + a machine-translation fallback) — real quality
    tradeoff for genuinely zero cost/signup, not just a stopgap.
    Anonymous usage caps around 5000 words/day; fine for one-line-at-a-time
    use, not for a bulk/batch translate feature."""
    if not text.strip():
        return text
    try:
        resp = requests.get(
            "https://api.mymemory.translated.net/get",
            params={"q": text, "langpair": "en|uk"},
            timeout=15,
        )
    except requests.RequestException as e:
        raise TranslationError(f"MyMemory: не вдалося з'єднатися ({e})")
    if not resp.ok:
        raise TranslationError(f"MyMemory: помилка {resp.status_code}")
    data = resp.json()
    translated = data.get("responseData", {}).get("translatedText")
    if not translated:
        raise TranslationError("MyMemory: порожня відповідь")
    return translated


def translate(provider: str, text: str, context_before: str, context_after: str, api_key: "str | None") -> str:
    if provider == "deepl":
        # DeepL's context is one plain hint string, not separate before/after
        # fields — joined with a newline, which is enough for the API to use
        # as surrounding-paragraph style context per its own docs.
        context = "\n".join(p for p in (context_before, context_after) if p.strip())
        return translate_deepl(text, context, api_key)
    if provider == "gpt":
        return translate_gpt(text, context_before, context_after, api_key)
    if provider == "gemini":
        return translate_gemini(text, context_before, context_after, api_key)
    if provider == "mymemory":
        return translate_mymemory(text)
    raise TranslationError(f"Невідомий провайдер перекладу: {provider}")
