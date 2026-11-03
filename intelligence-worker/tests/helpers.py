from types import SimpleNamespace

CFG = SimpleNamespace(user_agent="KairFlowResearchBot/1.0", fetch_timeout=5, max_fetch_bytes=50_000, per_host_delay=0.0,
                      worker_id="w1", poll_seconds=1, supabase_url="https://x.supabase.co", supabase_anon_key="anon",
                      ollama_url="http://127.0.0.1:11434", ollama_model="m", ollama_fast_model="f")

PUBLIC = lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))]


def resolver_for(mapping):
    def r(host, port):
        if host not in mapping:
            import socket
            raise socket.gaierror(host)
        return [(2, 1, 6, "", (ip, 0)) for ip in mapping[host]]
    return r


class Raw:
    def __init__(self, data): self.data = data
    def read(self, n, decode_content=True): return self.data[:n]


class Resp:
    def __init__(self, status=200, body=b"", headers=None):
        self.status_code, self.headers, self.raw, self.encoding, self.content, self.text = status, headers or {"Content-Type": "text/html"}, Raw(body), "utf-8", body, body.decode("utf-8", "replace")
    def close(self): pass
    def json(self): import json; return json.loads(self.text)


class FakeSession:
    def __init__(self, routes): self.routes, self.calls = routes, []
    def get(self, url, **kw):
        self.calls.append(url)
        r = self.routes.get(url)
        if r is None: return Resp(404)
        return r(url) if callable(r) else r
