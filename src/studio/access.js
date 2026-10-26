export const STUDIO_MODULES = Object.freeze(["dashboard", "leads", "planner", "projects", "teams", "finance", "payments"]);

export function allowedWorkspaceKeys(access, { legacyFallback = true } = {}) {
  // `null` means the access RPC is unavailable (legacy single-user installs may
  // fall back); an explicit is_member:false is a real authorization result and
  // must never expose the full workspace set.
  if (access == null) return legacyFallback ? [...STUDIO_MODULES] : ["dashboard"];
  if (access.is_member !== true) return ["dashboard"];
  if (access.role === "master_user" || access.is_master === true) return [...STUDIO_MODULES];
  const permissions = new Set(Array.isArray(access.department_permission_keys) ? access.department_permission_keys : []);
  const projectsAssigned = Number(access.assigned_project_count || 0) > 0;
  const allowed = ["dashboard"];
  if (permissions.has("crm.read") || permissions.has("contacts.read")) allowed.push("leads");
  if (permissions.has("projects.read") || permissions.has("shots.read") || projectsAssigned) allowed.push("projects");
  if (permissions.has("teams.read")) allowed.push("teams");
  // The accounting ledger and payment RPCs remain owner-scoped. Invoice/expense
  // read permission alone must not mount that full ledger while acting in another studio.
  if (access.role === "master_user" || access.is_master === true) allowed.push("finance");
  return allowed;
}

export function createInviteToken(cryptoObject = globalThis.crypto) {
  if (!cryptoObject?.getRandomValues) throw new Error("Secure random token generation is unavailable in this browser.");
  const bytes = new Uint8Array(32);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildInviteLink(token, origin = globalThis.location?.origin || "") {
  if (!/^[0-9a-f]{64}$/i.test(String(token || ""))) throw new Error("Invalid invitation token.");
  const url = new URL(origin || "http://localhost", origin || "http://localhost");
  url.searchParams.set("studio-invite", token.toLowerCase());
  url.searchParams.delete("signup");
  return url.toString();
}

export function normalizeInviteEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// No department = the freelancer portal; a department = that department's dedicated view.
export function inviteRoleFor(departmentId) {
  return departmentId ? "staff" : "freelancer";
}

export function describeAccess(role, departmentName = "") {
  if (departmentName) return role === "department_admin" ? `${departmentName} lead` : departmentName;
  return role === "freelancer" ? "Freelancer portal" : "Team member";
}

// Maps the studio-invite-accept error codes (and legacy RPC errors) to plain language.
export function friendlyInviteError(codeOrError) {
  const raw = typeof codeOrError === "string" ? codeOrError : String(codeOrError?.message || codeOrError?.error || "");
  if (/account_exists/i.test(raw)) return "That email already has an account. Sign in with it and this invite will be added to it.";
  if (/weak_password/i.test(raw)) return "Choose a password with at least 8 characters.";
  if (/invalid_email/i.test(raw)) return "Enter a valid email address.";
  if (/invite_not_found_or_expired|invalid_invite_token/i.test(raw)) return "This invite link has expired or was already used. Ask the studio owner for a new one.";
  if (/function .* does not exist|schema cache|not.?found|Failed to send|fetch/i.test(raw)) return "Invite sign-up isn't set up on this server yet. Ask the studio owner to finish setup.";
  return raw || "We couldn't complete that. Please try again.";
}

// supabase.functions.invoke surfaces non-2xx responses as an error carrying the Response.
export async function readFunctionError(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return String(body.error);
  } catch { /* fall through */ }
  return String(error?.message || "");
}
