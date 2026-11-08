"""Client for the few documented, programmatic APIs discovery uses. Separate from the page Fetcher on purpose: these endpoints are
APIs with their own published usage policies (descriptive User-Agent, rate limits), not pages to crawl. Only allowlisted hosts."""
from __future__ import annotations

import json
import socket
import time
from urllib.parse import urlencode, urlparse

import requests
import urllib3

from .errors import PermanentError, TransientError
from .safety import assert_public_url, _PinnedAdapter

API_HOSTS = {"query.wikidata.org", "www.wikidata.org", "graphql.anilist.co", "api.gdeltproject.org", "index.commoncrawl.org"}
MIN_GAP = {"api.gdeltproject.org": 5.5, "query.wikidata.org": 2.0, "www.wikidata.org": 1.0, "graphql.anilist.co": 2.0, "index.commoncrawl.org": 2.0}
MAX_BYTES = 6_000_000


class ApiClient:
    def __init__(self, cfg, session: requests.Session | None = None, resolver=socket.getaddrinfo, sleep=time.sleep, clock=time.monotonic):
        self.cfg, self._injected_session, self.resolver, self.sleep, self.clock = cfg, session is not None, resolver, sleep, clock
        self.s = session
        self._last: dict[str, float] = {}

    def _pace(self, host: str) -> None:
        wait = MIN_GAP.get(host, 2.0) - (self.clock() - self._last.get(host, -1e9))
        if wait > 0:
            self.sleep(wait)
        self._last[host] = self.clock()

    def _check(self, url: str) -> tuple[str, list[str]]:
        host = (urlparse(url).hostname or "").lower()
        if host not in API_HOSTS:
            raise PermanentError(f"{host or 'that host'} is not an approved API host")
        addresses = assert_public_url(url, self.resolver)
        self._pace(host)
        return host, addresses

    def _request(self, method: str, url: str, *, headers: dict, json_body=None, timeout=None):
        """Perform an API request against the exact public IPs validated above.

        Injected test sessions remain injectable; the production requests session is
        fresh, proxy-free and IP-pinned so requests cannot perform a second DNS lookup.
        Redirects are never followed for API endpoints.
        """
        host, addresses = self._check(url)
        owner = None
        if self._injected_session:
            session = self.s
        else:
            owner = requests.Session()
            owner.trust_env = False
            owner.mount("http://", _PinnedAdapter(addresses[0]))
            owner.mount("https://", _PinnedAdapter(addresses[0]))
            session = owner
        try:
            response = getattr(session, method.lower())(
                url, headers=headers, timeout=timeout or self.cfg.fetch_timeout + 25,
                allow_redirects=False, stream=True,
                **({"json": json_body} if json_body is not None else {}),
            )
            return response, owner, host
        except requests.RequestException as exc:
            if owner is not None:
                owner.close()
            raise TransientError(f"{host} unreachable: {type(exc).__name__}") from exc

    @staticmethod
    def _close(response, owner):
        try:
            response.close()
        except Exception:
            pass
        if owner is not None:
            owner.close()

    def _finish(self, r, host: str, text_ok: bool = False):
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientError(f"{host} returned {r.status_code}")
        if r.status_code >= 400:
            raise PermanentError(f"{host} returned {r.status_code}")
        try:
            if getattr(r, "raw", None) is not None:
                body = r.raw.read(MAX_BYTES + 1, decode_content=True)
            else:
                body = r.content[:MAX_BYTES + 1] if hasattr(r, "content") else b""
        except (requests.RequestException, urllib3.exceptions.HTTPError, OSError) as exc:
            raise TransientError(f"{host} response read failed: {type(exc).__name__}") from exc
        if len(body) > MAX_BYTES:
            raise PermanentError(f"{host} response exceeded the {MAX_BYTES}-byte limit")
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError as exc:
            if text_ok:
                return {"_text": body.decode("utf-8", "replace")[:300]}
            raise TransientError(f"{host} did not return JSON (probably throttling): {body[:80]!r}") from exc

    def get_json(self, url: str, params: dict | None = None, accept: str = "application/json"):
        full = url + ("?" + urlencode(params) if params else "")
        r, owner, host = self._request("get", full, headers={"User-Agent": self.cfg.user_agent, "Accept": accept})
        try:
            return self._finish(r, host)
        finally:
            self._close(r, owner)

    def get_ndjson(self, url: str, params: dict | None = None) -> list[dict]:
        """One JSON object per line (Common Crawl's CDX output). Bad lines are skipped, not trusted."""
        full = url + ("?" + urlencode(params) if params else "")
        r, owner, host = self._request("get", full, headers={"User-Agent": self.cfg.user_agent, "Accept": "application/json"}, timeout=self.cfg.fetch_timeout + 45)
        try:
            if r.status_code == 404:
                return []
            if r.status_code == 429 or r.status_code >= 500:
                raise TransientError(f"{host} returned {r.status_code}")
            if r.status_code >= 400:
                raise PermanentError(f"{host} returned {r.status_code}")
            try:
                body = r.raw.read(MAX_BYTES + 1, decode_content=True) if getattr(r, "raw", None) is not None else r.content[:MAX_BYTES + 1]
            except (requests.RequestException, urllib3.exceptions.HTTPError, OSError) as exc:
                raise TransientError(f"{host} response read failed: {type(exc).__name__}") from exc
            if len(body) > MAX_BYTES:
                raise PermanentError(f"{host} response exceeded the {MAX_BYTES}-byte limit")
            rows = []
            for line in body.decode("utf-8", "replace").splitlines():
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if isinstance(value, dict):
                    rows.append(value)
            return rows
        finally:
            self._close(r, owner)

    def post_json(self, url: str, payload: dict):
        r, owner, host = self._request("post", url, headers={"User-Agent": self.cfg.user_agent, "Accept": "application/json", "Content-Type": "application/json"}, json_body=payload)
        try:
            return self._finish(r, host)
        finally:
            self._close(r, owner)
