"""Email drafting. The studio's facts come ONLY from approved knowledge-base entries, copied word for word. The model may
write one short personal opening sentence from verified evidence; if it is invalid we use a plain deterministic one."""
from __future__ import annotations

import re
import hashlib
import json

from . import policy
from .errors import PermanentError, TransientError
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
# Calibrated against tests/fixtures/phase2_similarity_pairs.json. Keep this value
# centralized so drafting and reply checks cannot silently diverge.
SIMILARITY_THRESHOLD = 0.55


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


# Phase 2: recipient-specific English composition. Japanese drafting is deliberately
# left to the separate Phase 3 implementation.
COMPOSE_SCHEMA = {"type": "object", "required": ["subject", "body", "evidence_ids"], "properties": {
    "subject": {"type": "string", "maxLength": 120},
    "body": {"type": "string", "maxLength": 3000},
    "evidence_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 12}
}}

RISKY_CLAIM_TERMS = ("award", "awarded", "winner", "winning", "won", "ranked", "million", "billion", "record-breaking", "sold-out",
                     "acclaimed", "hiring", "hire", "hired", "recruiting", "outsourcing", "outsource", "outsourced", "shortage",
                     "funding", "funded", "secured", "raised", "investment", "investors", "publisher", "acquired", "acquisition",
                     "praised", "endorsed", "featured", "nominated", "grand", "prize", "partnership", "partnered",
                     "backlog", "behind schedule", "struggling")
PAYLOAD_BUDGET = 18000   # chars of JSON sent to the model; ollama.generate_json allows up to 24000


def _english(prospect: dict) -> bool:
    return not is_japanese_animation_prospect(prospect)

def _stable_evidence_id(e: dict) -> str:
    """Position-independent id for evidence rows the RPC returns without one."""
    basis = "|".join(re.sub(r"\s+", " ", str(e.get(k) or "")).strip().lower() for k in ("url", "fact_type", "snippet"))
    return "ev-" + hashlib.sha1(basis.encode("utf-8")).hexdigest()[:12]


def _evidence_catalog(evidence: list[dict], *, inbound: dict | None = None, history: list[dict] | None = None, kind: str = "initial") -> list[dict]:
    """Build a bounded, traceable catalog with reply/thread evidence prioritized.

    The current inbound message and recent inbound thread messages are kept first,
    so a long research catalog cannot crowd out the source being answered.
    Sent outbound history is context only, never prospect fact evidence.
    """
    out: list[dict] = []
    seen: set[str] = set()

    def add(eid, fact_type, snippet, url=""):
        eid = str(eid or "").strip()
        snippet = re.sub(r"\s+", " ", str(snippet or "")).strip()[:500]
        if eid and snippet and eid not in seen:
            seen.add(eid)
            out.append({"id": eid, "fact_type": fact_type, "snippet": snippet, "url": str(url or "")[:500]})

    # First priority: actual incoming message and inbound conversation context.
    if kind == "reply" and inbound:
        add(inbound.get("id") or "incoming_message", "actual_incoming_message",
            _new_text(inbound.get("body") or inbound.get("body_text") or ""))
    if kind in ("followup", "reengagement", "reply"):
        for i, m in enumerate(history or []):
            if m.get("direction") == "inbound":
                add(m.get("id") or f"history_inbound{i}", "conversation_inbound", _new_text(m.get("body_text") or m.get("body") or ""))

    # Second priority: verified research evidence.
    for i, e in enumerate(evidence or []):
        if e.get("verified") and isinstance(e.get("snippet"), str) and e["snippet"].strip():
            add(e.get("id") or _stable_evidence_id(e), str(e.get("fact_type") or "prospect_fact"), e["snippet"], e.get("url") or "")

    # Third priority: actually sent messages for thread continuity only.
    if kind in ("followup", "reengagement", "reply"):
        for i, m in enumerate(history or []):
            if m.get("direction") == "outbound" and m.get("state") == "sent":
                add(m.get("id") or f"history_outbound{i}", "sent_outreach_history", m.get("body_text") or m.get("body") or "")
    return out[:30]

