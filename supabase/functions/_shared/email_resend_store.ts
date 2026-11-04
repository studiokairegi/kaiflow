// Supabase-backed stores for the Resend Edge Functions. Thin by design: every decision lives in email_resend_logic.ts.
// Uses the SERVICE ROLE client, so callers must authenticate the person (email-send) or verify the signature (resend-webhook) first.
import type { SendStore, WebhookStore, SubjectCandidate } from "./email_resend_logic.ts";
import { baseAddress, safeFileName } from "./email_resend_logic.ts";

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function makeSendStore(service: any): SendStore {
  return {
    async providerEnabled() {
      const { data } = await service.rpc("email_provider_enabled", { p_provider: "resend" });
      return data === true;
    },
    async getAccount(orgId, accountId) {
      const { data } = await service.from("email_accounts").select("id,address,display_name,status").eq("organization_id", orgId).eq("id", accountId).maybeSingle();
      return data || null;
    },
    async getThreadParent(orgId, conversationId) {
      const { data } = await service.from("email_messages").select("rfc_message_id,references_ids")
        .eq("organization_id", orgId).eq("conversation_id", conversationId).neq("status", "draft").not("rfc_message_id", "is", null)
        .order("received_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
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
  return {
    async providerEnabled() {
      const { data } = await service.rpc("email_provider_enabled", { p_provider: "resend" });
      return data === true;
    },
    async beginWebhook(svixId, type, payload) {
      const ins = await service.from("email_webhook_events").insert({ svix_id: svixId, event_type: type, payload });
      if (!ins.error) return "new";
      const { data: existing } = await service.from("email_webhook_events").select("status,attempts").eq("svix_id", svixId).maybeSingle();
      if (!existing) throw new Error(`webhook log: ${ins.error.message}`);
      if (existing.status === "processed" || existing.status === "ignored") return "done";
      await service.from("email_webhook_events").update({ attempts: (existing.attempts || 1) + 1, status: "received" }).eq("svix_id", svixId);
      return "retry";
    },
    async finishWebhook(svixId, status, error = "") {
      must(await service.from("email_webhook_events").update({ status, error, processed_at: new Date().toISOString() }).eq("svix_id", svixId), "webhook log");
    },
    async findAccount(addresses) {
      const wanted = [...new Set(addresses.map(baseAddress))];
      if (!wanted.length) return null;
      const { data } = await service.from("email_accounts").select("id,organization_id,address,is_default").eq("status", "active").in("address", wanted).limit(1);
      if (data?.length) return data[0];
      // Catch-all: mail to any address at a domain we send from goes to that domain's default inbox.
      const domains = [...new Set(wanted.map((a) => a.split("@")[1]).filter(Boolean))];
      for (const dom of domains) {
        const { data: rows } = await service.from("email_accounts").select("id,organization_id,address,is_default").eq("status", "active").like("address", `%@${dom}`).order("is_default", { ascending: false }).limit(1);
        if (rows?.length) return rows[0];
      }
      return null;
    },
    async threadLookup(orgId, q) {
      let tokenConversationId: string | null = null;
      if (q.token) {
        const { data } = await service.rpc("email_find_conversation_by_token", { p_organization_id: orgId, p_token: q.token });
        tokenConversationId = typeof data === "string" ? data : null;
      }
      const rfcMap: Record<string, string> = {};
      if (q.rfcIds.length) {
        const { data } = await service.from("email_messages").select("rfc_message_id,conversation_id").eq("organization_id", orgId).in("rfc_message_id", q.rfcIds);
        for (const r of data || []) rfcMap[r.rfc_message_id] = r.conversation_id;
      }
      let candidates: SubjectCandidate[] = [];
      if (q.normalizedSubject) {
        const { data } = await service.from("email_conversations").select("id,normalized_subject,last_message_at").eq("organization_id", orgId).eq("normalized_subject", q.normalizedSubject).order("last_message_at", { ascending: false, nullsFirst: false }).limit(10);
        const ids = (data || []).map((c: any) => c.id);
        const parts = ids.length ? (await service.from("email_participants").select("conversation_id,email").in("conversation_id", ids)).data || [] : [];
        candidates = (data || []).map((c: any) => ({ conversation_id: c.id, normalized_subject: c.normalized_subject, last_message_at: c.last_message_at, participants: parts.filter((p: any) => p.conversation_id === c.id).map((p: any) => p.email) }));
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
      return out?.found === true;
    },
  };
}
