// Payments is ADMIN ONLY. This is the single UI-side definition; the real enforcement is in the
// database (payments_require_admin / RLS) and the Edge Functions. Hiding UI is never the control.
//
// Fails closed: until settings have loaded, isAdmin is false, so Payments shows as locked.
export const PAYMENTS_RESTRICTED_TITLE = "Payments is currently available to administrators only.";
export const PAYMENTS_RESTRICTED_BODY =
  "Payment management and client checkout configuration will become available to your account type in a future update.";

export function canAccessPayments(settings) {
  return settings?.isAdmin === true;
}
