// src/contractsApi.js
// Supabase calls for client contracts. Pure rules live in contracts.js.
// Same shape as ndaApi.js: owner side uses RLS + RPCs, signer side uses token-only RPCs.

import { supabase } from "./supabaseClient";
import { buildSignedDocPdfLocalized } from "./ndaPdf.js";
import { normalizeLang } from "./i18n/languages.js";
import { contractT } from "./i18n/contractStrings.js";
import { DEFAULT_CONTRACT_BODY, DEFAULT_CONTRACT_BODY_JA, DEFAULT_REVISION_ROUNDS, formatContractMoney } from "./contracts.js";

// ---- owner side -----------------------------------------------------------
export async function loadContractTemplate() {
  const { data, error } = await supabase.from("contract_templates").select("*").maybeSingle();
  if (error) throw error;
  // bodyJa / governingLawJa: the Japanese version of the template. Empty (or the column not migrated yet) means "use
  // the built-in Japanese default".
  return data
    ? {
        id: data.id, body: data.body, governingLaw: data.governing_law || "", revisionRounds: data.revision_rounds ?? DEFAULT_REVISION_ROUNDS,
        bodyJa: data.body_ja || DEFAULT_CONTRACT_BODY_JA, governingLawJa: data.governing_law_ja || "",
        jaColumns: "body_ja" in data,   // false until migration_contract_language.sql has been run
      }
    : { id: null, body: DEFAULT_CONTRACT_BODY, governingLaw: "", revisionRounds: DEFAULT_REVISION_ROUNDS, bodyJa: DEFAULT_CONTRACT_BODY_JA, governingLawJa: "" };
}

export async function saveContractTemplate({ body, governingLaw, revisionRounds, bodyJa, governingLawJa, jaColumns }) {
  // Empty Japanese text means "use the built-in default" (that is also how "Reset to default" is stored).
  const customJa = bodyJa !== undefined && bodyJa !== DEFAULT_CONTRACT_BODY_JA;
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase.from("contract_templates").upsert(
    {
      user_id: session.user.id, body, governing_law: governingLaw || "",
      revision_rounds: Number(revisionRounds), updated_at: new Date().toISOString(),
      // The Japanese columns come from migration_contract_language.sql. They are only sent once the columns exist
      // (or the studio actually wrote a Japanese text), so saving an English-only template keeps working before
      // that migration has been run.
      ...(jaColumns || customJa || governingLawJa ? { body_ja: customJa ? bodyJa : "", governing_law_ja: governingLawJa || "" } : {}),
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

export async function listContracts(contactId) {
  const { data, error } = await supabase
    .from("client_contracts")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createContract({ contactId, projectId, title, body, terms, signerName, signerEmail, studioName, studioSignatory, expiresDays, language }) {
  const { data, error } = await supabase.rpc("create_client_contract", {
    p_contact_id: contactId, p_project_id: projectId, p_title: title, p_body: body, p_terms: terms,
    p_signer_name: signerName, p_signer_email: signerEmail, p_studio_name: studioName,
    p_studio_signatory: studioSignatory || "", p_expires_days: expiresDays,
    // Sent only for Japanese, so English contracts still work against a database that has not been migrated yet.
    ...(normalizeLang(language) === "ja" ? { p_language: "ja" } : {}),
  });
  if (error) throw error;
  return data; // { id, token } - the token is only ever returned here
}

export async function voidContract(id) {
  const { error } = await supabase.rpc("void_client_contract", { p_id: id });
  if (error) throw error;
}

// ---- signer side (no account) --------------------------------------------
export async function publicGetContract(token) {
  const { data, error } = await supabase.rpc("contract_public_get", { p_token: token });
  if (error) throw error;
  return data;
}
export async function publicSignContract({ token, typedName, signaturePng, method, consentText }) {
  // The consent text is stored as proof of what the signer agreed to, in the contract's language: never default it.
  if (!String(consentText || "").trim()) throw new Error("Consent text is missing");
  const { data, error } = await supabase.rpc("contract_public_sign", {
    p_token: token, p_typed_name: typedName, p_signature_png: signaturePng,
    p_method: method, p_consent: consentText,
  });
  if (error) throw error;
  return data;
}
export async function publicDeclineContract(token, reason) {
  const { data, error } = await supabase.rpc("contract_public_decline", { p_token: token, p_reason: reason || "" });
  if (error) throw error;
  return data;
}

// ---- signed PDF -----------------------------------------------------------
// Async because a Japanese PDF has to fetch and embed the Japanese font first. The language is the contract's own
// (r.language), so a signed Japanese contract always downloads as a Japanese PDF.
export async function buildContractPdf(r) {
  const t = r.terms || {};
  const lang = normalizeLang(r.language);
  const tr = contractT(lang);
  return buildSignedDocPdfLocalized(r, {
    defaultTitle: tr("pdf.defaultTitle"),
    extraRows: [
      [tr("pdf.project"), t.project_name || "-"],
      [tr("pdf.fee"), t.budget_total != null ? formatContractMoney(t.currency, t.budget_total, lang) : "-"],
    ],
  });
}

// File names stay ASCII (kanji-only names would otherwise collapse to nothing).
const slug = (s, fallback) => String(s || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || fallback;

export async function downloadContractPdf(r) {
  const who = slug(r.typed_name || r.signer_name, "client");
  const proj = slug(r.terms && r.terms.project_name, "project");
  (await buildContractPdf(r)).save(`contract-${proj}-${who}.pdf`);
}
