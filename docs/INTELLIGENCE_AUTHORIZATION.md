# KairFlow Intelligence: authorization

**Rule (both mandatory, neither substitutes for the other):**
`auth.uid()` exists AND that user's `user_settings.is_admin = true` AND that user has an active
`studio_memberships` row with `role = 'master_user'`.

| Account | Access |
|---|---|
| Admin + active Master User | Allowed |
| Master without admin / admin without Master / inactive Master / department admin / employee / freelancer / client / no settings row / unauthenticated | Denied |

## Building blocks
- `public.intel_is_authorized()`: the rule, any studio. Used for navigation and objects with no organization.
- `public.intel_is_authorized(organization_id)`: the rule with the Master membership in that studio. Use in RLS for any table with an organization column.
- `public.intel_require_authorized()`: first statement of every user-facing Intelligence RPC. Raises 28000 (no user) or 42501 (restricted).
- `supabase/functions/_shared/intel_auth.ts`: call before ANY service-role work in an Edge Function.
- `src/intelligence/access.js`: UI only. The tab is a convenience; the database is the control.

## Rules for every future Intelligence object
1. Table: `enable row level security`, revoke all from `anon, authenticated`, then policies using `intel_is_authorized(...)` for `USING` and `WITH CHECK`. Never a policy that checks only one half.
2. RPC: `security definer`, `set search_path = pg_catalog, public`, first line `perform public.intel_require_authorized();`, execute granted to `authenticated` only.
3. Edge Function: `requireIntelligenceAdmin(req, ...)` first. The service-role key makes `auth.uid()` null, so the SQL helpers return false there. That is intentional.
4. Worker: separate agent identity with `intel_agent_*` RPCs only. It never receives user-facing RPC grants and never makes another user authorized. User-initiated actions (start campaign, approve send) go through the user RPCs and enqueue a job; the worker does not accept authorization claims.
5. Never grant `is_admin` or Master User from Intelligence code.
