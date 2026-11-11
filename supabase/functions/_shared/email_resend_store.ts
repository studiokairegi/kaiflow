// Supabase-backed stores for the Resend Edge Functions. Thin by design: every decision lives in email_resend_logic.ts.
// Uses the SERVICE ROLE client, so callers must authenticate the person (email-send) or verify the signature (resend-webhook) first.
import type { SendStore, WebhookStore, SubjectCandidate, AccountRef, ClaimResult } from "./email_resend_logic.ts";
import type { RegistryRow } from "./email_adapter_registry.ts";
import { baseAddress, safeFileName } from "./email_resend_logic.ts";

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Shared by both stores. Reads the provider's row from public.email_provider_registry (service role). Throws on database errors.
async function readRegistryRow(service: any, providerKey: string): Promise<RegistryRow | null> {
  const { data, error } = await service.from("email_provider_registry").select("provider_key,adapter_key,display_name,capabilities,enabled").eq("provider_key", providerKey).maybeSingle();
  if (error) throw new Error(`provider registry: ${error.message}`);
  return data || null;
}

export function makeSendStore(service: any): SendStore {
  return {
    async providerEnabled(legacyFlagKey) {
      const { data, error } = await service.rpc("email_provider_enabled", { p_provider: legacyFlagKey });
      if (error) throw new Error(`provider flag: ${error.message}`);
      return data === true;
    },
    getProviderRegistryRow: (providerKey) => readRegistryRow(service, providerKey),
    async getAccount(orgId, accountId) {
      // `provider` is read from the database row: it is what selects the adapter. The browser never supplies it.
      const { data, error } = await service.from("email_accounts").select("id,organization_id,provider,address,display_name,status,connection_status").eq("organization_id", orgId).eq("id", accountId).maybeSingle();
      if (error) throw new Error(`account lookup: ${error.message}`);
      return data || null;
    },
    async getLeadForUser(userId, leadId) {
      // Leads are per user in this app (leads.user_id, the same rule email_link_lead applies). A lead that is missing and one that belongs to
      // someone else are indistinguishable to the caller. Service role: the filter below IS the authorization, so it must stay on the query.
      const { data, error } = await service.from("leads").select("id,email").eq("id", leadId).eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`lead lookup: ${error.message}`);
      return data || null;
    },
    async getConversationLead(orgId, conversationId, accountId) {
      const { data, error } = await service.from("email_conversations").select("lead_id")
        .eq("id", conversationId).eq("organization_id", orgId).eq("account_id", accountId).maybeSingle();
      if (error) throw new Error(`conversation CRM lookup: ${error.message}`);
      return data || null;
    },
    async getThreadParent(orgId, conversationId, accountId) {
      // A PostgREST order on received_at alone sorts outbound rows (received_at=NULL)
      // behind every inbound row, even when the outbound reply is newer. The RPC orders
      // by the actual message timestamp across both directions.
      const { data, error } = await service.rpc("email_get_thread_parent", {
        p_organization_id: orgId, p_conversation_id: conversationId, p_account_id: accountId,
      });
      if (error) throw new Error(`thread parent: ${error.message}`);
      return data || null;
    },
    async countOutboundSince(orgId, sinceIso, provider) {
      let q = service.from("email_messages").select("id", { count: "exact", head: true })
        .eq("organization_id", orgId).eq("direction", "outbound").neq("status", "draft").gte("created_at", sinceIso);
      if (provider) q = q.eq("provider", provider);
      const { count, error } = await q;
      if (error) throw new Error(`count: ${error.message}`);
      return count || 0;
    },
    async createOutbound(p) {
      return must(await service.rpc("email_create_outbound", { p }), "create outbound");
    },
    async recordCrmActivity(messageId) {
      const out = must(await service.rpc("email_record_crm_activity", { p_message_id: messageId }), "record CRM email activity") as any;
      if (out?.recorded !== true) throw new Error("CRM email activity was not durably recorded");
      return { recorded: true, duplicate: out.duplicate === true };
    },
    async claimOutbound(messageId, replyTo) {
      const { data, error } = await service.rpc("email_claim_outbound", { p_message_id: messageId, p_reply_to: replyTo || null });
      if (error) throw new Error(`claim outbound: ${error.message}`);
      return data === true;
    },
    async markResult(messageId, patch) {
      if (patch?.status === "sent" && typeof patch?.provider_message_id === "string") {
        must(await service.rpc("email_mark_provider_accepted", {
          p_message_id: messageId, p_provider_message_id: patch.provider_message_id, p_sent_at: patch.sent_at || null,
        }), "mark provider accepted");
        if (typeof patch.rfc_message_id === "string") {
          must(await service.from("email_messages").update({ rfc_message_id: patch.rfc_message_id }).eq("id", messageId), "save RFC Message-ID");
        }
        return;
      }
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
    async providerEnabled(legacyFlagKey) {
      // A database failure must NOT look like "disabled": that would acknowledge (and lose) the event. It throws, the caller answers 500, Resend retries.
      const { data, error } = await service.rpc("email_provider_enabled", { p_provider: legacyFlagKey });
      failOn(error, "provider flag");
      return data === true;
    },
    getProviderRegistryRow: (providerKey) => readRegistryRow(service, providerKey),
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
    async accountsForRecipient(address, inboundDomain = "", providerKey): Promise<AccountRef[]> {
      const base = baseAddress(address);
      const [local, domain] = base.split("@");
      if (!local || !domain) return [];
      const cols = "id,organization_id,address";
      // 1. exact address match (never a domain-wide or default-account fallback)
      const exact = await service.from("email_accounts").select(cols).eq("status", "active").eq("provider", providerKey).eq("address", base);
      failOn(exact.error, "account lookup");
      const rows: AccountRef[] = [...(exact.data || [])];
      // 2. only for the configured inbound domain: same local part. The database filter is wide (LIKE), the exact comparison below is what counts.
      if (inboundDomain && domain === inboundDomain) {
        const like = await service.from("email_accounts").select(cols).eq("status", "active").eq("provider", providerKey).like("address", `${local.replace(/[%_\\]/g, "")}@%`);
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
    async reconcileTaggedDeliveryEvent(a) {
      const out = must(await service.rpc("email_reconcile_tagged_delivery_event_with_rfc", {
        p_message_id: a.message_id, p_provider_message_id: a.provider_message_id, p_event_type: a.event_type,
        p_provider_event_id: a.provider_event_id, p_occurred_at: a.occurred_at, p_detail: a.detail,
        p_sender_email: a.sender_email, p_recipients: a.recipients, p_subject: a.subject,
      }), "reconcile tagged accepted email") as any;
      return { found: out?.found === true, conflict: out?.conflict === true, status: out?.status };
    },
    async applyDeliveryEvent(a) {
      const out = must(await service.rpc("email_apply_delivery_event", {
        p_provider_message_id: a.provider_message_id, p_status: a.status, p_event_type: a.event_type,
        p_provider_event_id: a.provider_event_id, p_occurred_at: a.occurred_at, p_detail: a.detail,
      }), "apply event") as any;
      return { found: out?.found === true, ambiguous: out?.ambiguous === true, duplicate: out?.duplicate === true, applied: out?.applied === true };
    },
  };
}
