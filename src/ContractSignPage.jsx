import React from "react";
import SignDocumentPage from "./SignDocumentPage.jsx";
import { publicGetContract, publicSignContract, publicDeclineContract, downloadContractPdf } from "./contractsApi.js";
import { CONTRACT_CONSENT_TEXT, formatContractMoney, formatContractDate } from "./contracts.js";

// Public contract signing page, rendered when the URL is ?share=contract&token=...
// No account needed: it talks to the contract_public_* RPCs only.
const api = { get: publicGetContract, sign: publicSignContract, decline: publicDeclineContract };

const label = { color: "#8b9a98", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 2px" };
const value = { margin: 0, fontSize: 15 };

// Key terms pulled from the project, shown above the full text so nothing is buried.
function TermsSummary(doc) {
  const t = doc.terms || {};
  if (!t.project_name) return null;
  return (
    <section
      aria-label="Key terms"
      style={{ background: "#1c2327", border: "1px solid #2a3338", borderRadius: 10, padding: 16, marginBottom: 20, display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
    >
      <div><p style={label}>Project</p><p style={value}>{t.project_name}</p></div>
      <div><p style={label}>Total fee</p><p style={value}>{formatContractMoney(t.currency, t.budget_total)}</p></div>
      <div><p style={label}>Deadline</p><p style={value}>{formatContractDate(t.deadline) || "To be agreed"}</p></div>
      {(t.milestones || []).length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <p style={label}>Payment schedule</p>
          {t.milestones.map((m) => (
            <p key={m.label} style={{ ...value, fontSize: 14 }}>{m.label}: {m.percent}% ({formatContractMoney(t.currency, m.amount)})</p>
          ))}
        </div>
      )}
    </section>
  );
}

export default function ContractSignPage({ token }) {
  return (
    <SignDocumentPage
      token={token} docLabel="contract" api={api} downloadPdf={downloadContractPdf}
      consentText={CONTRACT_CONSENT_TEXT} renderSummary={TermsSummary}
    />
  );
}
