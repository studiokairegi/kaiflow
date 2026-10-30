import React from "react";
import "./responsive.css";
import "./refine.css";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { ClientPortalView, FreelancerView } from "./SharedViews.jsx";
import { lazyWithSuspense } from "./lazy.jsx";
// Public pages are rarely hit, and the signing pages pull in jspdf: load them on demand.
const NdaSignPage = lazyWithSuspense(() => import("./NdaSignPage.jsx"));
const ContractSignPage = lazyWithSuspense(() => import("./ContractSignPage.jsx"));
const PayCheckoutPage = lazyWithSuspense(() => import("./payments/PayCheckoutPage.jsx"));
const GuestChatPage = lazyWithSuspense(() => import("./chat/GuestChatPage.jsx"));
const PortfolioPage = lazyWithSuspense(() => import("./portfolio/PortfolioPage.jsx"));
import { parsePayPath } from "./payments/providers.js";
import { tokenFromPortfolioPath } from "./portfolio/logic.js";

// Without a boundary, one render error unmounts the whole tree and leaves a blank page.
class StartupErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error("Render failed:", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, background: "#14191c", color: "#e8e4dc", fontFamily: "sans-serif" }}>
        <p style={{ margin: 0 }}>Something went wrong while loading the app.</p>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "8px 16px", cursor: "pointer" }}>Reload</button>
      </div>
    );
  }
}

// Lets the browser show alerts when no tab is open (see src/push). The worker caches nothing.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}

const params = new URLSearchParams(window.location.search);
const shareType = params.get("share");
const shareToken = params.get("token");

const payRoute = parsePayPath(window.location.pathname);
const portfolioToken = tokenFromPortfolioPath(window.location.pathname);

let content;
if (portfolioToken) {
  // Public studio portfolio: /portfolio/{secure-token}. Needs a host rewrite of /portfolio/* to index.html.
  content = <PortfolioPage token={portfolioToken} />;
} else if (payRoute) {
  // Public client checkout: /pay/{secure-token}. Needs a host rewrite of /pay/* to index.html.
  content = <PayCheckoutPage token={payRoute.token} view={payRoute.view} />;
} else if (params.get("guest-chat") === "1") {
  // Freelancer guest chat: the one-time invite lives in the URL fragment, never the query string.
  content = <GuestChatPage />;
} else if (shareType === "project" && shareToken) {
  content = <ClientPortalView token={shareToken} />;
} else if (shareType === "shot" && shareToken) {
  content = <FreelancerView token={shareToken} />;
} else if ((shareType === "nda" || params.get("sign") === "nda") && shareToken) {
  content = <NdaSignPage token={shareToken} />;
} else if (shareType === "contract" && shareToken) {
  content = <ContractSignPage token={shareToken} />;
} else {
  content = <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode><StartupErrorBoundary>{content}</StartupErrorBoundary></React.StrictMode>
);