def _tokens(text: str) -> set[str]:
    """Language-aware tokens for similarity and grounding checks.

    English uses words. Japanese uses overlapping character bigrams so text with
    no whitespace remains comparable without requiring an optional tokenizer.
    """
    value = (text or "").lower()
    english = set(re.findall(r"[a-z][a-z0-9'-]{2,}", value))
    japanese_chars = re.findall(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]", value)
    if len(japanese_chars) >= 3:
        compact = "".join(japanese_chars)
        ja = {compact[i:i + 2] for i in range(len(compact) - 1)}
        # Keep Latin terms as well for mixed Japanese/English correspondence.
        return english | ja
    return english


def _new_text(body: str) -> str:
    """The sender's own words, above or below the quote (see policy.first_unquoted)."""
    return policy.first_unquoted(body)


_GREETING_LINE = re.compile(r"^\s*(?:hello|hi|hey|dear|good (?:morning|afternoon|evening))\b[^\n]{0,60}$", re.I)
_SIGNOFF_LINE = re.compile(r"^\s*(?:best(?: regards| wishes)?|kind regards|warm regards|regards|thanks|thank you|cheers|sincerely|many thanks)[,!.]?\s*$", re.I)


def _claim_body(body: str) -> str:
    """The body with its salutation and sign-off removed, so the grounding checks see only the message itself.

    A salutation such as "Hello Sam," has no sentence punctuation, so left in place it merged with the first real
    sentence: that sentence then counted as naming the prospect (forcing the personalized-claim check) and its first
    capitalised word was treated as an unsupported named entity."""
    lines = str(body or "").strip().splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and _GREETING_LINE.match(lines[0]) and not re.search(r"[.!?]\s*$", lines[0]):
        lines.pop(0)
    for i in range(max(0, len(lines) - 4), len(lines)):
        if _SIGNOFF_LINE.match(lines[i]):
            lines = lines[:i]
            break
    return "\n".join(lines).strip()


def _is_consequential_inbound(inbound: dict | None) -> bool:
    """Fail closed for incoming English messages requiring negotiation or human judgment."""
    if not inbound:
        return False
    text = " ".join([str(inbound.get(k) or "") for k in ("subject", "summary", "class")]
                    + [_new_text(str(inbound.get(k) or "")) for k in ("body", "body_text")])
    text = policy.normalize_quotes(text)
    patterns = (
        r"\b(?:price|pricing|quote|quotation|budget|discount|payment|invoice|cost|fee|rate)s?\b",
        r"\b(?:contract|agreement|terms|negotiate|negotiation|sign|legal|nda|liability)\b",
        r"\b(?:complaint|complain|unhappy|dissatisfied|problem|issue|refund|chargeback|poor work|mistake|dispute)\b",
        r"\b(?:deadline|deliver(?:y)? date|deliver by|commit(?:ment)?|guarantee|promise|availability|available on|schedule|scope|accept the offer)\b",
        r"\b(?:unsubscribe|stop emailing|remove me|do not contact|don't contact|opt out)\b",
        r"\b(?:can you commit|would you sign|confirm the scope|confirm delivery|we require|we expect you to)\b",
    )
    return any(re.search(p, text, re.I) for p in patterns)

def similarity(a: str, b: str) -> float:
    """Token-set Jaccard similarity with Japanese character-bigram support."""
    x, y = _tokens(a), _tokens(b)
    return len(x & y) / len(x | y) if x or y else (1.0 if not (a or b) else 0.0)

def _similarity_text(value: str) -> str:
    """Remove recipient greeting and policy footer before comparing message substance."""
    text = re.sub(r"\s+", " ", str(value or "")).strip().lower()
    # Remove common opt-out/legal footer content and standard address/email lines.
    text = re.sub(r"(?:if you (?:would rather|prefer) not to hear from us|to unsubscribe|please reply.*?unsubscribe).*?$", "", text, flags=re.I)
    text = re.sub(r"\b(?:unsubscribe|配信停止)\b", "", text, flags=re.I)
    text = re.sub(r"\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", "<email>", text)
    text = re.sub(r"https?://\S+", "<url>", text)
    text = re.sub(r"^(?:hello(?:\s+[^,]+)?|dear(?:\s+[^,]+)?),?\s*", "", text)
    return text.strip()


