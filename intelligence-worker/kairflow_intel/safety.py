"""Fetching untrusted web pages safely, and turning them into plain text the pipeline can trust to be DATA."""
from __future__ import annotations

import ipaddress
import codecs
import re
import socket
import time
import urllib.robotparser
from urllib.parse import urljoin, urlparse

import requests
import urllib3
from requests.adapters import HTTPAdapter
from bs4 import BeautifulSoup, Comment

from .errors import PermanentError, TransientError



class _PinnedHTTPConnection(urllib3.connection.HTTPConnection):
    """Connect to a prevalidated IP instead of resolving the hostname again."""
    def __init__(self, *args, dns_pin: str, **kwargs):
        self.dns_pin = dns_pin
        super().__init__(*args, **kwargs)

    def _new_conn(self):
        return urllib3.util.connection.create_connection(
            (self.dns_pin, self.port), self.timeout, source_address=self.source_address,
            socket_options=self.socket_options,
        )


class _PinnedHTTPSConnection(urllib3.connection.HTTPSConnection):
    """IP-pinned TCP connection; inherited TLS setup retains original host for SNI/cert validation."""
    def __init__(self, *args, dns_pin: str, **kwargs):
        self.dns_pin = dns_pin
        super().__init__(*args, **kwargs)

    def _new_conn(self):
        return urllib3.util.connection.create_connection(
            (self.dns_pin, self.port), self.timeout, source_address=self.source_address,
            socket_options=self.socket_options,
        )


class _PinnedHTTPPool(urllib3.connectionpool.HTTPConnectionPool):
    ConnectionCls = _PinnedHTTPConnection


class _PinnedHTTPSPool(urllib3.connectionpool.HTTPSConnectionPool):
    ConnectionCls = _PinnedHTTPSConnection


class _PinnedPoolManager(urllib3.PoolManager):
    def __init__(self, dns_pin: str, **kwargs):
        # urllib3 2.x assigns pool_classes_by_scheme during PoolManager.__init__;
        # touching it before super().__init__ raises AttributeError. Override only
        # after the base manager has installed its version-specific defaults.
        super().__init__(dns_pin=dns_pin, **kwargs)
        self.pool_classes_by_scheme = dict(self.pool_classes_by_scheme)
        self.pool_classes_by_scheme["http"] = _PinnedHTTPPool
        self.pool_classes_by_scheme["https"] = _PinnedHTTPSPool
        # dns_pin is a connection-pool constructor kwarg, not part of urllib3's
        # PoolKey schema. Keep it out of the cache key normalizer while leaving it
        # in request_context so _new_pool passes it to the pinned pool class.
        for scheme in ("http", "https"):
            original_key_fn = self.key_fn_by_scheme[scheme]
            def without_dns_pin(context, key_fn=original_key_fn):
                clean = dict(context)
                clean.pop("dns_pin", None)
                return key_fn(clean)
            self.key_fn_by_scheme[scheme] = without_dns_pin


class _PinnedAdapter(HTTPAdapter):
    def __init__(self, dns_pin: str):
        self.dns_pin = dns_pin
        super().__init__()

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        self.poolmanager = _PinnedPoolManager(
            dns_pin=self.dns_pin, num_pools=connections, maxsize=maxsize, block=block,
            **pool_kwargs,
        )


ALLOWED_TYPES = ("text/html", "application/xhtml", "text/plain", "application/json", "application/xml", "text/xml", "application/rss", "application/atom")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63})+")
JUNK_EMAIL_TLD = {"png", "jpg", "jpeg", "gif", "webp", "svg", "css", "js"}


