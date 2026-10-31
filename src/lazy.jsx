import React, { lazy, Suspense } from "react";
import LogoLoader from "./LogoLoader.jsx";

// Code-splitting helper. Wraps a dynamic import so call sites stay `<Thing {...props} />`:
// the module is fetched the first time it renders, with a small placeholder meanwhile.
// `pick` selects a named export (components exported by name rather than default).
const Fallback = ({ label }) => (
  <div role="status" aria-live="polite" style={{ padding: 24, opacity: 0.6, fontSize: 14 }}>{label}</div>
);

export function lazyWithSuspense(loader, { pick, label = "Loading…", logo = false } = {}) {
  const Inner = lazy(() => loader().then((m) => ({ default: pick ? m[pick] : m.default })));
  return function LazyBoundary(props) {
    return (
      <Suspense fallback={logo ? <LogoLoader label={label} /> : <Fallback label={label} />}>
        <Inner {...props} />
      </Suspense>
    );
  };
}