_GENERIC_NAME_PARTS = {"games", "game", "studio", "studios", "animation", "animations", "inc", "ltd", "llc", "co", "corp", "the", "and",
                       "entertainment", "interactive", "productions", "production", "pictures", "works", "labs", "digital", "media", "team"}


def _mask_names(text: str, names) -> str:
    """Replace the recipient's own names with a placeholder so a name swap cannot hide a reused message.

    Capitalisation-based entity detection misses names like "id Software" or "2K Games"; the names themselves
    (full name, and distinctive parts such as "2K") are known, so mask them directly."""
    variants: set[str] = set()
    for n in names or []:
        n = re.sub(r"\s+", " ", str(n or "")).strip()
        if len(n) < 2:
            continue
        variants.add(n)
        for part in re.split(r"[\s,.&/|-]+", n):
            if (len(part) >= 3 and part.lower() not in _GENERIC_NAME_PARTS) or (len(part) >= 2 and re.search(r"\d", part)):
                variants.add(part)
    out = str(text or "")
    for v in sorted(variants, key=len, reverse=True):
        pattern = r"(?<![A-Za-z0-9])" + r"\s+".join(re.escape(w) for w in v.split(" ")) + r"(?![A-Za-z0-9])"
        out = re.sub(pattern, " <entity> ", out, flags=re.I)
    return re.sub(r"\s+", " ", out).strip()


def uniqueness_check(draft: dict, prior_drafts: list[dict], threshold: float, footer: str = "", names=None) -> dict:
    """Check substantive text. Only the application-added compliance footer (passed as `footer`) is
    excluded; a body paragraph repeated across messages is exactly a reused template and must count."""
    body = _similarity_text(draft.get("body"))
    subject = re.sub(r"\s+", " ", str(draft.get("subject") or "")).strip().lower()
    if not body:
        return {"ok": False, "reason": "empty_draft", "similarity": 1.0}
    normalized_prior = [_similarity_text(p.get("body")) for p in prior_drafts or []]
    footer_lines = {_similarity_text(x) for x in re.split(r"[\n\r]+", footer or "") if _similarity_text(x)}
    footer_lines.discard("--")
    def _substance(raw):
        return [b for b in re.split(r"[\n\r]+", str(raw or "")) if _similarity_text(b) not in footer_lines and not re.match(r"^\s*ref:\s", b, re.I)]
    candidate = _similarity_text(" ".join(_substance(draft.get("body")))) or body
    for i, prior in enumerate(prior_drafts or []):
        old_body = _similarity_text(" ".join(_substance(prior.get("body")))) or normalized_prior[i]
        old_subject = re.sub(r"\s+", " ", str(prior.get("subject") or "")).strip().lower()
        score = similarity(candidate, old_body)
        # Name swaps: compare again with each message's own recipient names masked out (prior rows may carry "names").
        masked_a, masked_b = _mask_names(candidate, names), _mask_names(old_body, prior.get("names"))
        score = max(score, similarity(masked_a, masked_b))
        if candidate == old_body or (subject == old_subject and score >= threshold) or score >= threshold:
            return {"ok": False, "reason": "duplicate_or_near_duplicate", "similarity": score}
        raw_a, raw_b = str(draft.get("body") or ""), str(prior.get("body") or "")
        # Preserve capitalization until entity placeholders have been applied. Lower-
        # casing first made the former capitalized-name pattern unreachable.
        def structural_skeleton(raw):
            value = re.sub(r"\s+", " ", str(raw or "")).strip()
            value = re.sub(r"^(?:hello(?:\s+[^,]+)?|dear(?:\s+[^,]+)?),?\s*", "", value, flags=re.I)
            value = re.sub(r"https?://\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", "<contact>", value, flags=re.I)
            value = re.sub(r"\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})*\b", "<entity>", value)
            return re.sub(r"\W+", " ", value).lower().strip()
        skeleton_a, skeleton_b = structural_skeleton(_mask_names(raw_a, names)), structural_skeleton(_mask_names(raw_b, prior.get("names")))
        if skeleton_a and skeleton_a == skeleton_b:
            return {"ok": False, "reason": "structural_repetition", "similarity": 1.0}
    return {"ok": True, "reason": "unique", "similarity": 0.0}

