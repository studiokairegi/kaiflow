import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { ClientPortalView, FreelancerView } from "./SharedViews.jsx";
import NdaSignPage from "./NdaSignPage.jsx";
import ContractSignPage from "./ContractSignPage.jsx";
import PayCheckoutPage from "./payments/PayCheckoutPage.jsx";
import { tokenFromPath } from "./payments/providers.js";

const params = new URLSearchParams(window.location.search);
const shareType = params.get("share");
const shareToken = params.get("token");

const payToken = tokenFromPath(window.location.pathname);

let content;
if (payToken) {
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
