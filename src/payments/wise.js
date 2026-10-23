// Wise / M-PESA manual transfer helpers (pure). Mirrors payments_normalize_phone in the migration; the
// database re-validates everything, so this is for fast feedback and for tests.
// Facts below come from Wise's own help pages (checked for this change): KES can be sent to M-Pesa wallets in
// Kenya; Wise asks for the recipient's full name, mobile provider and number starting 254; Wise limits an
// M-Pesa transfer to 250,000 KES (500,000 KES per day); a payment reference typed in Wise does NOT reach an
// M-Pesa recipient. Wise's fee and exchange rate are shown by Wise at send time and are never guessed here.

export function normalizePhone(callingCode, phone) {
  const code = String(callingCode ?? "").replace(/[\s-]/g, "");
  if (!/^\+[1-9]\d{0,3}$/.test(code)) return null;
  const raw = String(phone ?? "").replace(/[\s().-]/g, "");
  let out;
  if (/^\+/.test(raw)) out = raw;
  else if (/^00/.test(raw)) out = `+${raw.slice(2)}`;
  else if (/^0/.test(raw)) out = code + raw.slice(1);
  else if (/^\d+$/.test(raw) && raw.startsWith(code.slice(1))) out = `+${raw}`;   // already carries the code, minus "+"
  else if (/^\d+$/.test(raw)) out = code + raw;
  else return null;
  if (!/^\+[1-9]\d{7,14}$/.test(out)) return null;
  if (out.startsWith("+254") && !/^\+254[17]\d{8}$/.test(out)) return null;       // Kenyan mobile numbers only
  return out;
}

export function validateWiseSettings(s = {}) {
  const errors = {};
  const name = String(s.recipient_name || "").trim();
  const country = String(s.country || "").trim();
  const mobile = String(s.mobile_provider || "").trim();
  const calling = String(s.calling_code || "+254").trim();
  const phone = normalizePhone(calling, s.phone);
  if (!name) errors.recipient_name = "Enter the recipient's full name exactly as registered on M-PESA.";
  if (!country) errors.country = "Enter the recipient's country.";
  if (!mobile) errors.mobile_provider = "Enter the mobile money provider (for example M-PESA).";
  if (!/^\+[1-9]\d{0,3}$/.test(calling.replace(/[\s-]/g, ""))) errors.calling_code = "Use a country code like +254.";
  if (!String(s.phone || "").trim()) errors.phone = "Enter the M-PESA number.";
  else if (!phone) errors.phone = "That is not a valid mobile number for this country code.";
  const complete = Object.keys(errors).length === 0;
  return { ok: complete, complete, errors, normalizedPhone: phone };
}

// Shown to the client only when the server says Wise is enabled AND complete.
export const isWiseOffered = (methods = []) => methods.some((m) => m.provider === "wise" && m.enabled);

// Wise must be last in the list of methods; everything else keeps its relative order.
export const orderMethods = (methods = []) => [...methods.filter((m) => m.provider !== "wise"), ...methods.filter((m) => m.provider === "wise")];

export function wiseInstructions(t) {
  const steps = [
    "Open Wise (website or app) and choose Send money.",
    `Set the recipient's country to ${t.country} and choose Mobile wallet, then ${t.mobile_provider}. The amount delivered is in Kenyan shillings (KES).`,
    `Enter the recipient exactly as shown below: name ${t.recipient_name}, number ${t.phone}.`,
    "Choose the amount to send. Wise shows the exact fee, exchange rate and what the recipient gets before you confirm. Check them.",
    "Pay Wise using any method Wise offers for your country and account.",
    "Come back to this page, enter the transfer reference from Wise, and submit it so we can match the payment.",
  ];
  const warnings = [
    "Check the amount, fees and exchange rate Wise shows before you pay. We can’t see or control them.",
    "Wise does not pass a reference to M-PESA recipients, so quote our reference below when you submit your transfer here.",
    "Your invoice is marked paid only after we confirm the money has arrived. This can take a business day or more.",
  ];
  return { steps, warnings };
}
