"""Deterministic policy. These rules run BEFORE and AFTER the model and cannot be argued with by an email or a web page."""
from __future__ import annotations

import re

I = re.I | re.U

UNSUBSCRIBE = re.compile(
    r"\bunsubscribe\b|remove me|take me off|do not contact|don'?t contact|do not email|"
    r"stop (e-?mailing|contacting|sending|writing)|no more e-?mails?|opt[- ]?out|"
    r"配信停止|配信を停止|送らないで|もう送らないで|"
    r"今後(?:の)?(?:メール|連絡|案内|ご案内)[^。！？!?\n]{0,12}(?:不要|必要ありません|結構です|控えて)|"
    r"(?:(?:営業)?メール(?!で(?!の)|にて)|案内|ご案内)[^。！？!?\n]{0,10}(?:不要|必要ありません|(?<!で)結構です)|"
    r"連絡不要|案内不要|メール不要|もう不要|今後[^。！？!?\n]{0,16}(?:連絡|メール|案内|営業)[^。！？!?\n]{0,12}(?:不要|ご遠慮|控えて)|"
    r"(?:今後の)?(?:ご連絡|連絡|メール|営業メール|ご案内|案内)[^。！？!?\n]{0,16}(?:ご遠慮ください|遠慮してください|お控えください|控えてください)|"
    r"(?:メール|配信|案内|営業メール)[^。！？!?\n]{0,12}(?:停止して|止めて|送信しないで)|"
    r"(?:営業メール|メール|ご案内|案内|ご連絡|連絡)[^。！？!?\n]{0,24}(?:お送り|送信|配信)[^。！？!?\n]{0,16}(?:いただく必要はございません|いただかなくて結構です)|"
    r"(?:今後|これ以上)[^。！？!?\n]{0,12}(?:連絡|メール|案内)[^。！？!?\n]{0,12}(?:しないで|不要)|"
    r"(?:連絡|メール|案内)[^。！？!?\n]{0,12}(?:しないでください|しないようお願いします)|"
    r"(?:営業メール|メール(?!で(?!の)|にて)|ご案内)[^。！？!?\n]{0,12}(?:(?<!で)結構です|不要です|必要ありません|必要ございません)|"
    r"メールでの(?:ご)?(?:連絡|案内|営業)は(?:結構|不要|ご遠慮)", I)

