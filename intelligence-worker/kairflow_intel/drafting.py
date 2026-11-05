"""Email drafting. The studio's facts come ONLY from approved knowledge-base entries, copied word for word. The model may
write one short personal opening sentence from verified evidence; if it is invalid we use a plain deterministic one."""
from __future__ import annotations

import re

from . import policy
from .errors import PermanentError
from .safety import norm

HOOK_SCHEMA = {"type": "object", "required": ["sentence"], "properties": {"sentence": {"type": "string", "maxLength": 240}}}
TYPE_KEY = {"indie_game_developer": "services.indie_game_developer", "animation_studio_support": "services.animation_studio_support"}
SUBJECT = {"indie_game_developer": "2D animation for {name}", "animation_studio_support": "Animation production support for {name}"}
REQUIRED = ("studio.about", "portfolio.main")


def kb_map(kb: list[dict]) -> dict[str, dict]:
    return {e["key"]: e for e in kb or []}


def require_kb(kb: dict, ptype: str) -> None:
    need = [*REQUIRED, TYPE_KEY[ptype]]
    missing = [k for k in need if not (kb.get(k) and kb[k]["body"].strip())]
    if missing:
        raise PermanentError(f"approved knowledge base is missing: {', '.join(missing)}")


def greeting(prospect: dict) -> str:
    n = (prospect.get("contact_name") or "").strip()
    first = n.split()[0] if n else ""
    return f"Hello {first}," if first and re.fullmatch(r"[\w'\-\.]{2,30}", first, re.U) else "Hello,"


def plain_hook(prospect: dict, evidence: list[dict]) -> str:
    ev = next((e for e in evidence if e.get("verified") and e.get("snippet")), None)
    if not ev:
        return f"I came across {prospect['name']} and wanted to introduce our studio."
    snip = re.sub(r"\s+", " ", ev["snippet"]).strip()
    snip = snip[:140].rsplit(" ", 1)[0] if len(snip) > 140 else snip
    return f"I came across {prospect['name']} and noticed this on your page: \"{snip}\""


def model_hook(prospect: dict, evidence: list[dict], llm) -> str | None:
    """Ask the local model for one sentence grounded in a verified snippet. Accept it only if it passes every check."""
    ev = [e for e in evidence if e.get("verified") and e.get("snippet")][:3]
    if not ev or llm is None:
        return None
    try:
        s = llm(prospect["name"], "\n".join(f"- {e['snippet'][:200]}" for e in ev))["sentence"].strip()
    except Exception:
        return None
    text = norm(" ".join(e["snippet"] for e in ev))
    words = [w for w in re.findall(r"[a-z]{5,}", norm(s)) if w not in {"studio", "game", "games", "animation", "looking", "would", "about", "while", "which"}]
    grounded = sum(1 for w in words if w in text)
    if not (30 <= len(s) <= 220) or "\n" in s or policy.URL.search(s) or re.search(r"\d", s) or policy.PRICE_IN_DRAFT.search(s) or policy.FALSE_CLAIMS.search(s):
        return None
    if not words or grounded / len(words) < 0.5:
        return None
    return s


def is_japanese_prospect(prospect: dict) -> bool:
    """Japanese outreach is selected from researched language or an explicit Japan country."""
    language = str(prospect.get("language") or "").strip().lower()
    country = str(prospect.get("country") or "").strip().lower()
    return language in {"ja", "japanese"} or country in {"japan", "日本", "jp"}


def _short_excerpt(value: str, limit: int = 150) -> str:
    """Keep one complete approved sentence; never splice or invent studio claims."""
    text = re.sub(r"\s+", " ", (value or "")).strip()
    if not text:
        return ""
    match = re.search(r"^.{1,}?([.!?](?:\s|$))", text)
    sentence = text[:match.end(1)].strip() if match else text
    if len(sentence) <= limit:
        return sentence
    clipped = sentence[:limit].rsplit(" ", 1)[0].rstrip(" ,;:")
    return clipped + "…"


def _portfolio_url(kb: dict) -> str:
    urls = policy.URL.findall(kb["portfolio.main"]["body"])
    return urls[0].rstrip(".,)") if urls else ""


