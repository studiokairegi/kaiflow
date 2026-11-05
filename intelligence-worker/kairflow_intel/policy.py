"""Deterministic policy. These rules run BEFORE and AFTER the model and cannot be argued with by an email or a web page."""
from __future__ import annotations

import re

I = re.I | re.U

UNSUBSCRIBE = re.compile(r"\bunsubscribe\b|remove me|take me off|do not contact|don'?t contact|do not email|stop (e-?mailing|contacting|sending|writing)|no more e-?mails?|opt[- ]?out|配信停止|送らないで|連絡しないで|解除", I)
COMPLAINT = re.compile(r"\bspam\b|report (you|this)|unsolicited|\bgdpr\b|\bccpa\b|how did you (get|find) my|remove my data|delete my data|legal action|harass", I)
CLASS_PATTERNS = {
    "pricing": re.compile(r"\b(price|prices|pricing|quote|quotation|rates?|costs?|budget|how much|fees?|estimate|per (second|minute|frame))\b|[$€£¥]\s?\d|\d\s?(usd|eur|jpy|gbp)\b|料金|見積|費用|予算", I),
    "negotiation": re.compile(r"discount|negotiat|counter ?offer|lower (the )?price|payment terms?|\bnet ?\d{2}\b|deposit|upfront|invoice|revenue share|royalt", I),
    "contract": re.compile(r"\bcontract\b|agreement|\bnda\b|non-?disclosure|terms and conditions|\blegal\b|契約|秘密保持", I),
    "deadline": re.compile(r"deadline|\bby (monday|tuesday|wednesday|thursday|friday|next week|end of)\b|\basap\b|urgent|due date|delivery date|turnaround|納期|締め切り", I),
    "availability": re.compile(r"availab|capacity|\bslots?\b|when can you start|how many animators|bandwidth|current(ly)? booked|空き|スケジュール", I),
    "meeting": re.compile(r"\b(call|meeting|zoom|meet|schedule|calendar|google meet|teams)\b|打ち合わせ|ミーティング", I),
    "portfolio": re.compile(r"portfolio|showreel|reel|samples?|previous work|examples? of|work samples|ポートフォリオ|実績", I),
    "interest": re.compile(r"interested|sounds (good|great|interesting)|love to|tell me more|more (info|information|details)|we('| a)?re looking|we need|yes[,.! ]|please send|ぜひ|興味", I),
    "decline": re.compile(r"not interested|no thank|no, thanks|not (looking|needed|required)|we (already|don'?t)|pass on this|not at this time|not a fit|結構です|間に合って", I),
}
OOO = re.compile(r"out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on (annual )?leave|away from (my )?(email|desk)|will (be )?(back|return) on|自動返信|不在", I)
BOUNCE_FROM = re.compile(r"^(mailer-daemon|postmaster|mail delivery subsystem)@", I)
BOUNCE_SUBJ = re.compile(r"undeliver|delivery status notification|delivery (has )?failed|failure notice|returned mail|could not be delivered|mail delivery failed|配信できません", I)
PERMANENT = re.compile(r"\b550\b|\b5\.\d\.\d\b|user unknown|no such user|does not exist|mailbox (not found|unavailable)|address rejected|unknown recipient|recipient address rejected", I)
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63})+")
URL = re.compile(r"https?://[^\s<>\")\]]+", I)
PRICE_IN_DRAFT = re.compile(r"[$€£¥]\s?\d|\d\s?(usd|eur|gbp|jpy)\b|\bper (second|minute|frame|hour)\b|\bdiscount\b|\bfree\b|\bguarantee", I)
FALSE_CLAIMS = re.compile(r"\b(we (have )?(played|watched|reviewed|tested|read|studied)|as we discussed|following up on our (call|conversation|meeting)|you('| a)?re (already )?(a )?(client|customer)|referred by|(mutual|common) (friend|connection)|i saw you at|we met)\b", I)

ESCALATE_CLASSES = {"pricing", "negotiation", "contract", "deadline", "availability", "complaint", "ambiguous", "meeting_request", "project_opportunity", "negotiation"}