NON_EMAIL_UNSUBSCRIBE_CONTEXT = re.compile(r"(?:アカウント|権限|利用制限|アクセス制限).{0,12}解除|解除.{0,12}(?:アカウント|権限|利用制限|アクセス制限)", I)
COMPLAINT = re.compile(r"\bspam\b|report (you|this)|unsolicited|\bgdpr\b|\bccpa\b|how did you (get|find) my|remove my data|delete my data|legal action|harass|迷惑メール|苦情|クレーム|返金|不誠実|個人情報を削除|法的措置", I)
CLASS_PATTERNS = {
    "pricing": re.compile(r"\b(price|prices|pricing|quote|quotation|rates?|costs?|budget|how much|fees?|estimate|per (second|minute|frame))\b|[$€£¥]\s?\d|\d\s?(usd|eur|jpy|gbp)\b|料金|価格|単価|見積|費用|予算|報酬", I),
    "negotiation": re.compile(r"discount|negotiat|counter ?offer|lower (the )?price|payment terms?|\bnet ?\d{2}\b|deposit|upfront|invoice|revenue share|royalt|値引|値下げ|条件交渉|支払条件|報酬条件|単価交渉|請求書?|お支払い|支払い", I),
    "contract": re.compile(r"\bcontract\b|agreement|\bnda\b|non-?disclosure|terms and conditions|\blegal\b|契約|秘密保持|合意書|契約書|利用条件|保証|確約", I),
    "deadline": re.compile(r"deadline|\bby (monday|tuesday|wednesday|thursday|friday|next week|end of)\b|\basap\b|urgent|due date|delivery date|turnaround|納期|締め切り|締切|期限|納品日|納品時期|納品予定|納品可能|納品できますか|までに納品|納入日|納入時期|納入できますか|いつまで|いつ頃(?:まで|に)?|何日(?:まで|以内)?|何週間|完了予定", I),
    "availability": re.compile(r"availab|capacity|\bslots?\b|when can you start|how many animators|bandwidth|current(ly)? booked|空き|スケジュール|いつから|対応できますか|対応可能|制作可能|稼働状況|稼働|着手|開始時期|作業開始|人員体制|何名|人数", I),
    "meeting": re.compile(
        # English: require an explicit action to arrange, hold, or attend a call/meeting.
        r"\b(?:could we|can we|would you|could you)\s+(?:(?:please|mind)\s+)*(?:schedul(?:e|ing)|book(?:ing)?|set(?:ting)? up|arrang(?:e|ing)|organiz(?:e|ing)|hold|have|join|attend)\b.{0,48}\b(?:call|meeting|zoom|google meet|teams)\b"
        r"|\b(?:schedule|book|set up|arrange|organize|hold)\s+(?:a|the|our|an)\s+(?:call|meeting|zoom|google meet|teams)\b"
        r"|\b(?:let'?s|let us)\s+(?:meet|schedule|book|set up|arrange|organize)\b"
        r"|\b(?:would you be|are you)\s+available\s+for\s+(?:a|the|our)\s+(?:call|meeting|zoom|google meet|teams)\b"
        r"|\b(?:join|attend)\s+(?:a|the|our)\s+(?:call|meeting)\b"
        # Explicitly finding time to speak is a scheduling request, even without the word meeting.
        r"|\b(?:could we|can we|would you|could you)\s+(?:(?:please|mind)\s+)*(?:find|make)\s+(?:a|some)\s+time\s+to\s+(?:talk|speak|chat|meet)\b"
        r"|\b(?:find|make)\s+(?:a|some)\s+time\s+to\s+(?:talk|speak|chat|meet)\b.{0,32}\b(?:next week|this week|tomorrow|on \w+)\b"
        # Japanese: pair the meeting noun directly with an arrangement action.
        # This deliberately excludes requests to send/share meeting documents.
        r"|(?:打ち合わせ|打合せ|お打ち合わせ|お打合せ|ミーティング|面談|会議|お電話|電話)"
        r"(?:を|の機会を|について)?(?:お願い|設定|調整|開催|実施|できます(?:でしょうか|か)|できませんか|しませんか|したい|させて)"
        r"|(?:お電話|電話).{0,12}お話し?できます(?:でしょうか|か)"
        # Requests to provide or decide a meeting time/date are explicit scheduling actions.
        r"|(?:打ち合わせ|打合せ|お打ち合わせ|お打合せ|ミーティング|面談|会議).{0,8}(?:の)?(?:お時間|時間|日時|日程).{0,16}(?:いただけ|頂け|もらえ|ください|お願い|決めたい|決めましょう|調整したい)"
        r"|(?:打ち合わせ|打合せ|お打ち合わせ|お打合せ|ミーティング|面談|会議).{0,8}(?:の)?(?:日時|日程).{0,12}(?:を)?(?:決めたい|決めましょう|調整したい|調整しましょう)"
        r"|(?:日程|候補日|候補日時|候補日程).{0,16}(?:調整をお願い|教えてください|お知らせください|ご提示ください|いただけますか|頂けますか)"
        r"|(?:来週|今週|再来週|近日).{0,16}(?:候補日|候補日時|日程).{0,12}(?:教えて|お知らせ|ご提示|いただけ|頂け)"
        r"|(?:ご都合の良い|ご都合のよい).{0,16}(?:日時|日程).{0,12}(?:教えて|お知らせ|ご提示|いただけ|頂け)"
        r"|会議.{0,8}(?:を)?(?:設定|調整|開催|実施).{0,8}(?:できます(?:でしょうか|か)|お願い)|(?:設定|調整|開催).{0,8}会議.{0,8}(?:できます(?:でしょうか|か)|お願い)", I),
    "portfolio": re.compile(r"portfolio|showreel|reel|samples?|previous work|examples? of|work samples|ポートフォリオ|実績", I),
    "interest": re.compile(r"interested|sounds (good|great|interesting)|love to|tell me more|more (info|information|details)|we('| a)?re looking|we need|yes[,.! ]|please send|ぜひ|興味", I),
    "decline": re.compile(r"not interested|no thank|no, thanks|not (looking|needed|required)|we (already|don'?t)|pass on this|not at this time|not a fit|(?<!で)結構です|間に合って|"
        r"今回は.{0,12}(?:見送らせて|辞退させて|遠慮させて)|"
        r"(?:現時点|現在|今のところ).{0,12}(?:検討しておりません|予定はありません|考えておりません)|"
        r"今回は(?:対応|参加|依頼).{0,8}(?:いたしかねます|できかねます|難しいです)|"
        r"(?:必要ありません|予定しておりません|考えていません)", I),
}
OOO = re.compile(r"out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on (annual )?leave|away from (my )?(email|desk)|will (be )?(back|return) on|自動返信|不在", I)
BOUNCE_FROM = re.compile(r"^(mailer-daemon|postmaster|mail delivery subsystem)@", I)
BOUNCE_SUBJ = re.compile(r"undeliver|delivery status notification|delivery (has )?failed|failure notice|returned mail|could not be delivered|mail delivery failed|配信できません", I)
PERMANENT = re.compile(r"\b550\b|\b5\.\d\.\d\b|user unknown|no such user|does not exist|mailbox (not found|unavailable)|address rejected|unknown recipient|recipient address rejected", I)
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63})+")
URL = re.compile(r"https?://[^\s<>\")\]]+", I)
MAX_BODY_CHARS = 3200   # single limit shared with drafting.compose_english (footer included)
PRICE_IN_DRAFT = re.compile(r"[$€£¥]\s?\d|\d\s?(usd|eur|gbp|jpy)\b|\bper (second|minute|frame|hour)\b|\bdiscount\b|\bfree (?:of charge|trial|quote|estimate|sample|samples|test|consultation|pilot|revision|revisions|work)\b|\bfor free\b|\bat no (?:cost|charge)\b|\bcomplimentary\b|\bgratis\b|\bguarantee", I)
PRICE_IN_DRAFT_JA = re.compile(
    r"料金|価格|費用|見積|割引|値引|無料|無償|保証|必ず成功|格安|低価格|お安く|ご予算|予算|相場|単価|"
    r"[0-9０-９][0-9０-９,，.．]*\s*(?:万|千)?\s*円|[一二三四五六七八九十百千万]+円|[￥¥＄$€£]\s*[0-9０-９]|"
    r"[0-9０-９][0-9０-９,，.．]*\s*(?:万|千)?\s*(?:ドル|ユーロ|ポンド|USD|JPY|EUR)|(?:円|ドル)から(?:承|お受け|対応|ご提供)", re.I)
