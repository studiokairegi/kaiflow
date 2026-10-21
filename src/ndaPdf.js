// Signed-document PDF builders. Split out of ndaApi.js so the (large) jspdf library is only
// loaded by screens that actually render PDFs, not by everything that imports ndaApi.
import { jsPDF } from "jspdf";

// ---- signed PDF with certificate page -------------------------------------
// Accepts a row from nda_requests (snake_case) or the public RPC json (same keys).
export function buildNdaPdf(r) {
  return buildSignedDocPdf(r, { defaultTitle: "Non-Disclosure Agreement" });
}

// Shared with client contracts (contractsApi.js). `extraRows` are [label, value] pairs
// added to the certificate page right after the document title.
export function buildSignedDocPdf(r, { defaultTitle = "Document", extraRows = [] } = {}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 56;
  let y = M;
  const ensure = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };

  doc.setFont("times", "normal");
  doc.setFontSize(11);
  String(r.body || "").split("\n").forEach((line) => {
    const isTitle = line === line.toUpperCase() && line.trim().length > 3;
    const isHeading = isTitle || (/^\d+\.\s/.test(line) && line.length < 60);
    doc.setFont("times", isHeading ? "bold" : "normal");
    doc.setFontSize(isTitle ? 15 : 11);
    const lines = doc.splitTextToSize(line || " ", W - M * 2);
    lines.forEach((l) => { ensure(16); doc.text(l, M, y); y += line === "" ? 8 : 15; });
  });

  if (r.status === "signed" && r.signature_png) {
    ensure(120);
    y += 18;
    doc.setFont("times", "normal");
    doc.text("Signed electronically by:", M, y); y += 8;
    try { doc.addImage(r.signature_png, "PNG", M, y, 200, 70); } catch (e) { /* signature image unreadable */ }
    y += 82;
    doc.setFont("times", "bold");
    doc.text(r.typed_name || r.signer_name, M, y);
  }

  // Certificate page
  doc.addPage();
  y = M;
  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  doc.text("Certificate of completion", M, y); y += 28;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  const when = (iso) => (iso ? new Date(iso).toUTCString() : "-");
  const rows = [
    ["Document", r.title || defaultTitle],
    ...extraRows,
    ["Requested by", r.studio_name || "-"],
    ["Signer", `${r.typed_name || r.signer_name}${r.signer_email ? ` <${r.signer_email}>` : ""}`],
    ["Status", (r.status || "").toUpperCase()],
    ["Sent", when(r.created_at)],
    ["Signed", when(r.signed_at)],
    ["Signer IP address", r.signer_ip || "not recorded"],
    ["Signature method", r.signature_method === "type" ? "Typed" : "Drawn"],
    ["Document fingerprint (SHA-256)", r.body_hash || "-"],
    ["Consent given", r.consent_text || "-"],
    ["Request ID", r.id || "-"],
  ];
  rows.forEach(([k, v]) => {
    doc.setFont("helvetica", "bold"); ensure(14); doc.text(k, M, y); y += 13;
    doc.setFont("helvetica", "normal");
    doc.splitTextToSize(String(v), W - M * 2).forEach((l) => { ensure(13); doc.text(l, M, y); y += 13; });
    y += 7;
  });
  return doc;
}

export function downloadNdaPdf(r) {
  const safe = (r.typed_name || r.signer_name || "freelancer").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  buildNdaPdf(r).save(`nda-${safe}.pdf`);
}
