import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migration = readFileSync(resolve(root, 'supabase/migrations/20261030090000_studio_multiuser_core.sql'), 'utf8');
const compact = migration.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();

function functionBody(name) {
  const start = compact.indexOf(`create or replace function public.${name.toLowerCase()}(`);
  assert.notEqual(start, -1, `expected ${name} in multi-user migration`);
  const end = compact.indexOf('$$;', start);
  assert.notEqual(end, -1, `expected end of ${name}`);
  return compact.slice(start, end + 3);
}

test('multi-user access is explicit and does not share a member workspace just because they joined chat', () => {
  assert.ok(compact.includes('create table if not exists public.studio_data_owners'));
  assert.ok(compact.includes('revoke all on public.studio_data_owners from public, anon, authenticated'));
  const add = functionBody('chat_add_studio_member_with_workspace');
  assert.ok(add.includes('p_share_workspace_data'));
  assert.ok(add.includes("'workspace_already_linked_to_another_studio'"));
  assert.ok(add.includes('public.chat_is_org_master(p_organization_id)'));
});

test('department access stays scoped to owners in the same department', () => {
  const permission = functionBody('studio_user_has_app_permission');
  assert.ok(permission.includes('owner_dept.department_id = mine.department_id'));
  assert.ok(permission.includes("mine.department_role = 'admin'"));
  assert.ok(permission.includes("me.role = 'department_admin'"));
  assert.ok(compact.includes("access_scope text not null default 'department' check (access_scope = 'department')"));
});

test('project assignment is Master-controlled and synchronized to project conversations', () => {
  const assign = functionBody('studio_assign_project_access');
  const revoke = functionBody('studio_revoke_project_access');
  const projectAccess = functionBody('chat_user_can_access_project');
  const createConversation = functionBody('chat_create_conversation');
  assert.ok(assign.includes('public.chat_is_org_master(p_organization_id)'));
  assert.ok(assign.includes('insert into public.chat_conversation_members'));
  assert.ok(revoke.includes("set status='revoked'"));
  assert.ok(revoke.includes("set status='removed'"));
  assert.ok(projectAccess.includes('public.studio_project_members'));
  assert.ok(projectAccess.includes('join public.studio_data_owners project_owner'));
  assert.ok(projectAccess.includes('project_owner.organization_id = p_organization_id'));
  assert.ok(createConversation.includes('public.chat_user_can_access_project(p_organization_id,p.id,auth.uid())'));
  assert.ok(createConversation.includes('from public.studio_project_members pm'));
});

test('Master User and permission management are server-enforced, with no direct writes to security tables', () => {
  for (const table of ['studio_data_owners', 'studio_role_permissions', 'studio_department_permissions', 'studio_project_members', 'studio_audit_events']) {
    assert.ok(compact.includes(`alter table public.${table} enable row level security`), table);
    assert.ok(compact.includes(`revoke all on public.${table} from public, anon, authenticated`), table);
  }
  for (const fn of ['studio_set_workspace_sharing', 'studio_set_department_permission', 'studio_assign_project_access', 'studio_revoke_project_access']) {
    assert.ok(functionBody(fn).includes('public.chat_is_org_master'), fn);
  }
});

test('business audit records metadata only and preserve original record ownership', () => {
  const audit = functionBody('studio_audit_app_record_trigger');
  const ownerGuard = functionBody('studio_preserve_record_owner');
  assert.ok(audit.includes("'changedcolumns',v_changed"));
  assert.ok(audit.includes("when 'insert' then 'created' when 'update' then 'updated' else 'deleted'"));
  assert.ok(ownerGuard.includes('new.user_id := old.user_id'));
  assert.ok(!migration.includes('new.message_body'));
});

test('multi-user migration does not broaden protected finance ledger writes', () => {
  assert.ok(compact.includes("'invoices.read','expenses.read'"));
  assert.ok(compact.includes('create policy studio_invoices_shared_select'));
  assert.ok(compact.includes('create policy studio_expenses_shared_select'));
  assert.ok(!compact.includes('create policy studio_journal_entries_shared'));
  assert.ok(!compact.includes('create policy studio_bank_accounts_shared'));
  assert.ok(!compact.includes('grant insert, update, delete on public.journal_entries'));
});

test('invoice-facing UI and PDFs show the Paystack payment reference instead of the invoice number', () => {
  const app = readFileSync(resolve(root, 'src/App.jsx'), 'utf8');
  const sales = readFileSync(resolve(root, 'src/finance/Sales.jsx'), 'utf8');
  const payments = readFileSync(resolve(root, 'src/payments/PaymentsModule.jsx'), 'utf8');
  assert.ok(app.includes('"Payment ref."'));
  assert.ok(app.includes('doc.text(`${referenceLabel}: ${paystackRef}`'));
  assert.ok(!app.includes('doc.text(`${referenceLabel}: ${invoice.invoiceNumber'));
  assert.ok(sales.includes('label: "Payment ref."'));
  assert.ok(sales.includes('refOf(r.inv)'));
  assert.ok(payments.includes('label: "Invoice Ref."'));
});