def _reply_addresses_inbound(body: str, inbound: dict | None) -> bool:
    """Require a reply to visibly address the inbound request, not merely cite it.

    This is intentionally conservative: known request intents have explicit
    synonym groups; other messages require meaningful lexical overlap.
    """
    if not inbound:
        return False
    # The inbound subject is usually our own pitch subject echoed back ("Re: 2D animation for X"), so it must not
    # count as the request: echoing it would satisfy the overlap test without answering anything.
    source = " ".join(_new_text(str(inbound.get(k) or "")) for k in ("body", "body_text")).strip().lower()
    if not source:
        source = " ".join(str(inbound.get(k) or "") for k in ("subject", "summary")).lower()
    reply = _claim_body(str(body or "")).lower()
    def has(term: str) -> bool:
        return bool(re.search(r"\b" + re.escape(term) + r"\b", reply))
    groups = []
    if re.search(r"\b(portfolio|reel|work samples?|samples? of (?:your|our) work)\b", source):
        groups.append(("portfolio", "reel", "work samples", "samples", "previous work"))
    if re.search(r"\b(link|url|website|site)\b", source):
        groups.append(("link", "url", "website", "portfolio", "send", "share", "access"))
    if re.search(r"\b(call|meeting|meet|speak|chat)\b", source):
        groups.append(("call", "meeting", "meet", "speak", "chat"))
    if re.search(r"\b(question|clarify|explain|tell me)\b", source):
        groups.append(("question", "clarify", "explain", "details", "information"))
    if groups:
        return all(any(has(term) for term in group) for group in groups)
    source_tokens = _tokens(source) - {"hello", "thanks", "thank", "please", "could", "would", "your", "about", "what", "when", "where", "have", "from", "that", "this"}
    reply_tokens = _tokens(reply)
    if len(source_tokens) < 2:
        return bool(source_tokens & reply_tokens)
    return len(source_tokens & reply_tokens) / len(source_tokens) >= 0.20


