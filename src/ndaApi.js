import { supabase } from "./supabaseClient";

export const NDA_STATUS = {
  sent: { label: "Awaiting signature", color: "#F2A65A" },
  viewed: { label: "Opened, not signed", color: "#F2C14E" },
  signed: { label: "Signed", color: "#3DDC84" },
  declined: { label: "Declined", color: "#E5646B" },
  expired: { label: "Expired", color: "#8b9a98" },
  voided: { label: "Voided", color: "#8b9a98" },
};

export const NDA_CONSENT_TEXT =
  "I agree to sign this document electronically and understand my typed name and signature are legally binding to the same extent as a handwritten signature.";

// Starting point only. Have a lawyer review it for your jurisdiction.
export const DEFAULT_NDA_BODY = `NON-DISCLOSURE AGREEMENT

This Agreement is made on {{effective_date}} between {{studio_name}} ("the Studio") and {{freelancer_name}} ("the Freelancer").

1. Confidential Information
Confidential Information means any non-public information the Studio or its clients share with the Freelancer, in any form, including scripts, storyboards, designs, animatics, unreleased footage, project files, schedules, budgets, rates, client identities and business plans, and the existence and subject of any project.

2. Obligations
The Freelancer will (a) use Confidential Information only to perform work for the Studio; (b) not disclose it to anyone without the Studio's written consent; (c) protect it with at least the care used for their own confidential material; and (d) not post, publish, or show work in progress or finished work, including in portfolios or on social media, until the Studio confirms in writing that it has been released.

3. Exclusions
These obligations do not apply to information that is or becomes public through no fault of the Freelancer, was already known to the Freelancer without restriction, or is independently developed without use of Confidential Information. The Freelancer may disclose information required by law after giving the Studio prompt notice where permitted.

4. Ownership and return
All Confidential Information remains the property of the Studio or its clients. On request or when the engagement ends, the Freelancer will return or permanently delete all copies, including local files and cloud storage.

5. Term
This Agreement applies from the date above. The confidentiality obligations continue for 3 years after the engagement ends, and indefinitely for trade secrets and unreleased client material.

6. Remedies
The Freelancer acknowledges that a breach may cause harm that money alone cannot repair, and that the Studio may seek an injunction in addition to any other remedy.

7. General
This Agreement is the entire agreement on its subject and may only be changed in writing signed by both parties. It is governed by the laws of {{governing_law}}. Signing electronically has the same effect as signing on paper.`;

export function renderNdaBody(template, vars) {
  const map = {
    studio_name: vars.studioName || "the Studio",
    freelancer_name: vars.freelancerName || "the Freelancer",
    effective_date: vars.effectiveDate || new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    governing_law: vars.governingLaw || "[governing law]",
  };
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m));
}

export const ndaSignLink = (token) =>
  `${window.location.origin}${window.location.pathname}?share=nda&token=${token}`;

// ---- owner side -----------------------------------------------------------
export async function loadNdaTemplate() {
  const { data, error } = await supabase.from("nda_templates").select("*").maybeSingle();
  if (error) throw error;
  return data
    ? { id: data.id, body: data.body, governingLaw: data.governing_law || "" }
    : { id: null, body: DEFAULT_NDA_BODY, governingLaw: "" };
}

export async function saveNdaTemplate({ body, governingLaw }) {
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase.from("nda_templates").upsert(
    { user_id: session.user.id, body, governing_law: governingLaw || "", updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

export async function listNdaRequests(teamMemberId) {
  const { data, error } = await supabase
    .from("nda_requests")
    .select("*")
    .eq("team_member_id", teamMemberId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Latest request per member, for the roster badge: { [memberId]: status }
export async function listNdaStatusByMember() {
  const { data, error } = await supabase
    .from("nda_requests")
    .select("team_member_id,status,created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const out = {};
  (data || []).forEach((r) => { if (!out[r.team_member_id]) out[r.team_member_id] = r.status; });
  // a signed NDA wins over a newer voided/declined one
  (data || []).forEach((r) => { if (r.status === "signed") out[r.team_member_id] = "signed"; });
  return out;
}

export async function createNdaRequest({ teamMemberId, title, body, signerName, signerEmail, studioName, expiresDays }) {
  const { data, error } = await supabase.rpc("create_nda_request", {
    p_team_member_id: teamMemberId, p_title: title, p_body: body, p_signer_name: signerName,
    p_signer_email: signerEmail, p_studio_name: studioName, p_expires_days: expiresDays,
  });
  if (error) throw error;
  return data; // { id, token } - the token is only ever returned here
}

export async function voidNdaRequest(id) {
  const { error } = await supabase.rpc("void_nda_request", { p_id: id });
  if (error) throw error;
}

// ---- signer side (no account) --------------------------------------------
export async function publicGetNda(token) {
  const { data, error } = await supabase.rpc("nda_public_get", { p_token: token });
  if (error) throw error;
  return data;
}
export async function publicSignNda({ token, typedName, signaturePng, method }) {
  const { data, error } = await supabase.rpc("nda_public_sign", {
    p_token: token, p_typed_name: typedName, p_signature_png: signaturePng,
    p_method: method, p_consent: NDA_CONSENT_TEXT,
  });
  if (error) throw error;
  return data;
}
export async function publicDeclineNda(token, reason) {
  const { data, error } = await supabase.rpc("nda_public_decline", { p_token: token, p_reason: reason || "" });
  if (error) throw error;
  return data;
}
