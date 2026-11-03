class TransientError(Exception):
    """Worth retrying later: network, 429/5xx, Ollama or Zoho temporarily down."""


class PermanentError(Exception):
    """Retrying cannot help: bad input, missing approved knowledge, policy refusal."""


class RpcError(Exception):
    def __init__(self, message: str, code: str = "", status: int = 0):
        super().__init__(message)
        self.code, self.status = code, status