def compose_english(prospect: dict, evidence: list[dict], kb: dict, settings: dict, llm,
                    *, kind: str, inbound: dict | None = None, history: list[dict] | None = None,
                    sent_on: str | None = None, parent_subject: str | None = None, feedback: str | None = None) -> dict:
    """Compose an evidence-grounded English message for one recipient. No generic fallback."""
    require_kb(kb, prospect["type"])
    if not _english(prospect):
        raise PermanentError("Phase 2 English composer is not used for Japanese prospects")
    catalog = _evidence_catalog(evidence, inbound=inbound, history=history, kind=kind)
    if len(catalog) < 1:
        raise PermanentError("insufficient verified prospect evidence; manual review required")
    approved = {k: v["body"].strip() for k, v in kb.items() if isinstance(v, dict) and v.get("body", "").strip()
                and (k in ("studio.about", "portfolio.main", TYPE_KEY[prospect["type"]]) or k.startswith("faq."))}
    if not all(approved.get(k) for k in ("studio.about", "portfolio.main", TYPE_KEY[prospect["type"]])):
        raise PermanentError("approved knowledge base is incomplete")
    kind_instruction = {
        "initial": "Write a genuinely individualized first-contact email. Derive opening, collaboration angle, and phrasing from prospect evidence. Do not claim interest, watching/playing, unmet needs, hiring or outsourcing unless evidence explicitly supports it.",
        "followup": "Write a concise follow-up that advances the actual previous outreach without repeating its pitch. Respect the real sent date and thread subject. If the conversation says no, stop or request review.",
        "reply": "Answer the actual incoming email directly. Do not invent interest, commitments, prices, deadlines, availability, or prior agreements. If the message raises pricing, contracts, negotiation, complaint, unsubscribe, or other consequential issues, refuse to draft and require human review.",
        "reengagement": "Write a genuinely new, low-pressure re-engagement message informed by actual prior outreach and the prospect's verified work. Do not pretend a conversation or interest occurred."
    }.get(kind)
    if not kind_instruction:
        raise PermanentError(f"unsupported English composition kind: {kind}")
    if kind == "reply" and _is_consequential_inbound(inbound):
        raise PermanentError("incoming reply raises consequential pricing, terms, complaint, scope, scheduling, or opt-out issues; manual review required")
    def _payload(cat):
        # Key order matters: the facts and message the model must answer come first.
        return {"message_kind": kind, "approved_studio_facts": approved,
            "incoming_message": ({**inbound, "body": _new_text(str(inbound.get("body") or ""))[:3000]} if inbound else {}),
            "prospect": {"name": prospect.get("name"), "contact_name": prospect.get("contact_name"),
                "type": prospect.get("type"), "website": prospect.get("website"), "services": prospect.get("services")},
            "sent_date": sent_on, "thread_subject": parent_subject, "verified_evidence": cat,
            "conversation_history": [{k: (str(v)[:600] if isinstance(v, str) else v) for k, v in m.items()
                                      if k in ("direction", "kind", "state", "subject", "body_text", "body", "sent_at")}
                                     for m in (history or [])[-6:]]}
    # Drop the lowest-priority evidence (the catalog is priority-ordered) until the payload fits.
    # The model can only cite what it was shown, so ids are validated against the trimmed catalog.
    while len(catalog) > 1 and len(json.dumps(_payload(catalog), ensure_ascii=False)) > PAYLOAD_BUDGET:
        catalog = catalog[:-1]
    payload = _payload(catalog)
    instruction = ("You are writing one English business email on behalf of Studio Kairegi. "
        + kind_instruction + " Use only verified evidence for personalized claims and approved studio facts for service claims. "
        "Evidence ids you rely on must be returned in evidence_ids. No generic fallback, no template reuse, no name-swapping. "
        "Subject and body should sound human, specific, concise and professional. Do not include a compliance footer; the application adds it. "
        "Return only the requested JSON.")
    if feedback:
        # One regeneration after a failed similarity/policy check. The reason is data about the rejected draft;
        # the evidence and approved-facts rules above still apply in full.
        instruction += (" A previous draft for this recipient was rejected: " + re.sub(r"\s+", " ", str(feedback)).strip()[:400]
                        + " Write a new draft from the verified evidence with different structure and wording; do not reuse the rejected draft.")
    try:
        mail = llm(instruction, json.dumps(payload, ensure_ascii=False), COMPOSE_SCHEMA)
    except TransientError:
        raise   # model outage / bad JSON: the job retries; never a permanent manual-review flag
    except Exception as exc:
        raise PermanentError(f"individualized composition unavailable; manual review required ({type(exc).__name__})") from exc
    if not isinstance(mail, dict):
        raise PermanentError("composer returned invalid structure; manual review required")
    subject, body = str(mail.get("subject") or "").strip(), str(mail.get("body") or "").strip()
    evidence_ids = mail.get("evidence_ids")
    ids = {e["id"] for e in catalog}
    footer_text = policy.compliance_footer(settings)
    if not subject or not body or len(subject) > 120 or len(body) + 2 + len(footer_text) > policy.MAX_BODY_CHARS or not isinstance(evidence_ids, list):
        raise PermanentError("composer returned incomplete draft; manual review required")
    if not evidence_ids or any(str(x) not in ids for x in evidence_ids):
        raise PermanentError("draft evidence trace is missing or invalid; manual review required")
    if kind == "reply":
        inbound_id = str((inbound or {}).get("id") or "incoming_message")
        if inbound_id not in {str(x) for x in evidence_ids}:
            raise PermanentError("reply does not cite the actual incoming message; manual review required")
    # Verify subject-line factual claims against cited prospect evidence or approved
    # studio facts. Recipient identity is known from CRM; it is not a prospect claim.
    cited_entries = [e for e in catalog if e["id"] in {str(x) for x in evidence_ids}]
    # Sent outbound history is context for continuity only. It must never establish
    # facts about a prospect (otherwise a prior unsupported claim can self-reinforce).
    cited_fact_entries = [e for e in cited_entries if e.get("fact_type") != "sent_outreach_history"]
    cited_snippets = [e["snippet"] for e in cited_fact_entries]
    cited_text = " ".join(cited_snippets)
    if not cited_fact_entries:
        raise PermanentError("draft evidence cites only conversation continuity or non-factual sources; manual review required")
    subject_tokens = _tokens(subject)
    identity_tokens = _tokens(str(prospect.get("name") or "") + " " + str(prospect.get("contact_name") or ""))
    subject_ignore = {"thought", "regarding", "about", "idea", "animation", "studio", "your", "for", "the", "and", "on", "a", "our", "work", "support", "with"}
    subject_claim_tokens = subject_tokens - identity_tokens - subject_ignore
    subject_source_tokens = _tokens(cited_text) | _tokens(" ".join(approved.values()))
    allowed_entities = identity_tokens | _tokens("Studio Kairegi") | subject_source_tokens
    subject_entities = {x.lower() for x in re.findall(r"\b[A-Z][a-z]{2,}\b", subject)}
    # Ignore the first capitalized word (normal sentence-style subject casing), but
    # require any subsequent proper-name tokens to be prospect identity or sourced.
    first_word = re.search(r"\b[A-Z][a-z]{2,}\b", subject)
    if first_word:
        subject_entities.discard(first_word.group(0).lower())
    if subject_entities - allowed_entities:
        raise PermanentError("subject contains an unsupported named entity; manual review required")
    if subject_claim_tokens and len(subject_claim_tokens & subject_source_tokens) / len(subject_claim_tokens) < 0.50:
        raise PermanentError("subject contains an unsupported personalized claim; manual review required")
    # Explicitly scrutinize high-risk factual claims (awards, rankings, numbers,
    # named milestones). Lexical grounding alone is not enough if these are absent.
    risky_claim_terms = {"award", "awarded", "winner", "winning", "ranked", "million", "billion", "record-breaking", "sold-out", "acclaimed"}
    subject_lower = subject.lower()
    for term in risky_claim_terms:
        if re.search(r"\b" + re.escape(term) + r"\b", subject_lower) and not re.search(r"\b" + re.escape(term) + r"\b", cited_text.lower() + " " + " ".join(approved.values()).lower()):
            raise PermanentError("subject contains an unsupported award/ranking/achievement claim; manual review required")
    cited_tokens = _tokens(" ".join(cited_snippets))
    approved_tokens = _tokens(" ".join(approved.values()))
    ignore = {"hello", "thank", "would", "could", "your", "about", "studio", "animation", "work", "the", "and", "for", "with", "that", "this", "from", "have", "has", "are", "our", "you", "its", "their", "seem", "seems", "like", "distinctive", "direction"}
    sentences = [x.strip() for x in re.split(r"(?<=[.!?])\s+", _claim_body(body)) if x.strip()]
    overlap_values = []
    evidence_lower = cited_text.lower()
    allowed_lower = evidence_lower + " " + " ".join(approved.values()).lower()
    calendar_words = set("monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december".split())
    sender_tokens = _tokens(str(settings.get("sender_name") or ""))
    allowed_entities = identity_tokens | sender_tokens | _tokens("Studio Kairegi") | cited_tokens | approved_tokens | calendar_words
    # _tokens() never yields digit-led words ("2023", "2K"), so allow the raw alphanumeric words of the sources too.
    allowed_entities |= set(re.findall(r"[a-z0-9]{3,}", allowed_lower))
    sentence_openers = {"the", "and", "it", "its", "if", "as", "in", "on", "at", "to", "of", "by", "my", "so", "or", "can", "will", "yes", "hello", "thanks", "thank", "thank you", "hi", "dear", "our", "your", "we", "this", "that", "these", "happy",
                        "glad", "please", "would", "could", "should", "might", "when", "while", "since", "also", "and", "but",
                        "with", "from", "for", "let", "feel", "just", "here", "there", "they", "its", "any", "some", "many",
                        "most", "such", "each", "both", "after", "before", "because", "although", "though", "otherwise", "best",
                        "kind", "warm", "regards", "sincerely", "cheers", "welcome", "sorry", "great", "good"}
    for sentence in sentences:
        tokens = _tokens(sentence) - ignore
        # The prospect's own name must never pad the overlap: "<Name> is hiring ..." shares
        # the name with the evidence and nothing else.
        claim_tokens = tokens - identity_tokens - sender_tokens - {"thanks", "regards", "best", "cheers", "sincerely", "welcome", "appreciate"}
        if not claim_tokens:
            continue
        sentence_lower = sentence.lower()
        if any(n not in allowed_lower for n in re.findall(r"\d[\d,.]*\d|\d", sentence_lower)):
            raise PermanentError("sentence contains a number or year absent from cited evidence and approved facts; manual review required")
        # Every sentence gets the high-risk and entity checks, not only trigger-word ones.
        if any(re.search(r"\b" + re.escape(term) + r"\b(?!')", sentence_lower) and not re.search(r"\b" + re.escape(term) + r"\b", allowed_lower)
               for term in RISKY_CLAIM_TERMS):
            raise PermanentError("sentence includes a high-specificity claim absent from cited evidence and approved facts; manual review required")
        sentence_entities = {x.lower() for x in re.findall(r"\b[A-Z0-9][A-Za-z0-9]{2,}\b", sentence)}
        first = re.match(r"\W*([A-Za-z0-9]+)", sentence)
        # Only ordinary sentence-opening words are exempt; a leading proper noun is checked.
        if first and first.group(1).lower() in sentence_openers:
            sentence_entities.discard(first.group(1).lower())
        if sentence_entities - allowed_entities:
            raise PermanentError("sentence contains an unsupported named entity; manual review required")
        ev_ratio = len(claim_tokens & cited_tokens) / len(claim_tokens)
        ap_ratio = len(claim_tokens & approved_tokens) / len(claim_tokens)
        # A sentence is a claim about the prospect if it uses a trigger word, names the
        # prospect, or states something about them or an event ("is ... recently ...").
        personalized = bool(re.search(r"\b(?:your|you|project|game|trailer|portfolio|release|team|they|their|them|recently|currently|this year|last year|announced|secured|raised|launched|signed|partnered|won(?!')|is|are|was|were)\b", sentence, re.I)) or bool(tokens & identity_tokens)
        service_only = ap_ratio >= 0.5 and not (tokens & identity_tokens)
        if personalized and not service_only and len(claim_tokens) >= (1 if tokens & identity_tokens else 3):
            if ev_ratio < 0.50:
                raise PermanentError("a personalized claim is not supported sentence-by-sentence by cited evidence; manual review required")
            overlap_values.append(ev_ratio)
        elif max(ev_ratio, ap_ratio) < 0.20 and len(claim_tokens) >= 5:
            raise PermanentError("draft contains a sentence unsupported by prospect evidence or approved studio facts; manual review required")
    overlap = sum(overlap_values) / len(overlap_values) if overlap_values else 1.0
    if re.search(r"\b(?:as we discussed|you expressed interest|we watched|we played|you need|you are hiring)\b", body, re.I):
        raise PermanentError("unsupported implied history or need; manual review required")
    # Deterministic final-boundary guard for consequential reply language. Model
    # instructions are not a safety boundary; negotiation, pricing, terms, promises,
    # availability and contractual commitments must be routed to human review.
    if kind == "reply" and re.search(
        r"\b(?:price(?:s|d)?|pricing|quote|quotation|budget|discount|payment|invoice|contract|agreement|terms|negotiate|negotiation|deadline|deliver by|guarantee|commit(?:ment)?|available on|availability|schedule a meeting|book a call|accept the offer|we can deliver)\b",
        body, re.I,
    ):
        raise PermanentError("reply contains consequential pricing, terms, scheduling, or commitment language; manual review required")
    if kind == "reply" and not _reply_addresses_inbound(body, inbound):
        raise PermanentError("reply does not address the actual incoming request; manual review required")
    # The model must compose only relevant approved service information. Do not append
    # identical studio/service/portfolio blocks to every message; append only policy footer.
    body += "\n\n" + policy.compliance_footer(settings)
    trace = [{"id": e["id"], "fact_type": e["fact_type"], "url": e["url"], "snippet": e["snippet"][:240]} for e in cited_entries]
    return {"subject": subject, "body": body, "model_written": True, "evidence_ids": [str(x) for x in evidence_ids], "evidence_trace": trace,
            "personalization": {"kind": kind, "evidence_ids": [str(x) for x in evidence_ids], "grounding_overlap": round(overlap, 3)}}
