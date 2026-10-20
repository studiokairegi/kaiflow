import React from "react";
import { S, T } from "../finance/ui.jsx";
import { PAYMENTS_RESTRICTED_BODY, PAYMENTS_RESTRICTED_TITLE } from "./access.js";

// Shown instead of the Payments module to non-admins (e.g. if they land on it via a stale link).
export default function PaymentsRestricted() {
  return (
    <div style={S.page}>
      <div style={{ ...S.card, maxWidth: 520 }} role="status">
        <h3 style={S.h3}>🔒 {PAYMENTS_RESTRICTED_TITLE}</h3>
        <p style={{ color: T.muted, fontSize: 14, margin: 0 }}>{PAYMENTS_RESTRICTED_BODY}</p>
      </div>
    </div>
  );
}
