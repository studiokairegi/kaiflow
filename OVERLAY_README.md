# KairFlow Teams-first onboarding and floating chat overlay

This overlay contains the current implementation source for the Teams-first multi-user onboarding flow and the floating chat popup.

## Important integration notes

- Merge these files into the matching paths in your current KairFlow checkout. Do not blindly overwrite a newer local file; compare it first and preserve unrelated changes.
- Chat stays out of the main workspace/module navigation. It is opened from the floating bottom-right launcher.
- Teams remains the source of truth for freelancer/staff roster records and shot assignments. A permanent app login is linked to the selected existing `team_members` row only after the one-time invite is accepted.
- A roster entry does not need an account to be added or assigned to a shot. The existing `shots.assigned_member_id` remains intact.
- The new migration is additive: `supabase/migrations/20261031090000_studio_team_invites_and_bootstrap.sql`.
- Do not run the new migration against production until it has been reconciled with the live `supabase_migrations.schema_migrations` table and successfully tested on a staging Supabase project. It is not applied by this bundle.
- Do not rerun the previous Studio Kairegi Master User bootstrap. The existing studio should remain the one linked to your verified Master User.
- The auth trigger provisions a new standalone signup as the Master User of a new studio. Invite signups must use the invite token and invited email; otherwise signup fails closed.

## Files in this overlay

- `src/App.jsx`
- `src/chat/ChatPage.jsx`
- `src/chat/api.js`
- `src/chat/chat.css`
- `src/settings/SettingsPage.jsx`
- `src/studio/access.js`
- `src/studio/access.test.mjs`
- `src/studio/TeamAccessPanel.jsx`
- `src/studio/teamAccess.css`
- `src/studio/invite.css`
- `src/studio/rollout-contract.test.mjs`
- `supabase/migrations/20261031090000_studio_team_invites_and_bootstrap.sql`

## Local verification

```sh
npm ci
node --test src/studio/access.test.mjs src/studio/multiUserMigration.test.mjs src/studio/rollout-contract.test.mjs
npm test
npm run build
```

Do these from your local project checkout. The audit environment has no installed `node_modules`, so `npm run build` could not run here. The rollout report states the test result observed in the uploaded source snapshot.