def build_initial(prospect: dict, evidence: list[dict], kb: dict, settings: dict, llm=None) -> dict:
    ptype = prospect["type"]
    require_kb(kb, ptype)
    name = prospect["name"]
    portfolio = _portfolio_url(kb)
    if is_japanese_prospect(prospect):
        # Japanese business inquiry: concise, natural, and not a literal English translation.
        subject = f"アニメーション制作協力のご提案｜{name}"
        body = (f"突然のご連絡失礼いたします。Studio Kairegiと申します。貴社のアニメーション制作において、"
                f"レイアウト・原画・動画などの制作協力ができればと思い、ご連絡いたしました。"
                f"制作実績はこちらです：<{portfolio}>。外部スタッフをお探しの際は、ぜひお気軽にご相談ください。")
    else:
        about = _short_excerpt(kb["studio.about"]["body"], 120)
        service_source = kb[TYPE_KEY[ptype]]["body"]
        # Never hide a policy violation by clipping a risky approved KB entry; let the
        # final outbound validator block it for administrator review.
        service = service_source if policy.PRICE_IN_DRAFT.search(service_source) else _short_excerpt(service_source, 150)
        hook = model_hook(prospect, evidence, llm) or plain_hook(prospect, evidence)
        body = " ".join(part for part in (greeting(prospect), hook, about, service, f"Portfolio: {portfolio}. Let me know if you may need animation support.") if part)
        subject = SUBJECT[ptype].format(name=name)[:120]
    body += policy.compliance_footer(settings)
    return {"subject": subject[:120], "body": body}


MAX_STEP = 3


def next_step(prospect: dict, lead: dict | None, previous_followups: int) -> int:
    """Which email slot (1..3) this follow-up fills. Adopted CRM leads may already have manual follow-ups: use the first unsent slot."""
    if prospect.get("origin") == "crm_existing":
        flags = list((lead or {}).get("sent_flags") or [])
        for i in range(1, MAX_STEP + 1):
            if i >= len(flags) or not flags[i]:
                return i
        raise PermanentError("every follow-up slot on this lead was already used")
    step = 1 + previous_followups
    if step > MAX_STEP:
        raise PermanentError("follow-up limit reached")
    return step


def thread_parent(messages: list[dict]) -> dict | None:
    """The newest SENT outbound message that has an RFC Message-ID: what a follow-up should reply into. None = no thread to join."""
    for m in reversed(messages or []):
        if m.get("direction") == "outbound" and m.get("state") == "sent" and m.get("rfc_message_id"):
            refs = " ".join(x for x in [(m.get("references_ids") or "").strip(), m["rfc_message_id"]] if x)
            return {"in_reply_to": m["rfc_message_id"], "references": refs[-3900:], "subject": m.get("subject") or ""}
    return None


def build_followup(prospect: dict, kb: dict, settings: dict, sent_on: str, parent_subject: str | None = None) -> dict:
    require_kb(kb, prospect["type"])
    if is_japanese_prospect(prospect):
        body = ("先日ご連絡いたしました件で、念のため簡単にフォローアップさせていただきました。"
                "現在アニメーション制作の外部協力がご不要でしたら、どうぞお気になさらないでください。")
        fallback_subject = f"アニメーション制作協力のご提案｜{prospect['name']}"
    else:
        body = (f"{greeting(prospect)} I wanted to briefly follow up on my note from {sent_on}. "
                "If animation support is not a priority right now, no problem at all.")
        fallback_subject = SUBJECT[prospect["type"]].format(name=prospect["name"])
    if parent_subject:
        subject = parent_subject if re.match(r"(?i)^re:", parent_subject) else f"Re: {parent_subject}"
    else:
        subject = f"Following up: {fallback_subject}"
    return {"subject": subject[:120], "body": body + policy.compliance_footer(settings)}



def build_auto_reply(label: str, prospect: dict, kb: dict, settings: dict, inbound_subject: str) -> dict | None:
    """Short acknowledgement for simple replies only; substantive questions remain human-reviewed."""
    if label not in ("positive", "portfolio_request") or not kb.get("portfolio.main"):
        return None
    portfolio = _portfolio_url(kb)
    if is_japanese_prospect(prospect):
        body = f"ご返信ありがとうございます。Studio Kairegiの制作実績はこちらからご覧いただけます：<{portfolio}>。具体的なご相談については、担当者より改めてご連絡いたします。"
        fallback = "アニメーション制作について"
    else:
        body = f"{greeting(prospect)} Thanks for getting back to me. You can view our animation portfolio here: {portfolio}. I will follow up personally on any specific questions."
        fallback = "your reply"
    subj = inbound_subject if re.match(r"(?i)^re:", inbound_subject or "") else f"Re: {inbound_subject or fallback}"
    return {"subject": subj[:120], "body": body + "\n"}



def approved_urls(kb: dict) -> set[str]:
    out: set[str] = set()
    for e in kb.values():
        out |= {u.rstrip(".,)") for u in policy.URL.findall(e["body"])}
    return out
