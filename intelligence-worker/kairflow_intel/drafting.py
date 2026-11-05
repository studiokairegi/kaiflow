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
SUBJECT_JA = "アニメーション制作協力のご提案｜{name}"
REQUIRED = ("studio.about", "portfolio.main")
JAPANESE_REQUIRED = ("studio.about.ja", "services.animation_studio_support.ja", "portfolio.main.ja", "policy.opt_out.ja")


def kb_map(kb: list[dict]) -> dict[str, dict]:
    return {e["key"]: e for e in kb or []}


def require_kb(kb: dict, ptype: str) -> None:
    need = [*REQUIRED, TYPE_KEY[ptype]]
    missing = [k for k in need if not (kb.get(k) and kb[k]["body"].strip())]
    if missing:
        raise PermanentError(f"approved knowledge base is missing: {', '.join(missing)}")


def is_japanese_animation_prospect(prospect: dict) -> bool:
    """Japanese copy is used for animation-support prospects whose site language is Japanese or country is Japan."""
    if prospect.get("type") != "animation_studio_support":
        return False
    language = str(prospect.get("language") or "").strip().lower()
    country = str(prospect.get("country") or "").strip().lower()
    return language in {"ja", "japanese", "日本語"} or country in {"japan", "jp", "jpn", "日本", "日本国"}


def require_japanese_kb(kb: dict) -> None:
    missing = [k for k in JAPANESE_REQUIRED if not (kb.get(k) and kb[k]["body"].strip())]
    if missing:
        raise PermanentError(f"approved Japanese knowledge base is missing: {', '.join(missing)}")


def greeting(prospect: dict) -> str:
    if is_japanese_animation_prospect(prospect):
        return "ご担当者様"
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


def build_initial(prospect: dict, evidence: list[dict], kb: dict, settings: dict, llm=None) -> dict:
    ptype = prospect["type"]
    require_kb(kb, ptype)
    if is_japanese_animation_prospect(prospect):
        require_japanese_kb(kb)
        paragraph = "突然のご連絡失礼いたします。" + " ".join(kb[k]["body"].strip() for k in JAPANESE_REQUIRED[:3])
        paragraph += " ご関心がございましたら、お気軽にご返信いただけますと幸いです。"
        body = greeting(prospect) + "\n\n" + paragraph
        body += "\n" + policy.compliance_footer(settings, opt_out_text=kb["policy.opt_out.ja"]["body"].strip())
        return {"subject": SUBJECT_JA.format(name=prospect["name"])[:120], "body": body}
    hook = model_hook(prospect, evidence, llm) or plain_hook(prospect, evidence)
    body = "\n\n".join([greeting(prospect), hook, kb["studio.about"]["body"].strip(), kb[TYPE_KEY[ptype]]["body"].strip(),
                        kb["portfolio.main"]["body"].strip(), "If it would be useful, I would be glad to share more or answer any questions."])
    body += "\n" + policy.compliance_footer(settings)
    return {"subject": SUBJECT[ptype].format(name=prospect["name"])[:120], "body": body}


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
    if is_japanese_animation_prospect(prospect):
        require_japanese_kb(kb)
        paragraph = f"先日お送りしたアニメーション制作協力のご案内について、改めてご連絡いたしました。" \
                    f"現在は外部スタッフのご協力が不要でしたら、どうぞご放念ください。{kb['portfolio.main.ja']['body'].strip()}"
        body = greeting(prospect) + "\n\n" + paragraph + "\n" + policy.compliance_footer(settings, opt_out_text=kb["policy.opt_out.ja"]["body"].strip())
    else:
        body = "\n\n".join([greeting(prospect),
                            f"I wanted to follow up briefly on the note I sent on {sent_on}. If animation support is not a priority right now, no problem at all.",
                            kb["portfolio.main"]["body"].strip()]) + "\n" + policy.compliance_footer(settings)
    if parent_subject:   # joining a real thread: keep its subject, add Re: once
        subject = parent_subject if re.match(r"(?i)^re:", parent_subject) else f"Re: {parent_subject}"
    else:                # no thread to join (e.g. an email sent from the CRM by hand): do not fake a reply
        base_subject = SUBJECT_JA.format(name=prospect["name"]) if is_japanese_animation_prospect(prospect) else SUBJECT[prospect['type']].format(name=prospect['name'])
        subject = f"Following up: {base_subject}" if not is_japanese_animation_prospect(prospect) else f"再度のご連絡｜{base_subject}"
    return {"subject": subject[:120], "body": body}


def build_auto_reply(label: str, prospect: dict, kb: dict, settings: dict, inbound_subject: str) -> dict | None:
    """Only for simple replies, built entirely from approved text. Returns None when the knowledge base cannot cover it."""
    if label not in ("positive", "portfolio_request") or not kb.get("portfolio.main") or not kb.get("studio.about"):
        return None
    if is_japanese_animation_prospect(prospect):
        try:
            require_japanese_kb(kb)
        except PermanentError:
            return None
        paragraph = "ご返信いただき、ありがとうございます。" + " ".join(kb[k]["body"].strip() for k in JAPANESE_REQUIRED[:3])
        paragraph += " 具体的なご相談については、改めてこちらからご連絡いたします。"
        subj = inbound_subject if re.match(r"(?i)^re:", inbound_subject or "") else f"Re: {inbound_subject or 'ご返信'}"
        footer = settings.get("sender_name", "").strip()
        return {"subject": subj[:120], "body": greeting(prospect) + "\n\n" + paragraph + ("\n\n" + footer if footer else "") + "\n"}
    parts = [greeting(prospect), "Thank you for getting back to me." , kb["portfolio.main"]["body"].strip()]
    if kb.get(TYPE_KEY.get(prospect["type"], "")):
        parts.append(kb[TYPE_KEY[prospect["type"]]]["body"].strip())
    if kb.get("faq.intro_question"):
        parts.append(kb["faq.intro_question"]["body"].strip())
    parts.append(f"I will follow up personally on anything specific.\n\n{settings.get('sender_name', '').strip()}")
    subj = inbound_subject if re.match(r"(?i)^re:", inbound_subject or "") else f"Re: {inbound_subject or 'your reply'}"
    return {"subject": subj[:120], "body": "\n\n".join(parts) + "\n"}


def approved_urls(kb: dict) -> set[str]:
    out: set[str] = set()
    for e in kb.values():
        out |= {u.rstrip(".,)") for u in policy.URL.findall(e["body"])}
    return out
