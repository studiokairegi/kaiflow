"""Deterministic prospect contactability assessment.

A published address is evidence that an address was listed, not proof that the
mailbox exists or accepts mail. No SMTP probing or fabricated verification is
performed here. A Pass requires documented human confirmation or positive
provider delivery evidence, plus provenance and an association with the
prospect's official domain. The indie campaign can separately opt into a documented
personal-mailbox affiliation path; other campaigns retain the domain requirement.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from urllib.parse import urlparse

LOCAL_ATOM = r"[A-Z0-9!#$%&'*+/=?^_`{|}~-]+"
PERSONAL_EMAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
    "proton.me", "protonmail.com", "pm.me", "icloud.com", "me.com", "mac.com",
    "yahoo.com", "yahoo.co.uk", "yahoo.co.jp", "aol.com", "fastmail.com", "hey.com",
})

EMAIL_RE = re.compile(r"^" + LOCAL_ATOM + r"(?:\." + LOCAL_ATOM + r")*@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$", re.I)


def _host(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw if "://" in raw else "//" + raw)
    return (parsed.hostname or "").lower().rstrip(".")


def _same_domain(host: str, domain: str) -> bool:
    return bool(host and domain and (host == domain or host.endswith("." + domain)))


def assess(*, email: str = "", official_domain: str = "", source_url: str = "",
           verification: str = "", verified_email: str = "", employee_affiliation: bool = False,
           delivery_evidence: str = "", bounced: bool = False, complained: bool = False,
           contact_form_only: bool = False, suppressed: bool = False, suppression_reason: str = "",
           affiliation_evidence: str = "", affiliation_source_url: str = "", contact_name: str = "",
           allow_personal_email: bool = False) -> dict:
    """Return {status: pass|needs_review|rejected, reason, evidence}.

    `verification=human_confirmed` is trusted only when it refers to this exact
    address. `delivery_evidence=delivered` is trusted only when supplied by an
    authoritative provider event processor. The caller owns that provenance.
    """
    address = str(email or "").strip().lower()
    evidence = {"syntax_valid": False, "source_url": str(source_url or ""),
                "official_domain_associated": False, "employee_affiliation": bool(employee_affiliation),
                "deliverability": "unknown", "bounce": bool(bounced), "complaint": bool(complained)}
    if suppressed:
        return {"status": "rejected", "reason": suppression_reason or "email or domain is suppressed", "evidence": evidence}
    if bounced or complained:
        return {"status": "rejected", "reason": "address has a bounce or complaint record", "evidence": evidence}
    if not address:
        reason = "contact form only; no acceptable business email" if contact_form_only else "no email address found"
        return {"status": "rejected", "reason": reason, "evidence": evidence}
    if len(address) > 254 or not EMAIL_RE.fullmatch(address) or len(address.split("@")[0]) > 64:
        return {"status": "rejected", "reason": "email syntax is invalid", "evidence": evidence}
    evidence["syntax_valid"] = True
    domain = str(official_domain or "").lower().strip().rstrip(".")
    email_domain = address.rsplit("@", 1)[1]
    source_host = _host(source_url)
    source_is_official = _same_domain(source_host, domain)
    if allow_personal_email:
        source_parsed = urlparse(source_url if "://" in source_url else ("https://" + source_url if source_url else ""))
        source_is_official = bool(source_is_official and source_parsed.scheme in ("http", "https") and source_host and "." in source_host)
    domain_associated = bool(domain and (email_domain == domain or email_domain.endswith("." + domain)))
    evidence["official_domain_associated"] = domain_associated
    evidence["personal_email_domain"] = email_domain in PERSONAL_EMAIL_DOMAINS
    evidence["source_is_official"] = source_is_official
    evidence["source_url"] = source_url or (affiliation_source_url if allow_personal_email else "") or ""
    if allow_personal_email and not evidence["source_url"]:
        return {"status": "needs_review", "reason": "indie contact requires a source URL documenting the developer/email association", "evidence": evidence}
    if delivery_evidence == "delivered":
        evidence["deliverability"] = "provider_delivered"
    elif verification == "human_confirmed" and verified_email.strip().lower() == address:
        evidence["deliverability"] = "human_confirmed"

    # Employee affiliation permits a third-party *source*, but never waives
    # association between the address and the prospect's official business domain.
    # Keep the two independent facts separate so a personal mailbox cannot pass
    # merely because a caller asserts that its owner is an employee.
    employee_path = bool(employee_affiliation)
    # Personal mailbox providers are accepted only with documented developer
    # affiliation. A bare boolean is not evidence: require a source URL and a
    # factual snippet that names the address or links the named contact to the
    # developer/studio. An address published on the developer's own site is
    # also an explicit association, even when the mailbox is Gmail/Proton/etc.
    affiliation_text = str(affiliation_evidence or "").strip()
    affiliation_host = _host(affiliation_source_url)
    affiliation_parsed = urlparse(affiliation_source_url if "://" in affiliation_source_url else "https://" + affiliation_source_url)
    affiliation_source_valid = bool(affiliation_host and "." in affiliation_host and affiliation_parsed.scheme in ("http", "https"))
    exact_address_in_evidence = address in affiliation_text.lower()
    named_contact_linked = bool(contact_name and contact_name.casefold() in affiliation_text.casefold()
                                 and re.search(r"developer|creator|founder|owner|director|team|member|studio|independent", affiliation_text, re.I))
    personal_affiliation = bool(allow_personal_email and email_domain in PERSONAL_EMAIL_DOMAINS and (
        (source_is_official and (verified_email.strip().lower() == address or verification == "human_confirmed"))
        or (employee_path and affiliation_source_valid and (exact_address_in_evidence or named_contact_linked))
    ))
    evidence["personal_email_affiliation_documented"] = personal_affiliation
    if not source_is_official and not employee_path and not personal_affiliation:
        return {"status": "needs_review", "reason": "email source is not proven to be the prospect's official website and developer affiliation is not established", "evidence": evidence}
    if not domain_associated and not personal_affiliation:
        return {"status": "needs_review", "reason": "email address is not associated with the developer's official domain or documented personal-email affiliation", "evidence": evidence}
    if evidence["deliverability"] == "unknown":
        return {"status": "needs_review", "reason": "published address found, but mailbox deliverability is unverified", "evidence": evidence}
    reason = ("personal developer email with documented affiliation and deliverability evidence" if personal_affiliation
              else "employee business email with documented affiliation and deliverability evidence"
              if employee_path and not source_is_official
              else "official-domain contact with documented deliverability evidence")
    # Evidence freshness is enforced again by the database final-send gate.
    # Bind the assessment to this exact normalized address and record UTC time.
    return {"status": "pass", "reason": reason, "evidence": evidence,
            "verified_email": address,
            "verified_at": datetime.now(timezone.utc).isoformat()}
