# KairFlow Chat & Collaboration — Rollout and Security Notes

## Status and scope

This implementation adds authenticated **internal** one-to-one, group, and project-linked chat. It uses Supabase Auth identities and introduces the smallest additive studio organization/membership/department tables needed to authorize cross-account chat. It does not replace KairFlow's existing login, `user_settings`, Finance access controls, or client portal.

The existing client portal supports token/guest workflows; this repository does not establish a verified authenticated client identity and trusted client-to-project membership suitable for RLS. For that reason, this release intentionally blocks client accounts from internal chat and does not create client-facing chat. Client discussion should be added only after client Auth identity and project relationship authorization are designed and tested.

The additive multi-user migration provides explicit opt-in sharing for existing workspaces and explicit project assignments. A user cannot access a project just because they were added to chat; the Master User must share the project's owner's workspace and assign project access. Assignment is synchronized with project-chat membership, and revocation removes that access. Existing data not mapped/shared remains owner-scoped. Multi-organization membership is separate from workspace ownership: one authenticated login can hold a Master User membership in one studio and a staff/freelancer/department-admin membership in another. Accepting an invite inserts or updates only the membership for the invited organization, never changes roles in other organizations, and never changes `studio_data_owners`. The selected organization is loaded through a dedicated, membership-checked access-context RPC.

The Master User may administer groups and project conversations and can view studio membership/audit metadata. The Master User does **not** get message-body access to private direct messages unless they are a participant. This is a deliberate privacy boundary, not an accidental missing button.

## What is included

- Direct messages with canonical participant-pair uniqueness.
- Group conversations with member addition/removal, group rename, ownership transfer, and membership history metadata. Project conversations also honor the explicit project-assignment model added by the second migration.
- Persisted plain-text messages; replies; edit history; soft deletion; quick emoji reactions; pins.
- Per-user read cursor and unread count, durable message pagination, authorized full-text search.
- Private Storage attachments (20 MiB maximum per file, MIME allowlist) and 60-second signed download URLs.
- Realtime Postgres changes, private Broadcast typing, and ephemeral Presence with cleanup/reconnect refresh.
- Master-only studio member management, departments, membership suspension/reactivation, workspace-sharing controls, project assignments, department permissions, and business/chat audit metadata.
- An additive multi-user migration that retains each row's original `user_id`, enables explicitly authorized reads/updates of supported projects, shots, CRM leads, contacts, Teams records, activity history, and read-only invoice/expense rows, and keeps existing Finance ledger writes owner-checked through existing RPCs.
- Existing notification center reuse via `activity_log` event type `chat_message`, without copying message bodies or attachment paths into notification metadata.

## Identity and permissions

A person's authenticated identity is always `auth.uid()`, never a client-provided display name or author ID. Writes occur through granted `SECURITY DEFINER` RPCs with fixed search paths, argument validation, and authorization checks. Authenticated clients get read-only SQL grants for chat tables, subject to RLS; direct INSERT/UPDATE/DELETE on protected records is not granted. Audit rows and edit history are not directly mutable by authenticated clients.

`studio_memberships.role` supports `master_user`, `department_admin`, `staff`, `freelancer`, and `client`; internal chat rejects the client role. The same `auth.users.id` may have a different role per organization, and the `(organization_id, user_id)` key means membership identity is not globally unique by user. The one-active-Master constraint is also per organization. Normal invitation RPCs cannot assign the Master User role. A trusted database operator or the protected new-owner bootstrap establishes a studio's initial Master User.

Teams remains the roster of record. A Master User picks a roster entry with a valid email and generates a single-use invite. The link binds to the roster email, token hash, organization, department, and role; it expires after seven days and is consumed once. A person without an account can sign up from the invitation; the auth trigger validates the email/token and deliberately skips creating a separate studio for invite signup. An already-authenticated Master User can accept the invitation with that same login. The new membership is scoped only to the invited organization; their other studio role and workspace owner mapping stay unchanged.

## Pre-deployment checks — do not skip

1. Review the migrations `20261029090000_chat_collaboration.sql`, `20261030090000_studio_multiuser_core.sql`, `20261031090000_studio_team_invites_and_bootstrap.sql`, and `20261031100000_multi_organization_memberships.sql` as complete SQL units in timestamp order.
2. Confirm the intended database and applied history in `supabase_migrations.schema_migrations`. This repository also contains root-level legacy SQL files; do not assume those are the CLI migration history.
3. Confirm the actual schema of `projects`, `shots`, `leads`, `contacts`, `team_members`, `invoices`, `expenses`, and `activity_log`, including ownership columns and every existing RLS policy that may combine permissively with the new policies.
4. Back up the target database under the normal operational procedure.
5. Run `npx supabase db push --dry-run` against the correct linked project and review the proposed migrations. The multi-organization follow-up migration has not been applied by this work.
6. Apply only after explicit approval and after validating on a non-production environment. Bootstrap a Master User only for a genuinely new studio; never rerun the bootstrap for an existing organization.
7. Verify the `chat-attachments` bucket is private, the bucket limit/MIME allowlist is correct, Storage policies are active, and `supabase_realtime` includes the intended tables. Confirm private Broadcast/Presence policies using two authenticated test accounts.
8. Deploy the frontend through the existing release process after the migration is applied. No Edge Function is required specifically for chat.

No migration, Storage configuration, Realtime configuration, or deployment has been applied by this implementation session.

## One-time Master User bootstrap

