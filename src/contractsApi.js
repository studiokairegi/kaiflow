// src/contractsApi.js
// Supabase calls for client contracts. Pure rules live in contracts.js.
// Same shape as ndaApi.js: owner side uses RLS + RPCs, signer side uses token-only RPCs.

import { supabase } from "./supabaseClient";
import { buildSignedDocPdf } from "./ndaApi";
import { DEFAULT_CONTRACT_BODY, DEFAULT_REVISION_ROUNDS, CONTRACT_CONSENT_TEXT, formatContractMoney } from "./contracts.js";

// ---- owner side -----------------------------------------------------------
export async function loadContractTemplate() {
  const { data, error } = await supabase.from("contract_templates").select("*").maybeSingle();
  if (error) throw error;
  return data
    ? { id: data.id, body: data.body, governingLaw: data.governing_law || "", revisionRounds: data.revision_rounds ?? DEFAULT_REVISION_ROUNDS }
    : { id: null, body: DEFAULT_CONTRACT_BODY, governingLaw: "", revisionRounds: DEFAULT_REVISION_ROUNDS };
}

export async function saveContractTemplate({ body, governingLaw, revisionRounds }) {
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase.from("contract_templates").upsert(
    {
      user_id: session.user.id, body, governing_law: governingLaw || "",
      revision_rounds: Number(revisionRounds), updated_at: new Date().toISOString(),
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

export async function createContract({ contactId, projectId, title, body, terms, signerName, signerEmail, studioName, studioSignatory, expiresDays }) {
  const { data, error } = await supabase.rpc("create_client_contract", {
    p_contact_id: contactId, p_project_id: projectId, p_title: title, p_body: body, p_terms: terms,
    p_signer_name: signerName, p_signer_email: signerEmail, p_studio_name: studioName,
    p_studio_signatory: studioSignatory || "", p_expires_days: expiresDays,
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
export async function publicSignContract({ token, typedName, signaturePng, method }) {
  const { data, error } = await supabase.rpc("contract_public_sign", {
    p_token: token, p_typed_name: typedName, p_signature_png: signaturePng,
    p_method: method, p_consent: CONTRACT_CONSENT_TEXT,
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
export function buildContractPdf(r) {
  const t = r.terms || {};
  return buildSignedDocPdf(r, {
    defaultTitle: "Services Agreement",
    extraRows: [
      ["Project", t.project_name || "-"],
      ["Contract fee", t.budget_total != null ? formatContractMoney(t.currency, t.budget_total) : "-"],
    ],
  });
}

export function downloadContractPdf(r) {
  const who = (r.typed_name || r.signer_name || "client").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const proj = ((r.terms && r.terms.project_name) || "project").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  buildContractPdf(r).save(`contract-${proj}-${who}.pdf`);
}
