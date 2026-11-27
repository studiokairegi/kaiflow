// Turns a database error into words a studio owner can act on. The UI branches on the stable V3xxx code, never on message text.
import { ERROR_CODES } from "../../contracts/index.js";

export const isProtectionBlock = (e) => e?.code === ERROR_CODES.PROTECTION_BLOCKED;
export const isNotAuthorized = (e) => e?.code === ERROR_CODES.NOT_AUTHORIZED;

const BY_CODE = {
  [ERROR_CODES.NOT_AUTHORIZED]: "You do not have permission to do this. Ask the studio owner.",
  [ERROR_CODES.PERIOD_LOCKED]: "That date is in a closed accounting period.",
  [ERROR_CODES.OVERPAYMENT]: "That is more than is owed.",
  [ERROR_CODES.INVOICE_STATE_INVALID]: "The invoice is not in a state where this can be done.",
  [ERROR_CODES.EMAIL_RECIPIENT_INVALID]: "There is no valid email address for the client.",
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: "This request was already sent with different details. Close this window and start again.",
  [ERROR_CODES.ORG_NOT_INITIALIZED]: "Finance has not been set up for this studio yet.",
  [ERROR_CODES.NOT_FOUND]: "That record could not be found. It may have been changed; refresh and try again.",
};
// Database messages for V3005..V3023 are written for users; any other message is replaced by a safe generic one.
export function friendlyError(e) {
  if (!e) return "Something went wrong.";
  const code = String(e.code || "");
  if (code === ERROR_CODES.PROTECTION_BLOCKED || code === ERROR_CODES.INVALID_INPUT) return e.message || "That was not accepted.";
  if (BY_CODE[code]) return code === ERROR_CODES.NOT_FOUND || code === ERROR_CODES.NOT_AUTHORIZED || code === ERROR_CODES.IDEMPOTENCY_CONFLICT ? BY_CODE[code] : (e.message || BY_CODE[code]);
  if (/^V3\d{3}$/.test(code)) return e.message || "That could not be done.";
  if (/network|fetch|failed to fetch|timeout/i.test(String(e.message || ""))) return "The connection failed. Check your internet and try again.";
  return "Something went wrong. Nothing was changed. Try again, and tell support if it keeps happening.";
}
