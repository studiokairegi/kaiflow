import React from "react";

// Shared loading state for module-level loads (Finance, Payments): the app logo, centered, gently pulsing.
// The logo is the existing /logo.png asset shown at its natural proportions (square, transparent PNG);
// nothing is recoloured or cropped. It fades in after a short delay (see .kf-logo-loader in refine.css),
// so loads that finish quickly never flash it.
export default function LogoLoader({ label = "Loading" }) {
  return (
    <div className="kf-logo-loader" role="status" aria-live="polite" aria-label={label}>
      <img className="kf-logo-loader-img" src="/logo.png" alt="" width="64" height="64" draggable="false" />
    </div>
  );
}
