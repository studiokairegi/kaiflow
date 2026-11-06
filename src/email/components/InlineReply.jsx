import React, { useRef, useState } from "react";
import { useBusy } from "../../finance/ui.jsx";
import ChatComposer from "../../chat/Composer.jsx";
import { emailApi } from "../lib/api.js";
import { attachmentProblem, inlineReply, textToHtml } from "../lib/logic.js";
import { newKey } from "../lib/helpers.js";

export default function InlineReply({ supabase, convo, messages, participants, own, onSent }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const key = useRef(newKey());
  const send = useBusy();
  const target = inlineReply(messages, own, { subject: convo.subject, participants });
  const problem = attachmentProblem(files);
  if (!target.to.length) return <div className="chat-composer"><p className="chat-hint">Nothing to reply to yet. Use Edit draft above to finish and send this email.</p></div>;
  const submit = () => send.run(async () => {
    if (problem) throw new Error(problem);
    try {
      await emailApi.send(supabase, { accountId: convo.account_id, to: target.to, cc: [], bcc: [], subject: target.subject, text, html: textToHtml(text), conversationId: convo.id, draftId: null, key: key.current, files });
    } catch (e) {
      key.current = newKey();           // the server keeps the old key's row; a retry needs a fresh key
      throw e;
    }
    key.current = newKey();
    setText(""); setFiles([]);
    await onSent();
  });
  return (
    <ChatComposer value={text} onChange={setText} onSend={submit} sending={send.busy} files={files} onFilesChange={setFiles}
      error={send.error || problem} placeholder="Write a reply…" label="Reply" footerNote={`To ${target.to.join(", ")} · Enter to send · Shift+Enter for a new line`} />
  );
}
