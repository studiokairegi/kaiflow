import React from "react";
import { T } from "./ui.jsx";

// Eye icon: open eye = amounts visible, slashed eye = finances hidden.
export function PrivacyToggle({ privacy, onChange, compact }) {
  const size = compact ? 16 : 18;
  const label = privacy ? "Show finances" : "Hide finances";
  return (
    <button type="button" onClick={() => onChange(!privacy)} aria-pressed={privacy} aria-label={label} title={label}
      style={{ background: "none", border: `1px solid ${privacy ? T.warn : T.border}`, borderRadius: 999, color: privacy ? T.warn : T.muted, padding: compact ? "4px 7px" : "6px 9px", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 0 }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {privacy ? (
          <>
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </>
        ) : (
          <>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </>
        )}
      </svg>
    </button>
  );
}
