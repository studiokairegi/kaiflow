# Contacts & Clients

## What changed
- **CRM > Contacts** tab (next to Pipeline in the Leads workspace): search by name/email/company, Clients/Prospects filter, detail pane with linked deals and projects, create/edit, "Import clients from won deals".
- **Won deals**: the moment a lead transitions into `won` (board drag, lead editor, or Mark won) the database links it to a client contact: its already-linked contact, else an existing contact with the same normalized email, else a new contact built from the deal. Repeated saves of a won deal do nothing. Mark won then prefills the New Project form with that contact.
- **New / Edit Project**: the Client text box is now a searchable selector (name, company, email; shows company/email to tell similar names apart). "+ Add new contact" creates one inline (name required; email, company optional) after a duplicate check, then selects it. The project stores `contact_id`; the legacy `projects.client` text is still written (set to the contact's name), so invoices, shot cards and dashboards are unchanged.
- If contacts can't load (migration not applied), the selector falls back to the old plain text field.

## Duplicate rules
- One contact per normalized (trimmed, lower-cased) email per user: enforced by a unique index.
- Same-name/company look-alikes are shown, never merged; the user picks "Use this one" or "Create anyway".
- Create is idempotent per form (request key), so double-clicks and retries return the first row.

## Deploy
1. Apply `supabase/migrations/20261012120000_contacts_clients.sql` (after all existing migrations; additive).
2. Optionally run `contacts_tests.sql` first on a non-production project.
3. Deploy the front end. No Edge Function changes.
4. In CRM > Contacts click "Import clients from won deals" once to cover deals won before this feature.

## Not done / notes
- No lead-editor contact picker: a lead is linked at Won (by email or new contact), via the backfill, or through a project. Existing legacy project client names are NOT matched by name; link them by editing the project.
- Attaching a contact to a project promotes a prospect to client (by design; reversible on the Contacts page).
- Two people sharing one mailbox can't both be saved with that email (unique per user).
