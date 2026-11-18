import React from "react";
import SignDocumentPage from "./SignDocumentPage.jsx";
import { publicGetContract, publicSignContract, publicDeclineContract, downloadContractPdf } from "./contractsApi.js";
import { consentTextFor, formatContractMoney, formatContractDate } from "./contracts.js";
import { contractT } from "./i18n/contractStrings.js";
import { normalizeLang } from "./i18n/languages.js";

// Public contract signing page, rendered when the URL is ?share=contract&token=...[&lang=ja]
// No account needed: it talks to the contract_public_* RPCs only. The contract's stored language decides what the
// signer sees; ?lang=ja only covers the moments before it has loaded (loading / invalid link).
const api = { get: publicGetContract, sign: publicSignContract, decline: publicDeclineContract };

const label = { color: "#8b9a98", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 2px" };
const value = { margin: 0, fontSize: 15 };

// Key terms pulled from the project, shown above the full text so nothing is buried.
function TermsSummary(doc, lang) {
  const t = doc.terms || {};
  const tr = contractT(lang);
  if (!t.project_name) return null;
  return (
    <section
      aria-label={tr("summary.aria")}
      style={{ background: "#1c2327", border: "1px solid #2a3338", borderRadius: 10, padding: 16, marginBottom: 20, display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
    >
      <div><p style={label}>{tr("summary.project")}</p><p style={value}>{t.project_name}</p></div>
      <div><p style={label}>{tr("summary.fee")}</p><p style={value}>{formatContractMoney(t.currency, t.budget_total, lang)}</p></div>
      <div><p style={label}>{tr("summary.deadline")}</p><p style={value}>{formatContractDate(t.deadline, lang) || tr("summary.deadlineNone")}</p></div>
      {(t.milestones || []).length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <p style={label}>{tr("summary.schedule")}</p>
          {t.milestones.map((m) => (
            <p key={m.label} style={{ ...value, fontSize: 14 }}>{m.label}{lang === "ja" ? "：" : ": "}{m.percent}% ({formatContractMoney(t.currency, m.amount, lang)})</p>
          ))}
        </div>
      )}
    </section>
  );
}

export default function ContractSignPage({ token }) {
  const hintLang = normalizeLang(new URLSearchParams(window.location.search).get("lang"));
  return (
    <SignDocumentPage
      token={token} docLabel="contract" api={api} downloadPdf={downloadContractPdf}
      consentText={consentTextFor} renderSummary={TermsSummary} hintLang={hintLang}
    />
  );
}
