KairFlow Inbox conversation-composer correction

Changes:
- Removed Reply and Reply all message actions. Forward remains available.
- Existing conversations use the persistent bottom writing composer.
- The composer automatically addresses the other conversation participants, excluding the user's own sending addresses.
- The subject is automatically prefixed with Re: (without duplicating an existing prefix).
- Removed quoted-reply context from the composer; users write a clean message.
- Sending continues through the existing emailApi.send path with the existing conversationId, preserving email-thread handling.

Integrate src/email/InboxModule.jsx into the working repository. This is a source-file update only; it has not been deployed or tested against live email delivery.