**Do this only in the intended database, after approval, once the migration is applied. Replace the placeholders with the owner's verified login email, organization name, and a unique lowercase slug.** Do not pick the account from a user-editable profile flag. First ensure the selected identity is known to be the owner.

Run this in the trusted Supabase SQL Editor as a database administrator; this is not an application RPC and must not be exposed to normal users:

```sql
do $bootstrap$
declare
  v_matches uuid[];
  v_owner uuid;
  v_org uuid;
begin
  select array_agg(u.id) into v_matches
  from auth.users u
  where lower(u.email) = lower('REPLACE_WITH_VERIFIED_OWNER_EMAIL');

  if coalesce(array_length(v_matches, 1), 0) <> 1 then
    raise exception 'Expected exactly one verified owner account; found %',
      coalesce(array_length(v_matches, 1), 0);
  end if;
  v_owner := v_matches[1];

  insert into public.studio_organizations(name, slug, created_by)
  values ('REPLACE_WITH_STUDIO_NAME', 'replace-with-unique-slug', v_owner)
  returning id into v_org;

  insert into public.studio_memberships(organization_id, user_id, role, status, display_name, created_by)
  values (v_org, v_owner, 'master_user', 'active', 'REPLACE_WITH_OWNER_DISPLAY_NAME', v_owner);

  -- Explicitly maps the verified owner's existing workspace to the studio.
  -- This is a trusted operator decision; it is not inferred from is_admin/profile data.
  insert into public.studio_data_owners(user_id, organization_id, mapped_by)
  values (v_owner, v_org, v_owner);

  insert into public.studio_departments(organization_id, name, created_by)
  values (v_org, 'Sales', v_owner), (v_org, 'Production', v_owner),
         (v_org, 'Finance', v_owner), (v_org, 'Management', v_owner);
end
$bootstrap$;
```

This statement is intentionally not idempotent: a second run should stop on the unique slug constraint rather than silently create another studio. If the studio already exists, inspect the existing organization and memberships and use a reviewed, explicit repair statement rather than rerunning the bootstrap blindly.

After the required migrations and trusted bootstrap, sign in as the owner, open **Teams → Studio access**, verify that the selected organization matches the owner account, and invite people from the existing roster. A new invitee may create a login from the one-time link; an existing login (including a Master User in another organization) accepts the link with the already-confirmed invited email. Use workspace sharing only after making a deliberate data-sharing decision. Then use **Project access** to explicitly assign members to mapped projects, and configure department scopes as needed. Merely adding someone to a roster or organization does not grant every project or workspace record.

## Test plan before production

Use at least two staff test accounts plus one ordinary authenticated account outside the organization. Verify:

- Multi-organization acceptance: create two disposable studios with distinct Master Users; invite the first studio's Master User email into the second studio as ordinary staff; accept using the same existing auth account; verify the first membership remains `master_user` and active, the second membership has only the invited role, and the `studio_data_owners` mapping is unchanged.
- Organization switching: switch between both studios and verify the active header, module permissions, data queries, Chat directory/conversation list, department administration, and project assignments use only the selected organization. The Master User of Studio A must not become an administrator in Studio B.
- Organization isolation: verify the invited user cannot read Studio B records without the relevant department/module permission or project assignment, and cannot read Studio A records while operating in Studio B. Removing or suspending the Studio B membership must revoke access to that studio without affecting Studio A.
- Non-members cannot list organizations/conversations, guess IDs, read messages, search messages, or retrieve storage objects.
- A normal member cannot write raw rows directly or spoof `sender_user_id` via the browser/Supabase API.
- Direct-message idempotency prevents duplicate records after a retried request; reused keys with different content are rejected.
- Group membership changes take effect after refresh and stale members lose access to new messages and attachments.
- The Master User can administer group/project conversations and inspect audit metadata, but cannot read another user's private DM body. Project conversations include the project owner and Master User as members; other staff cannot be added until shared-project access exists.
- Department administrators get only their scoped administrative operations and do not become Master Users.
- Clients and accounts with no organization membership cannot access internal conversations or the private bucket.
- Unshared legacy projects remain owner-only. After the workspace owner is explicitly shared with the studio, project access must be assigned through Master User administration; chat membership alone is insufficient.
- A message persists after refresh, duplicate Realtime events do not duplicate the message, and reconnection refreshes durable state.
- Notification center click-through opens the correct conversation/message and no private body or attachment path is added to notification metadata.
- Existing finance/ledger, client review, Teams, project pipeline, Drive, and existing notification workflows still pass their regression tests.

Automated client helper tests exist at `src/chat/logic.test.mjs`. The provided snapshot's test command also has existing environment-dependent failures in `.ts` Edge Function imports under Node 22, and the archived `node_modules` is Windows-specific; see the implementation report for actual verification results.

## Known limitations / next safe dependencies

- Client-facing chat requires a trusted authenticated client identity plus explicit client/project access model; intentionally not included.
- The core multi-user permission model is additive and currently covers selected owner-scoped records; all older modules, finance ledgers, client portal, and all write paths still need live-schema integration tests and follow-up review. The Finance ledger remains user-scoped and existing Finance RPCs are intentionally not broadened.
- The Teams invitation flow exists and supports both existing logins and invite-driven signup, but it requires real staging acceptance tests with multiple organizations before production use.
- Master User has no private-DM content override. If product governance later requires an emergency disclosure procedure, it should be a separately specified, audited, explicit security feature.
- RLS/Storage policy behavior and the multi-organization SQL override still require execution against a disposable Supabase environment and a live-schema comparison. The code-level contract tests do not substitute for a two-organization database test. A frontend build alone cannot establish security correctness.
