from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass
from urllib.parse import urlparse


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_anon_key: str
    agent_email: str
    agent_password: str
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen2.5:3b-instruct"
    ollama_fast_model: str = "qwen2.5:1.5b-instruct"
    gemini_api_key: str = ""            # optional; when set, Agent Chat and the routed call sites may use Gemini, always with Ollama as the fallback
    gemini_model: str = "gemini-3.8-flash"   # pinned stable ID (Phase 6); the old gemini-2.5-flash default is retired
    worker_id: str = ""
    poll_seconds: int = 15
    fetch_timeout: int = 15
    max_fetch_bytes: int = 1_500_000
    per_host_delay: float = 2.0
    contact_url: str = ""
    mail_provider: str = "none"       # adapter key; none is the fail-closed default
    mail_account_id: str = ""          # optional account selector during the staged dispatcher rollout
    ai_router: object = None           # airouter.RouterSettings; None means defaults (every call site stays on Ollama)

    @property
    def user_agent(self) -> str:
        tail = f" (+{self.contact_url})" if self.contact_url else ""
        return f"KairFlowResearchBot/1.0{tail}"


def _loopback_only(url: str) -> None:
    host = urlparse(url).hostname or ""
    try:
        addrs = {ipaddress.ip_address(a[4][0]) for a in socket.getaddrinfo(host, None)}
    except (socket.gaierror, ValueError) as exc:
        raise ConfigError(f"cannot resolve Ollama host {host!r}") from exc
    if not addrs or not all(a.is_loopback for a in addrs):
        raise ConfigError("Ollama must be reachable on a loopback address only (127.0.0.1); never expose it to the network")


def _gemini_chat_model(e) -> str:
    """Agent Chat model: the pinned default, or an exact ID the owner set explicitly. Never a floating alias."""
    import re
    from .airouter import DEFAULT_JSON_MODEL
    model = (e.get("KAIRFLOW_GEMINI_MODEL") or DEFAULT_JSON_MODEL).strip()
    if not re.fullmatch(r"gemini-[a-z0-9][a-z0-9.\-]{1,60}", model) or "latest" in model:
        raise ConfigError("KAIRFLOW_GEMINI_MODEL must be an exact Gemini model ID such as gemini-3.8-flash (no 'latest' alias)")
    return model


def load(env: dict | None = None) -> Config:
    e = os.environ if env is None else env

    def need(name: str) -> str:
        v = (e.get(name) or "").strip()
        if not v:
            raise ConfigError(f"missing environment variable {name}")
        return v

    password = (e.get("KAIRFLOW_AGENT_PASSWORD") or "").strip()
    if not password:
        try:  # optional Windows Credential Manager support
            import keyring  # type: ignore

            password = keyring.get_password("kairflow-intelligence", need("KAIRFLOW_AGENT_EMAIL")) or ""
        except Exception:
            password = ""
    if not password:
        raise ConfigError("agent password not set (KAIRFLOW_AGENT_PASSWORD or Windows Credential Manager)")

    gemini_key = (e.get("KAIRFLOW_GEMINI_API_KEY") or "").strip()
    if not gemini_key:
        try:  # optional Windows Credential Manager support, same pattern as the agent password
            import keyring  # type: ignore

            gemini_key = (keyring.get_password("kairflow-intelligence-gemini", "api-key") or "").strip()
        except Exception:
            gemini_key = ""

    from .airouter import settings_from_env
    try:
        ai_router = settings_from_env(e)
    except ValueError as exc:
        raise ConfigError(str(exc)) from None

    cfg = Config(
        supabase_url=need("KAIRFLOW_SUPABASE_URL").rstrip("/"),
        supabase_anon_key=need("KAIRFLOW_SUPABASE_ANON_KEY"),
        agent_email=need("KAIRFLOW_AGENT_EMAIL"),
        agent_password=password,
        ollama_url=(e.get("KAIRFLOW_OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/"),
        ollama_model=e.get("KAIRFLOW_OLLAMA_MODEL") or "qwen2.5:3b-instruct",
        ollama_fast_model=e.get("KAIRFLOW_OLLAMA_FAST_MODEL") or "qwen2.5:1.5b-instruct",
        gemini_api_key=gemini_key,
        gemini_model=_gemini_chat_model(e),
        worker_id=e.get("KAIRFLOW_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}",
        poll_seconds=int(e.get("KAIRFLOW_POLL_SECONDS") or 15),
        contact_url=e.get("KAIRFLOW_CONTACT_URL") or "",
        mail_provider=(e.get("KAIRFLOW_MAIL_PROVIDER") or "none").strip().lower(),
        mail_account_id=(e.get("KAIRFLOW_MAIL_ACCOUNT_ID") or "").strip(),
        ai_router=ai_router,
    )
    if cfg.mail_provider != "none" and (not cfg.mail_provider or len(cfg.mail_provider) > 64 or
            not cfg.mail_provider.replace("-", "").replace("_", "").isalnum()):
        raise ConfigError("KAIRFLOW_MAIL_PROVIDER must be a normalized adapter identifier")
    if cfg.mail_provider != "none":
        # Validate against reviewed, code-installed adapters rather than a fixed provider enum.
        from .providers import build_registry, ProviderNotInstalled
        registry = build_registry()
        try:
            manifest = registry.manifest(cfg.mail_provider)
        except ProviderNotInstalled as exc:
            raise ConfigError(str(exc)) from exc
        if manifest.account_selection_required and not cfg.mail_account_id:
            raise ConfigError(f"KAIRFLOW_MAIL_ACCOUNT_ID is required for {cfg.mail_provider}")
    if not cfg.supabase_url.startswith("https://"):
        raise ConfigError("KAIRFLOW_SUPABASE_URL must be https")
    _loopback_only(cfg.ollama_url)
    return cfg
