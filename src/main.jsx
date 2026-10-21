import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { ClientPortalView, FreelancerView } from "./SharedViews.jsx";
import { lazyWithSuspense } from "./lazy.jsx";
// Public pages are rarely hit, and the signing pages pull in jspdf: load them on demand.
const NdaSignPage = lazyWithSuspense(() => import("./NdaSignPage.jsx"));
const ContractSignPage = lazyWithSuspense(() => import("./ContractSignPage.jsx"));
const PayCheckoutPage = lazyWithSuspense(() => import("./payments/PayCheckoutPage.jsx"));
const PortfolioPage = lazyWithSuspense(() => import("./portfolio/PortfolioPage.jsx"));
import { tokenFromPath } from "./payments/providers.js";
import { tokenFromPortfolioPath } from "./portfolio/logic.js";

const params = new URLSearchParams(window.location.search);
const shareType = params.get("share");
const shareToken = params.get("token");

const payToken = tokenFromPath(window.location.pathname);
const portfolioToken = tokenFromPortfolioPath(window.location.pathname);

let content;
if (portfolioToken) {
  // Public studio portfolio: /portfolio/{secure-token}. Needs a host rewrite of /portfolio/* to index.html.
  content = <PortfolioPage token={portfolioToken} />;
} else if (payToken) {
  // Public client checkout: /pay/{secure-token}. Needs a host rewrite of /pay/* to index.html.
  content = <PayCheckoutPage token={payToken} />;
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
  <React.StrictMode>{content}</React.StrictMode>
);
