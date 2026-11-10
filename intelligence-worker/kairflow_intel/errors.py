class TransientError(Exception):
    """Worth retrying later: network, 429/5xx, Ollama or a mail provider temporarily unavailable."""


class InvalidModelOutput(TransientError):
    """The model answered but not in the required shape. A TransientError (existing handlers keep working), yet retrying the same temperature-0
    request cannot help, so callers that must not loop on one poison message (classification) treat it differently from an outage."""


class PermanentError(Exception):
    """Retrying cannot help: bad input, missing approved knowledge, policy refusal."""


class RpcError(Exception):
    def __init__(self, message: str, code: str = "", status: int = 0):
        super().__init__(message)
        self.code, self.status = code, status


class MailRejected(Exception):
    """The mail provider definitively refused the request (4xx). The message was NOT sent."""


class ThreadingRejected(MailRejected):
    """A provider refused native reply threading; never downgrade to an unthreaded send."""
