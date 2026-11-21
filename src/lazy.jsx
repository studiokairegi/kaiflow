import React, { lazy, Suspense } from "react";
import LogoLoader from "./LogoLoader.jsx";

// Code-splitting helper. Wraps a dynamic import so call sites stay `<Thing {...props} />`:
// the module is fetched the first time it renders, with a small placeholder meanwhile.
// `pick` selects a named export (components exported by name rather than default).
const Fallback = ({ label }) => (
  <div role="status" aria-live="polite" style={{ padding: 24, opacity: 0.6, fontSize: 14 }}>{label}</div>
);

// Shows the real error (failed chunk download, bad import, render crash) instead of a blank area.
class LazyErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error("Screen failed to load:", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
        <strong>{this.props.label || "This screen"} couldn't load.</strong>
        <code style={{ opacity: 0.8, wordBreak: "break-word" }}>{String(this.state.error?.message || this.state.error)}</code>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "6px 14px", cursor: "pointer" }}>Reload</button>
      </div>
    );
  }
}

export function lazyWithSuspense(loader, { pick, label = "Loading…", logo = false } = {}) {
  const Inner = lazy(() => loader().then((m) => ({ default: pick ? m[pick] : m.default })));
  return function LazyBoundary(props) {
    return (
      <LazyErrorBoundary label={label.replace(/…$|\.\.\.$/, "")}>
        <Suspense fallback={logo ? <LogoLoader label={label} /> : <Fallback label={label} />}>
          <Inner {...props} />
        </Suspense>
      </LazyErrorBoundary>
    );
  };
}