def first_unquoted(body: str) -> str:
    """The new text of an email: drops quoted history and signatures so old words don't trigger rules."""
    out = []
    for line in (body or "").splitlines():
        if re.match(r"^\s*>", line) or re.match(r"^\s*(on .{5,80} wrote:|-{2,}\s*original message|from:\s)", line, I):
            break
        out.append(line)
    return "\n".join(out).strip()


def is_bounce(from_addr: str, subject: str) -> bool:
    return bool(BOUNCE_FROM.match((from_addr or "").strip()) or BOUNCE_SUBJ.search(subject or ""))


def bounce_details(body: str, own_addresses: set[str]) -> tuple[str | None, bool]:
    """(failed recipient, is_permanent). The recipient is the first address that is not ours or the daemon's."""
    for e in EMAIL.findall(body or ""):
        low = e.lower()
        if low in own_addresses or BOUNCE_FROM.match(low):
            continue
        return low, bool(PERMANENT.search(body or ""))
    return None, bool(PERMANENT.search(body or ""))


def is_auto_reply(subject: str, body: str, headers: dict | None = None) -> bool:
    h = {k.lower(): str(v).lower() for k, v in (headers or {}).items()}
    if h.get("auto-submitted", "no") not in ("no", "") or h.get("precedence") in ("bulk", "auto_reply", "junk", "list"):
        return True
    return bool(OOO.search(subject or "") or OOO.search((body or "")[:600]))


def scan_inbound(subject: str, body: str) -> dict:
    """Deterministic read of a reply. `hard` classes (unsubscribe, complaint, pricing...) can never be overridden by the model."""
    text = f"{subject}\n{first_unquoted(body)}"
    hits = {k for k, p in CLASS_PATTERNS.items() if p.search(text)}
    if "decline" in hits:   # "not interested" must not also count as interest
        if not CLASS_PATTERNS["interest"].search(CLASS_PATTERNS["decline"].sub(" ", text)):
            hits.discard("interest")
    if UNSUBSCRIBE.search(text):
        hits.add("unsubscribe")
    if COMPLAINT.search(text):
        hits.add("complaint")
    return {"hits": hits}


def hard_class(hits: set[str]) -> str | None:
    for c in ("unsubscribe", "complaint", "contract", "negotiation", "pricing", "deadline", "availability"):
        if c in hits:
            return c
    return None


def compliance_footer(settings: dict, token: str | None = None, opt_out_text: str | None = None) -> str:
    lines = ["", "--", settings.get("sender_name", "").strip(), settings.get("physical_address", "").strip(), "", (opt_out_text if opt_out_text is not None else settings.get("opt_out_text", "")).strip()]
    if token:
        lines += ["", f"Ref: {token}"]
    return "\n".join(x for x in lines if x is not None).rstrip() + "\n"


def validate_outbound(subject: str, body: str, settings: dict, allowed_urls: set[str], kind: str, prospect_domain: str = "", opt_out_text: str | None = None) -> list[str]:
    """Violations that must block a draft. Empty list = acceptable."""
    v: list[str] = []
    if not subject.strip() or "\n" in subject or len(subject) > 160:
        v.append("bad subject")
    if len(body) > 3200:
        v.append("too long")
    if kind in ("initial", "followup"):
        required_opt_out = (opt_out_text if opt_out_text is not None else settings.get("opt_out_text", "")).strip()
        if not required_opt_out or required_opt_out.lower() not in body.lower():
            v.append("missing opt-out sentence")
        if not settings.get("physical_address", "").strip() or settings["physical_address"].strip().lower() not in body.lower():
            v.append("missing postal address")
    if PRICE_IN_DRAFT.search(body):
        v.append("mentions price, discount, guarantee or free")
    m = FALSE_CLAIMS.search(body)
    if m:
        v.append(f"claims something we cannot verify: {m.group(0)!r}")
    allowed = {u.rstrip("/").lower() for u in allowed_urls}
    for u in URL.findall(body):
        host = re.sub(r"^https?://", "", u).split("/")[0].lower()
        if u.rstrip("/.,").lower() not in allowed and not (prospect_domain and (host == prospect_domain or host.endswith("." + prospect_domain))):
            v.append(f"link not on the approved list: {u[:60]}")
    return v
