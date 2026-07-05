import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { ClientPortalView, FreelancerView } from "./SharedViews.jsx";

const params = new URLSearchParams(window.location.search);
const shareType = params.get("share");
const shareToken = params.get("token");

let content;
if (shareType === "project" && shareToken) {
  content = <ClientPortalView token={shareToken} />;
} else if (shareType === "shot" && shareToken) {
  content = <FreelancerView token={shareToken} />;
} else {
  content = <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{content}</React.StrictMode>
);