# Claims of contact, experience or interest that nothing in the research supports (Japanese counterpart of FALSE_CLAIMS).
FALSE_CLAIMS_JA = re.compile(
    r"お会いした|お目にかかった|お打ち合わせの際|お打合せの際|お電話の際|お話しした|お話ししました|お話しさせていただいた|"
    r"ご紹介(?:いただ|頂)|(?:ゲーム|作品|タイトル|映像|トレーラー|PV)[をも]?(?:実際に)?(?:プレイ|試遊|視聴|拝聴|遊ば|遊び)|"
    r"プレイ(?:し|いた)|試遊|視聴(?:し|いた)|拝聴(?:し|いた)|遊ばせていただ|"
    r"ご関心をお持ち|ご興味をお持ち|お問い合わせ(?:いただ|頂)|ご依頼(?:いただ|頂)|ご連絡(?:いただ|頂)きありがとう")
# Only a first email can be wrong to refer back to an earlier exchange; follow-ups legitimately do.
PRIOR_CONTACT_JA_INITIAL = re.compile(r"先日|先般|過日|このあいだ|この間|先ほど|いつもお世話|お世話になっ|ご返信ありがとう|前回")
FALSE_CLAIMS = re.compile(r"\b(we (have )?(played|watched|reviewed|tested|read|studied)|as we discussed|following up on our (call|conversation|meeting)|you('| a)?re (already )?(a )?(client|customer)|referred by|(mutual|common) (friend|connection)|i saw you at|we met)\b", I)

ESCALATE_CLASSES = {"pricing", "negotiation", "contract", "deadline", "availability", "complaint", "ambiguous", "meeting_request", "project_opportunity", "negotiation"}


def normalize_quotes(text: str) -> str:
    """Curly quotes are what phone and Outlook clients type; the patterns below use straight ones."""
    return (text or "").translate({0x2018: "'", 0x2019: "'", 0x02BC: "'", 0x201C: '"', 0x201D: '"'})