def is_public_ip(ip: str) -> bool:
    """Accept only globally routable unicast addresses (not merely non-private ones).

    In particular, shared address space (100.64.0.0/10), benchmarking and
    documentation ranges are not public destinations even though older
    ipaddress predicates did not classify all of them as private/reserved.
    """
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def assert_public_url(url: str, resolver=socket.getaddrinfo) -> list[str]:
    """SSRF guard: http(s) only, no credentials, every resolved address must be public."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise PermanentError(f"blocked url scheme: {url[:80]}")
    if p.username or p.password:
        raise PermanentError("blocked url with credentials")
    if p.port not in (None, 80, 443, 8080, 8443):
        raise PermanentError("blocked url port")
    try:
        infos = resolver(p.hostname, None)
    except socket.gaierror as exc:
        raise TransientError(f"dns failure for {p.hostname}") from exc
    addrs = {i[4][0] for i in infos}
    if not addrs or not all(is_public_ip(a) for a in addrs):
        raise PermanentError(f"blocked non-public address for {p.hostname}")
    return sorted(addrs)


class Fetcher:
    """Polite, bounded, robots-respecting fetcher. Redirects are followed manually and re-validated on every hop."""

    def __init__(self, cfg, session: requests.Session | None = None, resolver=socket.getaddrinfo,
                 sleep=time.sleep, clock=time.monotonic):
        self.cfg, self.s, self.resolver, self.sleep, self.clock = cfg, session or requests.Session(), resolver, sleep, clock
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._last_hit: dict[str, float] = {}

    def _pace(self, host: str) -> None:
        wait = self.cfg.per_host_delay - (self.clock() - self._last_hit.get(host, -1e9))
        if wait > 0:
            self.sleep(wait)
        self._last_hit[host] = self.clock()

    def _get_raw(self, url: str, accept_any_type: bool = False):
        for _ in range(5):
            validated = assert_public_url(url, self.resolver)
            self._pace(urlparse(url).hostname or "")
            try:
                if isinstance(self.s, requests.Session):
                    # Fresh direct session ensures the validated IP is the one used for TCP;
                    # TLS still validates against the original URL hostname.
                    pinned = requests.Session()
                    pinned.trust_env = False
                    pinned.mount("http://", _PinnedAdapter(validated[0]))
                    pinned.mount("https://", _PinnedAdapter(validated[0]))
                    try:
                        r = pinned.get(url, headers={"User-Agent": self.cfg.user_agent, "Accept": "text/html,*/*;q=0.5"},
                                       timeout=self.cfg.fetch_timeout, allow_redirects=False, stream=True)
                    finally:
                        # Attach ownership to response; close after body consumption.
                        pass
                    r._kairflow_pinned_session = pinned
                else:
                    r = self.s.get(url, headers={"User-Agent": self.cfg.user_agent, "Accept": "text/html,*/*;q=0.5"},
                                   timeout=self.cfg.fetch_timeout, allow_redirects=False, stream=True)
            except requests.RequestException as exc:
                raise TransientError(f"fetch failed: {exc}") from exc
            if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("Location"):
                url = urljoin(url, r.headers["Location"])
                r.close()
                owner = getattr(r, "_kairflow_pinned_session", None)
                if owner is not None:
                    owner.close()
                continue
            return url, r
        raise PermanentError("too many redirects")

    @staticmethod
    def _read_response(response, limit: int) -> bytes:
        """Read a bounded response body and normalize transport/read failures.

        With ``stream=True``, requests can raise timeouts after ``get()`` has
        returned, while the body is consumed. Those failures must enter the
        worker's transient retry path just like connection-time timeouts.
        """
        try:
            return response.raw.read(limit, decode_content=True)
        except (requests.RequestException, urllib3.exceptions.HTTPError, OSError) as exc:
            raise TransientError(f"response body read failed: {type(exc).__name__}") from exc

    def allowed_by_robots(self, url: str) -> bool:
        p = urlparse(url)
        origin = f"{p.scheme}://{p.netloc}"
        if origin not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                final_robots_url, r = self._get_raw(origin + "/robots.txt")
                if urlparse(final_robots_url).netloc.lower() != p.netloc.lower():
                    # A redirected robots document belongs to a different origin;
                    # don't apply it to this host. Fail closed for this origin.
                    self._robots[origin] = rp
                    rp.disallow_all = True
                    r.close()
                    owner = getattr(r, "_kairflow_pinned_session", None)
                    if owner is not None:
                        owner.close()
                    return False
                if r.status_code == 200:
                    rp.parse(self._read_response(r, 200_000).decode("utf-8", "replace").splitlines())
                    self._robots[origin] = rp
                elif 400 <= r.status_code < 500:
                    self._robots[origin] = None            # no robots.txt: allowed
                else:
                    self._robots[origin] = rp
                    rp.disallow_all = True                 # server error: be conservative
                r.close()
                owner = getattr(r, "_kairflow_pinned_session", None)
                if owner is not None:
                    owner.close()
            except (TransientError, PermanentError):
                rp.disallow_all = True
                self._robots[origin] = rp
        rp = self._robots[origin]
        return True if rp is None else rp.can_fetch(self.cfg.user_agent, url)

    def sitemaps(self, url: str) -> list[str]:
        """Sitemap URLs the site declares in robots.txt (empty if none)."""
        p = urlparse(url)
        self.allowed_by_robots(f"{p.scheme}://{p.netloc}/")
        rp = self._robots.get(f"{p.scheme}://{p.netloc}")
        try:
            return list(rp.site_maps() or []) if rp is not None else []
        except Exception:
            return []

    def fetch(self, url: str) -> tuple[str, str]:
        """Returns (final_url, html_or_text). Raises PermanentError if disallowed or unsuitable."""
        assert_public_url(url, self.resolver)
        if not self.allowed_by_robots(url):
            raise PermanentError(f"disallowed by robots.txt: {url[:100]}")
        final, r = self._get_raw(url)
        try:
            if r.status_code >= 500 or r.status_code == 429:
                raise TransientError(f"{r.status_code} from {urlparse(final).hostname}")
            if r.status_code >= 400:
                raise PermanentError(f"{r.status_code} from {urlparse(final).hostname}")
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype and not ctype.startswith(ALLOWED_TYPES):
                raise PermanentError(f"unsupported content type {ctype}")
            data = self._read_response(r, self.cfg.max_fetch_bytes + 1)
            if len(data) > self.cfg.max_fetch_bytes:
                data = data[: self.cfg.max_fetch_bytes]
            encoding = r.encoding or "utf-8"
            try:
                codecs.lookup(encoding)
            except (LookupError, TypeError):
                encoding = "utf-8"
            return final, data.decode(encoding, "replace")
        finally:
            r.close()
            owner = getattr(r, "_kairflow_pinned_session", None)
            if owner is not None:
                owner.close()


_HIDDEN_STYLE = re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0", re.I)


def html_to_text(html: str, limit: int = 60_000) -> str:
    """Visible text only. Scripts, styles, comments and visually hidden elements (a common place to hide
    prompt-injection text) are dropped."""
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "noscript", "template", "svg", "iframe"]):
        t.decompose()
    for c in soup.find_all(string=lambda s: isinstance(s, Comment)):
        c.extract()
    for t in soup.find_all(True):
        if t.attrs is None:
            continue
        if t.has_attr("hidden") or t.get("aria-hidden") == "true" or _HIDDEN_STYLE.search(t.get("style") or ""):
            t.decompose()
    text = re.sub(r"[ \t\r\f\v]+", " ", soup.get_text("\n"))
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    return text[:limit]


def extract_emails(html: str) -> list[dict]:
    """Business contact candidates found on a page: mailto links first, then visible text."""
    soup = BeautifulSoup(html, "lxml")
    found: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        if a["href"].lower().startswith("mailto:"):
            addr = a["href"][7:].split("?")[0].strip().lower()
            if EMAIL_RE.fullmatch(addr):
                found.setdefault(addr, "mailto")
    for m in EMAIL_RE.finditer(html_to_text(html)):
        found.setdefault(m.group(0).lower(), "text")
    return [{"email": e, "how": how} for e, how in found.items() if e.rsplit(".", 1)[-1] not in JUNK_EMAIL_TLD]


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def quote_in_text(quote: str, text: str, min_len: int = 12) -> bool:
    """A model-supplied quote counts as evidence only if it literally appears in the fetched text."""
    q = norm(quote)
    return len(q) >= min_len and q in norm(text)


def sentence_around(text: str, start: int, end: int, max_len: int = 240) -> str:
    a = max(text.rfind(".", 0, start), text.rfind("\n", 0, start), text.rfind("!", 0, start), text.rfind("?", 0, start)) + 1
    cands = [i for i in (text.find(".", end), text.find("\n", end), text.find("!", end), text.find("?", end)) if i != -1]
    b = (min(cands) + 1) if cands else len(text)
    s = text[a:b].strip()
    if len(s) > max_len:
        mid = start - a
        lo = max(0, mid - max_len // 2)
        s = s[lo: lo + max_len].strip()
    return s


class MeteredFetcher:
    """Wrap a safe Fetcher so every site-crawler operation reserves budget first.

    sitemaps() can trigger an internal robots.txt request, so it is metered too.
    """
    def __init__(self, fetcher, reserve):
        self._fetcher = fetcher
        self._reserve = reserve

    def fetch(self, url):
        if not self._reserve():
            raise PermanentError("site_crawler source is disabled, unconfirmed, over budget or circuit-open")
        return self._fetcher.fetch(url)

    def sitemaps(self, url):
        if not self._reserve():
            raise PermanentError("site_crawler source is disabled, unconfirmed, over budget or circuit-open")
        return self._fetcher.sitemaps(url)
