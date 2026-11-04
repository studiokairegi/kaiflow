"""Client for the few documented, programmatic APIs discovery uses. Separate from the page Fetcher on purpose: these endpoints are
APIs with their own published usage policies (descriptive User-Agent, rate limits), not pages to crawl. Only allowlisted hosts."""
from __future__ import annotations

import json
import socket
import time
from urllib.parse import urlencode, urlparse

import requests

from .errors import PermanentError, TransientError
from .safety import assert_public_url

API_HOSTS = {"query.wikidata.org", "www.wikidata.org", "graphql.anilist.co", "api.gdeltproject.org", "index.commoncrawl.org"}
MIN_GAP = {"api.gdeltproject.org": 5.5, "query.wikidata.org": 2.0, "www.wikidata.org": 1.0, "graphql.anilist.co": 2.0, "index.commoncrawl.org": 2.0}
MAX_BYTES = 6_000_000


class ApiClient:
    def __init__(self, cfg, session: requests.Session | None = None, resolver=socket.getaddrinfo, sleep=time.sleep, clock=time.monotonic):
        self.cfg, self.s, self.resolver, self.sleep, self.clock = cfg, session or requests.Session(), resolver, sleep, clock
        self._last: dict[str, float] = {}

    def _pace(self, host: str) -> None:
        wait = MIN_GAP.get(host, 2.0) - (self.clock() - self._last.get(host, -1e9))
        if wait > 0:
            self.sleep(wait)
        self._last[host] = self.clock()

    def _check(self, url: str) -> str:
        host = (urlparse(url).hostname or "").lower()
        if host not in API_HOSTS:
            raise PermanentError(f"{host or 'that host'} is not an approved API host")
        assert_public_url(url, self.resolver)
        self._pace(host)
        return host

    def _finish(self, r, host: str, text_ok: bool = False):
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientError(f"{host} returned {r.status_code}")
        if r.status_code >= 400:
            raise PermanentError(f"{host} returned {r.status_code}")
        body = r.content[:MAX_BYTES] if hasattr(r, "content") else b""
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError as exc:
            if text_ok:
                return {"_text": body.decode("utf-8", "replace")[:300]}
            raise TransientError(f"{host} did not return JSON (probably throttling): {body[:80]!r}") from exc

    def get_json(self, url: str, params: dict | None = None, accept: str = "application/json"):
        full = url + ("?" + urlencode(params) if params else "")
        host = self._check(full)
        try:
            r = self.s.get(full, headers={"User-Agent": self.cfg.user_agent, "Accept": accept}, timeout=self.cfg.fetch_timeout + 25, allow_redirects=False)
        except requests.RequestException as exc:
            raise TransientError(f"{host} unreachable: {exc}") from exc
        return self._finish(r, host)

    def get_ndjson(self, url: str, params: dict | None = None) -> list[dict]:
        """One JSON object per line (Common Crawl's CDX output). Bad lines are skipped, not trusted."""
        full = url + ("?" + urlencode(params) if params else "")
        host = self._check(full)
        try:
            r = self.s.get(full, headers={"User-Agent": self.cfg.user_agent, "Accept": "application/json"}, timeout=self.cfg.fetch_timeout + 45, allow_redirects=False)
        except requests.RequestException as exc:
            raise TransientError(f"{host} unreachable: {exc}") from exc
        if r.status_code == 404:
            return []
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientError(f"{host} returned {r.status_code}")
        if r.status_code >= 400:
            raise PermanentError(f"{host} returned {r.status_code}")
        rows = []
        for line in r.content[:MAX_BYTES].decode("utf-8", "replace").splitlines():
            try:
                v = json.loads(line)
            except ValueError:
                continue
            if isinstance(v, dict):
                rows.append(v)
        return rows

    def post_json(self, url: str, payload: dict):
        host = self._check(url)
        try:
            r = self.s.post(url, json=payload, headers={"User-Agent": self.cfg.user_agent, "Accept": "application/json"}, timeout=self.cfg.fetch_timeout + 25, allow_redirects=False)
        except requests.RequestException as exc:
            raise TransientError(f"{host} unreachable: {exc}") from exc
        return self._finish(r, host)
