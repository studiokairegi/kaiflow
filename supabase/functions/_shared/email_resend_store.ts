// Supabase-backed stores for the Resend Edge Functions. Thin by design: every decision lives in email_resend_logic.ts.
// Uses the SERVICE ROLE client, so callers must authenticate the person (email-send) or verify the signature (resend-webhook) first.
import type { SendStore, WebhookStore, SubjectCandidate, AccountRef, ClaimResult } from "./email_resend_logic.ts";
import { baseAddress, safeFileName } from "./email_resend_logic.ts";

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function makeSendStore(service: any): SendStore {
  return {
    async providerEnabled() {
      const { data, error } = await service.rpc("email_provider_enabled", { p_provider: "resend" });
      if (error) throw new Error(`provider flag: ${error.message}`);
      return data === true;
    },
    async getAccount(orgId, accountId) {
      const { data, error } = await service.from("email_accounts").select("id,address,display_name,status").eq("organization_id", orgId).eq("id", accountId).maybeSingle();
      if (error) throw new Error(`account lookup: ${error.message}`);
      return data || null;
    },
    async getThreadParent(orgId, conversationId) {
      const { data, error } = await service.from("email_messages").select("rfc_message_id,references_ids")
        .eq("organization_id", orgId).eq("conversation_id", conversationId).neq("status", "draft").not("rfc_message_id", "is", null)
        .order("received_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
      if (error) throw new Error(`thread parent: ${error.message}`);
      return data || null;
    },
    async countOutboundSince(orgId, sinceIso) {
      const { count, error } = await service.from("email_messages").select("id", { count: "exact", head: true })
        .eq("organization_id", orgId).eq("direction", "outbound").neq("status", "draft").gte("created_at", sinceIso);
      if (error) throw new Error(`count: ${error.message}`);
      return count || 0;
    },
    async createOutbound(p) {
      return must(await service.rpc("email_create_outbound", { p }), "create outbound");
    },
    async markResult(messageId, patch) {
      must(await service.from("email_messages").update(patch).eq("id", messageId), "update message");
    },
    async saveAttachments(orgId, messageId, files) {
      for (const f of files) {
        const path = `${orgId}/${messageId}/${crypto.randomUUID()}-${safeFileName(f.filename)}`;
        const bytes = b64ToBytes(f.base64);
        must(await service.storage.from("email-attachments").upload(path, bytes, { contentType: f.content_type, upsert: false }), "upload");
        must(await service.from("email_attachments").insert({ organization_id: orgId, message_id: messageId, filename: f.filename, content_type: f.content_type, size_bytes: bytes.length, storage_path: path }), "attachment row");
      }
    },
  };
}

export function makeWebhookStore(service: any): WebhookStore {
  const failOn = (e: { message: string } | null, what: string) => { if (e) throw new Error(`${what}: ${e.message}`); };
  return {
    async providerEnabled() {
      // A database failure must NOT look like "disabled": that would acknowledge (and lose) the event. It throws, the caller answers 500, Resend retries.
      const { data, error } = await service.rpc("email_provider_enabled", { p_provider: "resend" });
      failOn(error, "provider flag");
      return data === true;
    },
    async claimWebhook(svixId, type, payload) {
      const out = must(await service.rpc("email_webhook_claim", { p_svix_id: svixId, p_type: type, p_payload: payload }), "webhook claim") as any;
      switch (out?.state) {
        case "claimed": return { state: "claimed", token: String(out.token), attempts: Number(out.attempts || 1) } as ClaimResult;
        case "done": case "busy": case "exhausted": return { state: out.state } as ClaimResult;
        default: throw new Error("webhook claim: unexpected answer");
      }
    },
    async finishWebhook(svixId, token, status, error = "") {
      const out = must(await service.rpc("email_webhook_finish", { p_svix_id: svixId, p_token: token, p_status: status, p_error: error }), "webhook finish") as any;
      return out?.ok === true;
    },
    async accountsForRecipient(address, inboundDomain = ""): Promise<AccountRef[]> {
      const base = baseAddress(address);
      const [local, domain] = base.split("@");
      if (!local || !domain) return [];
      const cols = "id,organization_id,address";
      // 1. exact address match (never a domain-wide or default-account fallback)
      const exact = await service.from("email_accounts").select(cols).eq("status", "active").eq("provider", "resend").eq("address", base);
      failOn(exact.error, "account lookup");
      const rows: AccountRef[] = [...(exact.data || [])];
      // 2. only for the configured inbound domain: same local part. The database filter is wide (LIKE), the exact comparison below is what counts.
      if (inboundDomain && domain === inboundDomain) {
        const like = await service.from("email_accounts").select(cols).eq("status", "active").eq("provider", "resend").like("address", `${local.replace(/[%_\\]/g, "")}@%`);
        failOn(like.error, "account lookup");
        for (const r of like.data || []) if (String(r.address).split("@")[0] === local) rows.push(r);
      }
      return rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);
    },
    async threadLookup(orgId, accountId, q) {
      let tokenConversationId: string | null = null;
      if (q.token) {
        const { data, error } = await service.rpc("email_find_conversation_by_token", { p_organization_id: orgId, p_account_id: accountId, p_token: q.token });
        failOn(error, "thread token");
        tokenConversationId = typeof data === "string" ? data : null;
      }
      const rfcMap: Record<string, string> = {};
      if (q.rfcIds.length) {
        const { data, error } = await service.from("email_messages").select("rfc_message_id,conversation_id").eq("organization_id", orgId).eq("account_id", accountId).in("rfc_message_id", q.rfcIds);
        failOn(error, "thread headers");
        for (const r of data || []) rfcMap[r.rfc_message_id] = r.conversation_id;
      }
      let candidates: SubjectCandidate[] = [];
      if (q.normalizedSubject) {
        const conv = await service.from("email_conversations").select("id,normalized_subject,last_message_at").eq("organization_id", orgId).eq("account_id", accountId)
          .eq("normalized_subject", q.normalizedSubject).order("last_message_at", { ascending: false, nullsFirst: false }).limit(10);
        failOn(conv.error, "thread subject");
        const ids = (conv.data || []).map((c: any) => c.id);
        let parts: any[] = [];
        if (ids.length) {
          const pr = await service.from("email_participants").select("conversation_id,email").in("conversation_id", ids);
          failOn(pr.error, "thread participants");
          parts = pr.data || [];
        }
        candidates = (conv.data || []).map((c: any) => ({ conversation_id: c.id, normalized_subject: c.normalized_subject, last_message_at: c.last_message_at, participants: parts.filter((p: any) => p.conversation_id === c.id).map((p: any) => p.email) }));
      }
      return { tokenConversationId, rfcMap, candidates };
    },
    async uploadAttachment(path, bytes, contentType) {
      must(await service.storage.from("email-attachments").upload(path, bytes, { contentType, upsert: true }), "attachment upload");
    },
    async ingestInbound(p) {
      return must(await service.rpc("email_ingest_inbound", { p }), "ingest inbound");
    },
    async applyDeliveryEvent(a) {
      const out = must(await service.rpc("email_apply_delivery_event", {
        p_provider_message_id: a.provider_message_id, p_status: a.status, p_event_type: a.event_type,
        p_provider_event_id: a.provider_event_id, p_occurred_at: a.occurred_at, p_detail: a.detail,
      }), "apply event") as any;
      return { found: out?.found === true, ambiguous: out?.ambiguous === true, duplicate: out?.duplicate === true, applied: out?.applied === true };
    },
    async applyIntelDeliveryEvent(a) {
      // Find exact Intelligence outbound messages by provider identity. Never guess
      // an account when a provider message id is duplicated across accounts.
      const query = await service.from("intel_messages")
        .select("id,organization_id,provider_account_id,provider_key,provider_message_id,to_email")
        .eq("direction", "outbound").eq("provider_key", "resend")
        .eq("provider_message_id", a.provider_message_id);
      failOn(query.error, "Intelligence provider message lookup");
      const rows = (query.data || []).filter((r: any) => {
        const addr = String(r.to_email || "").trim().toLowerCase();
        return !a.recipient || addr === a.recipient;
      });
      const accounts = rows.filter((r: any) => r.provider_account_id && r.organization_id);
      const distinct = accounts.filter((r: any, i: number) => accounts.findIndex((x: any) => x.organization_id === r.organization_id && x.provider_account_id === r.provider_account_id) === i);
      if (distinct.length > 1) return { found: false, ambiguous: true };
      if (!distinct.length) return { found: false };
      const row = distinct[0];
      const statusMap: Record<string, string> = {
        "email.sent": "accepted", "email.delivered": "delivered", "email.delivery_delayed": "delayed",
        "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed",
        "email.suppressed": "failed", "email.rejected": "failed",
      };
      const status = statusMap[a.event_type];
      if (!status) return { found: false };
      const out = must(await service.rpc("intel_agent_apply_delivery_event", {
        p_provider_key: "resend", p_provider_account_id: row.provider_account_id,
        p_provider_message_id: a.provider_message_id, p_provider_event_id: a.provider_event_id,
        p_event_type: a.event_type, p_status: status, p_occurred_at: a.occurred_at,
        p_recipient: String(row.to_email || "").trim().toLowerCase(), p_reason: a.reason,
      }), "apply Intelligence delivery event") as any;
      if (out?.ok !== true || out?.found !== true || (out?.duplicate !== true && typeof out?.applied !== "boolean")) {
        throw new Error(`Intelligence delivery event not durably accepted: ${String(out?.reason || "invalid RPC response")}`);
      }
      return { found: true, duplicate: out.duplicate === true, applied: out.applied === true };
    },
  };
}