_OUTLOOK_SEP = re.compile(
    r"^\s*(?:-{2,}\s*(?:original message|元のメッセージ|転送(?:された)?メッセージ|原文)\s*-{0,}|_{5,}|from:\s|sent:\s"
    r"|(?:差出人|送信者|送信元|送信日時|宛先|件名)\s*[:：])", I)
_ATTRIBUTION = re.compile(r"^\s*on .{5,200} wrote:\s*$", I)
# Japanese attribution lines introduce quoted history even when the client does not prefix it with ">":
# once new text exists above them, everything after is our own quoted mail.
_JA_ATTRIBUTION = re.compile(
    r"^\s*(?:.{1,120}(?:は|が)書きました[:：]"                                               # Apple Mail / Thunderbird
    r"|\d{4}[年/.\-]\s*\d{1,2}[月/.\-].{0,80}<[^<>\s]+@[^<>\s]+>.{0,12}[:：]"           # Gmail: 2026年11月8日(日) 10:00 Name <a@b>:
    r"|\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}.{0,40}のメール[:：])\s*$", I)


def first_unquoted(body: str) -> str:
    """The sender's own new words, whether they reply above OR below the quoted history.

    Drops quoted lines (">"), "On ... wrote:" headers and quoted-header blocks. An Outlook-style separator ends
    the text only when new text already sits above it; otherwise the reply was written below the quote and is
    kept. (Stopping at the first quote marker made a bottom-posted reply read as empty, so pricing, unsubscribe
    and complaint words in it were missed.)"""
    out: list[str] = []
    for line in (body or "").splitlines():
        if _OUTLOOK_SEP.match(line) or _JA_ATTRIBUTION.match(line):
            if "\n".join(out).strip():
                break
            continue
        if re.match(r"^\s*>", line) or _ATTRIBUTION.match(line):
            continue
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
    text = normalize_quotes(f"{subject}\n{first_unquoted(body)}")
    hits = {k for k, p in CLASS_PATTERNS.items() if p.search(text)}
    if "decline" in hits:   # "not interested" must not also count as interest
        if not CLASS_PATTERNS["interest"].search(CLASS_PATTERNS["decline"].sub(" ", text)):
            hits.discard("interest")
    if UNSUBSCRIBE.search(text):
        hits.add("unsubscribe")
    if NON_EMAIL_UNSUBSCRIBE_CONTEXT.search(text):
        hits.add("ambiguous")
    if COMPLAINT.search(text):
        hits.add("complaint")
    return {"hits": hits}


def hard_class(hits: set[str]) -> str | None:
    for c in ("unsubscribe", "complaint", "contract", "negotiation", "pricing", "deadline", "meeting", "availability", "ambiguous"):
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
    if len(body) > MAX_BODY_CHARS:
        v.append("too long")
    if kind in ("initial", "followup"):
        required_opt_out = (opt_out_text if opt_out_text is not None else settings.get("opt_out_text", "")).strip()
        if not required_opt_out or required_opt_out.lower() not in body.lower():
            v.append("missing opt-out sentence")
        if not settings.get("physical_address", "").strip() or settings["physical_address"].strip().lower() not in body.lower():
            v.append("missing postal address")
    if PRICE_IN_DRAFT.search(body):
        v.append("mentions price, discount, guarantee or free offer")
    if PRICE_IN_DRAFT_JA.search(body):
        v.append("mentions price, discount, guarantee or free offer (Japanese)")
    mj = FALSE_CLAIMS_JA.search(body) or (PRIOR_CONTACT_JA_INITIAL.search(body) if kind == "initial" else None)
    if mj:
        v.append(f"claims prior contact or experience we cannot verify: {mj.group(0)!r}")
    m = FALSE_CLAIMS.search(body)
    if m:
        v.append(f"claims something we cannot verify: {m.group(0)!r}")
    allowed = {u.rstrip("/").lower() for u in allowed_urls}
    for u in URL.findall(body):
        host = re.sub(r"^https?://", "", u).split("/")[0].lower()
        if u.rstrip("/.,").lower() not in allowed and not (prospect_domain and (host == prospect_domain or host.endswith("." + prospect_domain))):
            v.append(f"link not on the approved list: {u[:60]}")
    return v
