# Portal chat participant identity patch

This patch fixes client/freelancer message ownership after adding replies and reactions.

## Files
- `src/chat/ClientPortalChat.jsx`: passes the stable participant UUID on sends.
- `src/chat/portalApi.js`: includes `participant_id` in client/freelancer send requests.
- `src/chat/PortalChatSurface.jsx`: uses only the server-provided `mine` flag; removes sender-kind/display-name inference.
- `supabase/functions/portal-chat/index.ts`: validates participant UUIDs for sends and passes identity to the reader/writer RPCs.
- `supabase/migrations/20261108090000_portal_message_participant_identity.sql`: stores sender participant identity, updates idempotency uniqueness, and returns a message-level `mine` flag.
- `src/chat/portalReplyReactions.test.mjs`: adds regression coverage.

## Apply and verify
1. Copy these files into the matching paths in your repository.
2. Run `node --test src/chat/portalReplyReactions.test.mjs`.
3. Run `npm run build`.
4. Review the migration, then apply it to Supabase only when you explicitly choose to.

The migration has NOT been applied. No functions have been deployed. Nothing has been committed or pushed.

Historical client/freelancer messages have no stored participant UUID, so the server cannot safely identify them as belonging to a particular browser participant. They will be treated as not-mine rather than guessed from names.
