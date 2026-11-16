"""Seven-phase roadmap, Phase 7: whole-repository production-validation checks that need no network, no database and no key.

These are SOURCE-LEVEL checks. They read the migration files and the worker code; they do not run SQL, so they prove what the files say, not
what a live database does. Each one guards a property that Phase 7 relies on for a safe rollout and that a later edit could break silently:

  * the migration set is orderly (unique versions, known duplicate names, known stray files) and cannot gain a new destructive statement
    (drop table / truncate / drop column / column type change) without someone editing the allowlist here on purpose (Global Rule 6);
  * the privilege model: after every migration is replayed in order, NO intel_* function can be executed by PUBLIC or anon, the private
    _intel_* helpers are not callable by signed-in users, every admin RPC calls the owner guard and every agent RPC calls the agent guard
    (or is service_role-only and says so);
  * the job-kind constraint in the database accepts exactly the kinds the worker handles;
  * the safe defaults (sending off, autonomy shadow) and the checks inside the final send reservation;
  * the shadow-mode metrics SQL pack is read-only and only names tables and columns that exist.

The detectors are themselves tested against small synthetic migration sets, so a detector that silently stopped working would fail here.
"""
import re
import tempfile
import unittest
from pathlib import Path

from kairflow_intel import jobs

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase" / "migrations"
P7 = ROOT / "docs" / "production-roadmap-phase7"
PACK = P7 / "SHADOW_MODE_METRICS.sql"


# --------------------------------------------------------------------------------------------------------------------------------
# A small SQL reader (not a SQL parser): enough to follow create/drop function, grant/revoke and the DO-loop bulk revokes the repo uses.
# --------------------------------------------------------------------------------------------------------------------------------
def _drop_line_comment(line: str) -> str:
    """Remove a trailing `-- comment` unless the dashes sit inside a single-quoted string."""
    inside = False
    for i, ch in enumerate(line):
        if ch == "'":
            inside = not inside
        elif ch == "-" and not inside and line.startswith("--", i):
            return line[:i].rstrip()
    return line


def strip_sql(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return "\n".join(_drop_line_comment(l) for l in text.splitlines() if not l.strip().startswith("--"))


def read_migrations(directory: Path) -> list[tuple[str, str]]:
    out = []
    for p in sorted(directory.glob("*.sql")):
        out.append((p.name, strip_sql(p.read_text(encoding="utf-8", errors="replace"))))
    return out


def split_top(s: str) -> list[str]:
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return out


_TYPE_ALIAS = {"int": "integer", "int4": "integer", "int8": "bigint", "bool": "boolean", "timestamp with time zone": "timestamptz",
               "character varying": "text", "varchar": "text"}


def types_from_sig(sig: str) -> tuple:
    sig = sig.strip()
    if not sig:
        return ()
    out = []
    for arg in split_top(sig):
        arg = re.sub(r"\s+default\s+.*$", "", arg.strip(), flags=re.I | re.S)
        toks = arg.split()
        if len(toks) >= 2 and toks[0].lower() in ("in", "out", "inout", "variadic"):
            toks = toks[1:]
        if len(toks) >= 2 and re.match(r"^(p_|_|v_)", toks[0]):
            ty = " ".join(toks[1:])
        elif len(toks) == 2 and toks[0].lower() not in ("timestamp", "double", "character") and toks[1].lower() not in ("zone", "varying", "precision"):
            ty = toks[1]
        else:
            ty = " ".join(toks)
        ty = _TYPE_ALIAS.get(ty.lower(), ty.lower())
        out.append(re.sub(r"\s+", "", ty))
    return tuple(out)


def _like_to_re(pattern: str):
    pattern = pattern.replace("\\_", "\x00").replace("_", ".").replace("\x00", "_")
    return re.compile("^" + pattern.replace("%", ".*") + "$")


_CREATE = re.compile(r"create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\((.*?)\)\s*returns", re.I | re.S)
_DROP = re.compile(r"drop\s+function\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)\s*\(([^)]*)\)", re.I)
_GR = re.compile(r"(grant|revoke)\s+(?:all|execute)(?:\s+privileges)?\s+on\s+function\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s+(?:to|from)\s+([^;]+);", re.I)
_DO = re.compile(r"do\s+\$\$.*?\$\$\s*;", re.I | re.S)


def simulate_function_acl(migrations: list[tuple[str, str]]):
    """Replay create / drop / grant / revoke and the bulk `for r in select ... from pg_proc ... revoke ... from public, anon` loops in file
    order. A function starts executable by PUBLIC (the Postgres default); DROP + CREATE resets it; CREATE OR REPLACE keeps it.
    Returns {(name, argtypes): {public, anon, authenticated, service_role}} for the final state."""
    acl: dict = {}
    for _fname, text in migrations:
        events = []
        for m in _CREATE.finditer(text):
            events.append((m.start(), "create", m.group(1), types_from_sig(m.group(2))))
        for m in _DROP.finditer(text):
            events.append((m.start(), "drop", m.group(1), types_from_sig(m.group(2))))
        for m in _GR.finditer(text):
            events.append((m.start(), m.group(1).lower(), m.group(2), types_from_sig(m.group(3)), [r.strip().strip("'\"") for r in m.group(4).lower().split(",")]))   # also reads statements issued through EXECUTE '...'
        for m in _DO.finditer(text):
            blk = m.group(0)
            if re.search(r"revoke\s+all\s+on\s+function\s+%s\s+from\s+public", blk, re.I):
                # Split at LOOP: the SELECT before it says WHICH functions the loop visits; the body after it says which of them are exempted
                # from the grant to authenticated (private helpers and named exceptions such as intel_is_authorized_user).
                head, body = (re.split(r"(?i)\bloop\b", blk, maxsplit=1) + [""])[:2]
                pats = [_like_to_re(x) for x in re.findall(r"proname\s+like\s+'([^']*)'", head)]
                names = re.findall(r"proname\s+=\s+'([^']*)'", head)
                grants_auth = bool(re.search(r"grant\s+execute\s+on\s+function\s+%s\s+to\s+authenticated", blk, re.I))
                exempt_pats = [_like_to_re(x) for x in re.findall(r"proname\s+like\s+'([^']*)'", body)]
                exempt_names = re.findall(r"proname\s+=\s+'([^']*)'", body)
                events.append((m.start(), "bulk", pats, names, grants_auth, exempt_pats, exempt_names))
        for ev in sorted(events, key=lambda e: e[0]):
            kind = ev[1]
            if kind == "create":
                acl.setdefault((ev[2], ev[3]), {"public": True, "anon": False, "authenticated": False, "service_role": False})
            elif kind == "drop":
                acl.pop((ev[2], ev[3]), None)
            elif kind in ("grant", "revoke"):
                key = (ev[2], ev[3])
                a = acl.get(key)
                if a is None:
                    cands = [k for k in acl if k[0] == ev[2]]
                    if len(cands) != 1:
                        continue
                    a = acl[cands[0]]
                for role in ev[4]:
                    if role in a:
                        a[role] = (kind == "grant")
            else:
                pats, names, grants_auth, exempt_pats, exempt_names = ev[2], ev[3], ev[4], ev[5], ev[6]
                for (name, _t), a in acl.items():
                    if any(p.match(name) for p in pats) or name in names:
                        a["public"] = False
                        a["anon"] = False
                        if any(p.match(name) for p in exempt_pats) or name in exempt_names:
                            a["authenticated"] = False
                        elif grants_auth:
                            a["authenticated"] = True
    return acl


def latest_function_bodies(migrations: list[tuple[str, str]]) -> dict:
    """{(name, argtypes): (file, text)} using the LAST definition of each function."""
    out = {}
    for fname, text in migrations:
        starts = [m.start() for m in re.finditer(r"create\s+(?:or\s+replace\s+)?function\s+public\.", text, re.I)]
        for i, s in enumerate(starts):
            blk = text[s:starts[i + 1] if i + 1 < len(starts) else len(text)]
            m = _CREATE.match(blk)
            if m:
                out[(m.group(1), types_from_sig(m.group(2)))] = (fname, blk)
    return out


def table_columns(migrations: list[tuple[str, str]]) -> dict:
    cols: dict = {}
    for _f, text in migrations:
        for m in re.finditer(r"create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)\s*\((.*?)\)\s*;", text, re.I | re.S):
            for item in split_top(m.group(2)):
                it = item.strip()
                if not it or re.match(r"^(constraint|primary|unique|foreign|check|exclude|like)\b", it, re.I):
                    continue
                mm = re.match(r'^"?([a-z_][a-z0-9_]*)"?\s+', it, re.I)
                if mm:
                    cols.setdefault(m.group(1), set()).add(mm.group(1).lower())
        for m in re.finditer(r"alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?public\.([a-z0-9_]+)\s+(.*?);", text, re.I | re.S):
            for part in split_top(m.group(2)):
                a = re.match(r'\s*add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s+', part, re.I)
                if a:
                    cols.setdefault(m.group(1), set()).add(a.group(1).lower())
                d = re.match(r'\s*drop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?', part, re.I)
                if d:
                    cols.get(m.group(1), set()).discard(d.group(1).lower())
    return cols


_DESTRUCTIVE = [
    ("drop table", re.compile(r"drop\s+table\s+(?:if\s+exists\s+)?([a-z0-9_.\"]+)", re.I)),
    ("truncate", re.compile(r"truncate\s+(?:table\s+)?([a-z0-9_.\"]+)", re.I)),
    ("drop column", re.compile(r"drop\s+column\s+(?:if\s+exists\s+)?\"?([a-z0-9_]+)", re.I)),
    ("alter column type", re.compile(r"alter\s+column\s+\"?([a-z0-9_]+)\"?\s+(?:set\s+data\s+)?type\b", re.I)),
    ("drop schema", re.compile(r"drop\s+schema\s+(?:if\s+exists\s+)?([a-z0-9_]+)", re.I)),
]


def destructive_statements(migrations: list[tuple[str, str]], name_filter=r"intelligence|email") -> set:
    found = set()
    for fname, text in migrations:
        if not re.search(name_filter, fname):
            continue
        for kind, pat in _DESTRUCTIVE:
            for m in pat.finditer(text):
                target = m.group(1).lower().replace("public.", "")
                if target.startswith("pg_temp"):
                    continue          # session-local scratch tables of the re-evaluation functions
                found.add((fname, kind, target))
    return found


# --------------------------------------------------------------------------------------------------------------------------------
class MigrationLedgerTests(unittest.TestCase):
    NAMES_REPEATED_AT_DIFFERENT_VERSIONS = {
        "intelligence_phase2_reengagement_scan.sql",
        "intelligence_resend_kill_switch.sql",
        "intelligence_phase2_global_send_pacing.sql",
        "intelligence_phase2_send_slot_enforcement.sql",
        "intelligence_phase2_fixes.sql",
        "intelligence_phase2_evidence_trace.sql",
        "intelligence_authorization.sql",
        "intelligence_core_tables.sql",
        "intelligence_crm_notifications.sql",
        "intelligence_rpcs.sql",
        "intelligence_zoho_oauth.sql",
    }
    KNOWN_STRAY_FILES: set = set()      # the four old backups were removed after Phase 7; nothing non-.sql is expected here any more

    def test_every_sql_migration_has_a_unique_fourteen_digit_version(self):
        names = [p.name for p in MIG.glob("*.sql")]
        self.assertTrue(names)
        versions = []
        for n in names:
            m = re.match(r"^(\d{14})_[a-z0-9_]+\.sql$", n)
            self.assertIsNotNone(m, f"unusual migration file name: {n}")
            versions.append(m.group(1))
        self.assertEqual(len(versions), len(set(versions)), "two migrations share a version, so the CLI would refuse or mis-order them")

    def test_repeated_migration_names_are_exactly_the_known_set(self):
        seen: dict = {}
        for p in MIG.glob("*.sql"):
            seen.setdefault(re.sub(r"^\d+_", "", p.name), []).append(p.name)
        repeated = {k for k, v in seen.items() if len(v) > 1}
        self.assertEqual(repeated, self.NAMES_REPEATED_AT_DIFFERENT_VERSIONS,
                         "a migration name now repeats at a new version; read MIGRATION_LEDGER.md before adding it to the known set")

    def test_stray_non_sql_files_in_the_migrations_folder_are_exactly_the_known_backups(self):
        stray = {p.name for p in MIG.iterdir() if p.is_file() and not p.name.endswith(".sql")}
        self.assertEqual(stray, self.KNOWN_STRAY_FILES, "a new stray file landed in supabase/migrations (the CLI skips it, but it hides history)")

    def test_no_backup_or_before_fix_copies_in_deployable_or_worker_folders(self):
        pat = re.compile(r"(\.bak($|-)|\.before-|\.pre-fix|\.orig$|\.rej$|-backup(\.|$)|\.audit-backup$|production-backup)", re.I)
        offenders = []
        for rel in ("supabase/migrations", "supabase/functions", "supabase/tests", "intelligence-worker/kairflow_intel", "intelligence-worker/tests"):
            base = ROOT / rel
            offenders += [str(p.relative_to(ROOT)) for p in base.rglob("*") if p.is_file() and "node_modules" not in p.parts and pat.search(p.name)]
        self.assertEqual(sorted(offenders), [], "old backup copies belong in git history, not beside live code (they can be deployed or imported by mistake)")

    def test_job_kind_constraint_accepts_exactly_the_kinds_the_worker_handles(self):
        last = None
        for fname, text in read_migrations(MIG):
            m = re.search(r"intel_jobs_kind_check\s+check\s*\(\s*kind\s+in\s*\((.*?)\)\s*\)", text, re.I | re.S)
            if m:
                last = (fname, set(re.findall(r"'([a-z_]+)'", m.group(1))))
        self.assertIsNotNone(last)
        fname, kinds = last
        self.assertEqual(kinds, set(jobs.HANDLERS),
                         f"{fname} is the last migration that sets intel_jobs_kind_check; it must list exactly the worker's job kinds "
                         f"(missing in DB: {sorted(set(jobs.HANDLERS) - kinds)}, no handler: {sorted(kinds - set(jobs.HANDLERS))})")


class DestructiveDdlTests(unittest.TestCase):
    # The only real destructive DDL in the Intelligence and Email migrations. It is deliberate, it backfills first and verifies, and it MUST NOT
    # be applied without the owner's explicit authorization and a table export (PRODUCTION_ROLLOUT_PLAN.md, ROLLBACK_PROCEDURES.md).
    ALLOWED = {
        ("20261217090000_intelligence_remove_legacy_mailbox.sql", "drop table", "intel_mail_account"),
        ("20261217090000_intelligence_remove_legacy_mailbox.sql", "drop table", "intel_oauth_states"),
    }

    def test_no_new_destructive_ddl_in_intelligence_or_email_migrations(self):
        self.assertEqual(destructive_statements(read_migrations(MIG)), self.ALLOWED,
                         "destructive DDL changed; Global Rule 6 needs explicit owner authorization and a rollback note")

    def test_detector_flags_each_destructive_form_and_ignores_session_temp_tables(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "20300101000000_intelligence_x.sql").write_text(
                "drop table if exists public.intel_jobs;\ntruncate public.intel_prospects;\n"
                "alter table public.intel_messages drop column if exists body_text;\n"
                "alter table public.intel_messages alter column step type bigint;\n"
                "drop table if exists pg_temp._scratch;\ntruncate pg_temp._scratch;\n"
                "-- drop table public.in_a_comment;\n", encoding="utf-8")
            found = destructive_statements(read_migrations(Path(d)))
        kinds = {(k, t) for _f, k, t in found}
        self.assertEqual(kinds, {("drop table", "intel_jobs"), ("truncate", "intel_prospects"), ("drop column", "body_text"),
                                 ("alter column type", "step")})


class FunctionPrivilegeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.migs = read_migrations(MIG)
        cls.acl = simulate_function_acl(cls.migs)
        cls.latest = latest_function_bodies(cls.migs)

    def test_no_intel_function_is_executable_by_public_or_anon_after_every_migration(self):
        exposed = sorted(f"{n}{t}" for (n, t), a in self.acl.items() if re.match(r"^_?intel_", n) and (a["public"] or a["anon"]))
        self.assertEqual(exposed, [], "these functions can be called without signing in (the guard would still refuse, but the grant is wrong)")

    def test_private_underscore_helpers_are_not_callable_by_signed_in_users(self):
        callable_ = sorted(f"{n}{t}" for (n, t), a in self.acl.items() if n.startswith("_intel_") and a["authenticated"])
        self.assertEqual(callable_, [])

    def test_the_final_state_tracks_a_realistic_number_of_functions(self):
        # Guards the detector itself: if the reader stopped recognising the repo's statements this count collapses.
        intel = [k for k in self.acl if re.match(r"^_?intel_", k[0])]
        self.assertGreater(len(intel), 150)
        self.assertGreater(sum(1 for k in intel if k[0].startswith("intel_admin_")), 40)
        self.assertGreater(sum(1 for k in intel if k[0].startswith("intel_agent_")), 60)

    def test_every_admin_rpc_calls_the_owner_guard(self):
        guard = re.compile(r"intel_admin_org\s*\(|intel_require_authorized\s*\(")
        unguarded = sorted(f"{n}{t} ({f})" for (n, t), (f, body) in self.latest.items() if n.startswith("intel_admin_") and not guard.search(body))
        self.assertEqual(unguarded, [])

    def test_every_agent_rpc_calls_the_agent_guard_or_is_service_role_only(self):
        guard = re.compile(r"intel_agent_org\s*\(")
        exceptions = []
        for (n, t), (f, body) in self.latest.items():
            if n.startswith("intel_agent_") and not guard.search(body):
                exceptions.append((n, t, f, body))
        self.assertEqual([e[0] for e in exceptions], ["intel_agent_apply_delivery_event"])
        name, types, _f, body = exceptions[0]
        self.assertRegex(body, r"auth\.role\(\)[^;]*<>\s*'service_role'")
        a = self.acl[(name, types)]
        self.assertTrue(a["service_role"])
        self.assertFalse(a["authenticated"] or a["anon"] or a["public"])

    def test_the_resend_inbound_recorder_is_service_role_only(self):
        keys = [k for k in self.acl if k[0] == "intel_resend_record_inbound"]
        self.assertEqual(len(keys), 1)
        a = self.acl[keys[0]]
        self.assertTrue(a["service_role"])
        self.assertFalse(a["authenticated"] or a["anon"] or a["public"])
        self.assertRegex(self.latest[keys[0]][1], r"auth\.role\(\)[^;]*<>\s*'service_role'")

    def test_both_guards_fail_closed(self):
        admin = next(b for (n, _t), (_f, b) in self.latest.items() if n == "intel_admin_org")
        agent = next(b for (n, _t), (_f, b) in self.latest.items() if n == "intel_agent_org")
        self.assertIn("intel_require_authorized()", admin)
        self.assertRegex(admin, r"master_user")
        self.assertRegex(admin, r"raise exception")
        self.assertRegex(agent, r"auth\.uid\(\)\s+is\s+null")
        self.assertRegex(agent, r"Not the Intelligence agent")

    def test_every_security_definer_intel_function_pins_its_search_path(self):
        loose = sorted(f"{n}{t}" for (n, t), (_f, body) in self.latest.items()
                       if re.match(r"^_?intel_", n) and re.search(r"security\s+definer", body, re.I) and not re.search(r"set\s+search_path", body, re.I))
        self.assertEqual(loose, [])

    # -- the detector must catch the mistakes it exists to catch ------------------------------------------------------------
    def _replay(self, files: dict):
        with tempfile.TemporaryDirectory() as d:
            for name, text in files.items():
                (Path(d) / name).write_text(text, encoding="utf-8")
            return simulate_function_acl(read_migrations(Path(d)))

    LOOP = ("do $$ declare r record; begin for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on "
            "n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'intel\\_%' or p.proname like '\\_intel\\_%') loop "
            "execute format('revoke all on function %s from public, anon', r.sig); "
            "if r.proname like '\\_intel\\_%' then execute format('revoke all on function %s from authenticated', r.sig); "
            "else execute format('grant execute on function %s to authenticated', r.sig); end if; end loop; end $$;")

    def test_detector_flags_a_function_created_after_the_last_bulk_revoke(self):
        acl = self._replay({
            "20300101000000_a.sql": "create or replace function public.intel_agent_old(p_x uuid) returns jsonb language sql as $$ select 1 $$;\n" + self.LOOP,
            "20300102000000_b.sql": "create or replace function public.intel_agent_new(p_x uuid) returns jsonb language sql as $$ select 1 $$;",
        })
        self.assertFalse(acl[("intel_agent_old", ("uuid",))]["public"])
        self.assertTrue(acl[("intel_agent_old", ("uuid",))]["authenticated"])
        self.assertTrue(acl[("intel_agent_new", ("uuid",))]["public"], "a function with no revoke after it must be reported as exposed")

    def test_detector_flags_drop_and_recreate_that_resets_the_grant(self):
        acl = self._replay({
            "20300101000000_a.sql": "create function public.intel_agent_x(p_x uuid) returns jsonb language sql as $$ select 1 $$;\n" + self.LOOP,
            "20300102000000_b.sql": "drop function if exists public.intel_agent_x(uuid);\n"
                                    "create function public.intel_agent_x(p_x uuid) returns jsonb language sql as $$ select 2 $$;",
        })
        self.assertTrue(acl[("intel_agent_x", ("uuid",))]["public"])

    def test_detector_keeps_private_helpers_away_from_signed_in_users(self):
        acl = self._replay({"20300101000000_a.sql": "create function public._intel_helper(p_x uuid) returns jsonb language sql as $$ select 1 $$;\n" + self.LOOP})
        a = acl[("_intel_helper", ("uuid",))]
        self.assertFalse(a["public"] or a["anon"] or a["authenticated"])

    def test_detector_reads_revokes_issued_through_execute_strings_in_a_do_block(self):
        acl = self._replay({
            "20300101000000_a.sql": "create function public.intel_agent_hook(p_a text) returns jsonb language sql as $$ select 1 $$;\n" + self.LOOP,
            "20300102000000_b.sql": "do $$ begin if to_regprocedure('public.intel_agent_hook(text)') is not null then "
                                    "execute 'revoke all on function public.intel_agent_hook(text) from public, anon, authenticated'; "
                                    "execute 'grant execute on function public.intel_agent_hook(text) to service_role'; end if; end $$;"})
        a = acl[("intel_agent_hook", ("text",))]
        self.assertTrue(a["service_role"])
        self.assertFalse(a["public"] or a["anon"] or a["authenticated"])

    def test_without_the_phase_7_migration_the_bulk_loop_would_expose_the_service_role_functions(self):
        migs = [m for m in read_migrations(MIG) if not m[0].startswith("20270105090000_")]
        acl = simulate_function_acl(migs)
        exposed = sorted(n for (n, _t), a in acl.items() if n in ("intel_resend_record_inbound", "intel_agent_apply_delivery_event") and a["authenticated"])
        self.assertEqual(exposed, ["intel_agent_apply_delivery_event", "intel_resend_record_inbound"],
                         "if this stops being true the Phase 7 grant migration may be redundant; re-read MIGRATION_LEDGER.md")

    def test_detector_honours_a_named_exemption_in_the_bulk_loop(self):
        loop = self.LOOP.replace("if r.proname like '\\_intel\\_%' then", "if r.proname like '\\_intel\\_%' or r.proname = 'intel_is_authorized_user' then")
        self.assertIn("intel_is_authorized_user", loop)
        acl = self._replay({"20300101000000_a.sql": "create function public.intel_is_authorized_user(p_x uuid) returns boolean language sql as $$ select true $$;\n"
                                                    "create function public.intel_agent_ok(p_x uuid) returns jsonb language sql as $$ select 1 $$;\n" + loop})
        self.assertFalse(acl[("intel_is_authorized_user", ("uuid",))]["authenticated"], "named exemption must keep the function away from signed-in users")
        self.assertTrue(acl[("intel_agent_ok", ("uuid",))]["authenticated"])

    def test_the_real_replay_keeps_intel_is_authorized_user_away_from_signed_in_users(self):
        keys = [k for k in self.acl if k[0] == "intel_is_authorized_user"]
        self.assertTrue(keys)
        for k in keys:
            self.assertFalse(self.acl[k]["authenticated"] or self.acl[k]["anon"] or self.acl[k]["public"])

    def test_detector_honours_explicit_revoke_and_service_role_grant(self):
        acl = self._replay({"20300101000000_a.sql": "create function public.intel_agent_hook(p_a text, p_b timestamptz default null) returns jsonb "
                                                    "language sql as $$ select 1 $$;\n"
                                                    "revoke all on function public.intel_agent_hook(text,timestamp with time zone) from public, anon, authenticated;\n"
                                                    "grant execute on function public.intel_agent_hook(text,timestamptz) to service_role;"})
        a = acl[("intel_agent_hook", ("text", "timestamptz"))]
        self.assertTrue(a["service_role"])
        self.assertFalse(a["public"] or a["anon"] or a["authenticated"])


class SafeDefaultsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.migs = read_migrations(MIG)
        cls.latest = latest_function_bodies(cls.migs)

    def test_sending_is_off_and_autonomy_is_shadow_by_default(self):
        text = dict(self.migs)["20261109100000_intelligence_core_tables.sql"]
        self.assertRegex(text, r"kill_switch\s+boolean\s+not\s+null\s+default\s+true")
        self.assertRegex(text, r"autonomy\s+text\s+not\s+null\s+default\s+'shadow'")
        for fname, t in self.migs:
            self.assertNotRegex(t, r"kill_switch\s+boolean[^,;]*default\s+false", f"{fname} makes sending default to ON")
            self.assertNotRegex(t, r"autonomy\s+text[^,;]*default\s+'(assisted|autonomous)'", f"{fname} changes the autonomy default")

    def test_no_migration_inserts_a_settings_row_with_sending_enabled(self):
        for fname, t in self.migs:
            for m in re.finditer(r"insert\s+into\s+public\.intel_settings\s*\((.*?)\)\s*values\s*\((.*?)\)", t, re.I | re.S):
                cols = [c.strip().lower() for c in m.group(1).split(",")]
                vals = [v.strip().lower() for v in split_top(m.group(2))]
                if "kill_switch" in cols and len(cols) == len(vals):
                    self.assertNotEqual(vals[cols.index("kill_switch")], "false", f"{fname} creates settings with sending ON")

    def test_the_final_send_reservation_still_checks_the_kill_switch_suppression_approval_and_daily_caps(self):
        body = next(b for (n, _t), (_f, b) in self.latest.items() if n == "intel_agent_reserve_send")
        for needle, why in ((r"kill_switch", "kill switch"), (r"suppress", "suppression"), (r"approved", "approval state"),
                            (r"daily_(initial|followup)_cap|cap", "daily caps")):
            self.assertRegex(body, needle, f"intel_agent_reserve_send no longer mentions the {why}")

    def test_turning_sending_on_requires_sender_identity_and_a_registered_agent(self):
        body = next(b for (n, _t), (_f, b) in self.latest.items() if n == "intel_admin_set_kill_switch")
        for needle in (r"sender_email", r"physical_address", r"opt_out_text", r"agent_user_id", r"raise exception"):
            self.assertRegex(body, needle)

    def test_the_worker_has_no_code_path_that_writes_the_kill_switch(self):
        pkg = ROOT / "intelligence-worker" / "kairflow_intel"
        offenders = [p.name for p in pkg.glob("*.py") if re.search(r"intel_admin_set_kill_switch|p_kill_switch", p.read_text(encoding="utf-8"))]
        self.assertEqual(offenders, [], "only the owner's session may change the kill switch; the worker must never")


class MetricsPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = PACK.read_text(encoding="utf-8")
        cls.cols = table_columns(read_migrations(MIG))

    def _blocks(self):
        # a block = the comment lines above a statement, then the statement up to its semicolon
        blocks, cur = [], []
        for line in self.text.splitlines():
            cur.append(line)
            if line.rstrip().endswith(";") and not line.lstrip().startswith("--"):
                blocks.append("\n".join(cur))
                cur = []
        return blocks

    def test_the_pack_is_read_only(self):
        forbidden = re.compile(r"\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|execute|call|merge|vacuum|reindex)\b", re.I)
        n = 0
        for blk in self._blocks():
            sql = "\n".join(l for l in blk.splitlines() if not l.lstrip().startswith("--"))
            sql = re.sub(r"'[^']*'", "''", sql)
            self.assertRegex(sql.strip(), r"^(select|with)\b", sql[:80])
            self.assertIsNone(forbidden.search(sql), f"write or DDL keyword in: {sql[:100]}")
            n += 1
        self.assertGreaterEqual(n, 18)

    def test_every_query_declares_what_it_uses_and_everything_declared_exists(self):
        for blk in self._blocks():
            uses = re.findall(r"^--\s*uses:\s*(.+)$", blk, re.M)
            self.assertTrue(uses, f"no '-- uses:' line above: {blk.splitlines()[-1][:60]}")
            for decl in uses:
                for m in re.finditer(r"([a-z_]+)\(([^)]*)\)", decl):
                    table, columns = m.group(1), [c.strip() for c in m.group(2).split(",") if c.strip()]
                    self.assertIn(table, self.cols, f"unknown table {table}")
                    for c in columns:
                        self.assertIn(c, self.cols[table], f"{table}.{c} is not defined by any migration")

    def test_every_table_a_query_reads_is_declared_in_its_uses_line(self):
        for blk in self._blocks():
            declared = {m.group(1) for decl in re.findall(r"^--\s*uses:\s*(.+)$", blk, re.M) for m in re.finditer(r"([a-z_]+)\(", decl)}
            sql = "\n".join(l for l in blk.splitlines() if not l.lstrip().startswith("--"))
            used = set(re.findall(r"\bpublic\.([a-z_]+)", sql))
            self.assertLessEqual(used, declared, f"undeclared table in: {sql[:80]}")

    @staticmethod
    def _filter_clauses(sql: str):
        """Yield the text inside every `filter ( ... )` clause (balanced parentheses)."""
        for m in re.finditer(r"\bfilter\s*\(", sql, re.I):
            depth, i = 1, m.end()
            while i < len(sql) and depth:
                depth += (sql[i] == "(") - (sql[i] == ")")
                i += 1
            yield sql[m.end():i - 1]

    def test_no_query_puts_a_subquery_inside_an_aggregate_filter(self):
        # PostgreSQL: "cannot use subquery in FILTER expression". The reader cannot run SQL, so guard this known failure by shape.
        for blk in self._blocks():
            sql = "\n".join(l for l in blk.splitlines() if not l.lstrip().startswith("--"))
            for clause in self._filter_clauses(sql):
                self.assertNotRegex(clause, r"(?i)\bselect\b", f"subquery inside FILTER in: {sql[:80]}")

    def test_the_filter_subquery_detector_catches_the_known_failure(self):
        bad = "select count(*) filter (where d in (select d from t group by d)) from t;"
        self.assertTrue(any(re.search(r"(?i)\bselect\b", c) for c in self._filter_clauses(bad)))
        good = "select count(*) filter (where s.d is not null) from t left join s on s.d = t.d;"
        self.assertFalse(any(re.search(r"(?i)\bselect\b", c) for c in self._filter_clauses(good)))

    def test_the_schema_reader_understands_columns_added_by_alter_table(self):
        self.assertIn("ai_provider", self.cols["intel_chat_messages"])     # added by an ALTER whose CHECK clause contains commas
        self.assertIn("send_enabled", self.cols["intel_provider_accounts"])


class WorkerReportedMetricsMatchTheQueries(unittest.TestCase):
    def test_job_result_run_block_and_ai_counter_keys_are_what_queries_2_and_3_read(self):
        src = (ROOT / "intelligence-worker" / "kairflow_intel" / "jobs.py").read_text(encoding="utf-8")
        for key in ('"duration_ms"', '"ai_calls"', '"attempt"', '"worker_id"'):
            self.assertIn(key, src)
        gem = (ROOT / "intelligence-worker" / "kairflow_intel" / "gemini.py").read_text(encoding="utf-8")
        self.assertIn('self._usage["fallbacks"]', gem)
        self.assertIn("self._usage[res.provider]", gem)
        self.assertIn("'_run'", PACK.read_text(encoding="utf-8"))

    def test_heartbeat_publishes_the_counters_query_15_reads(self):
        src = (ROOT / "intelligence-worker" / "kairflow_intel" / "jobs.py").read_text(encoding="utf-8")
        for key in ('"jobs_succeeded"', '"jobs_failed"', '"started_at"', '"last_job_error"', '"scheduler_error"'):
            self.assertIn(key, src)


class Phase7DeliverablesTests(unittest.TestCase):
    REQUIRED = ("PRODUCTION_READINESS_REPORT.md", "END_TO_END_TEST_RESULTS.md", "PRODUCTION_ROLLOUT_PLAN.md", "ROLLBACK_PROCEDURES.md",
                "FINAL_PRODUCTION_HANDOFF.md", "MIGRATION_LEDGER.md", "SHADOW_MODE_METRICS.sql", "SEVEN_PHASE_MASTER_ROADMAP.md")

    def test_every_phase_7_deliverable_exists_and_is_not_empty(self):
        for name in self.REQUIRED:
            p = P7 / name
            self.assertTrue(p.is_file(), f"missing {name}")
            self.assertGreater(p.stat().st_size, 500, f"{name} looks empty")

    def test_the_final_handoff_confirms_sending_stays_disabled_and_the_live_gates_are_open(self):
        t = (P7 / "FINAL_PRODUCTION_HANDOFF.md").read_text(encoding="utf-8")
        self.assertRegex(t, r"(?i)outbound sending[^\n]*(remains|stays|is)[^\n]*disabled")
        self.assertRegex(t, r"(?i)NOT (READY|met)")

    def test_the_master_roadmap_records_phase_6_and_phase_7_progress(self):
        t = (P7 / "SEVEN_PHASE_MASTER_ROADMAP.md").read_text(encoding="utf-8")
        self.assertRegex(t, r"\*\*Phase 6[^\n]*\n")
        self.assertRegex(t, r"\*\*Phase 7 — Production Validation[^\n]*(PARTIAL|NOT READY)")

    def test_the_sql_contract_and_wrapper_for_the_phase_7_migration_exist_and_agree(self):
        mig = ROOT / "supabase" / "migrations" / "20270105090000_intelligence_phase7_service_role_grants.sql"
        wrapper = ROOT / "supabase" / "tests" / "run_intelligence_phase7.sh"
        sql_test = ROOT / "supabase" / "tests" / "intelligence_phase7_service_role_grants.test.sql"
        for p in (mig, wrapper, sql_test):
            self.assertTrue(p.is_file(), f"missing {p.name}")
        self.assertIn(mig.name, wrapper.read_text(encoding="utf-8"))
        self.assertIn(sql_test.name, wrapper.read_text(encoding="utf-8"))
        # the SQL test names exactly the two functions the migration narrows
        for sig in ("intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text)",
                    "intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text)"):
            self.assertIn(sig, mig.read_text(encoding="utf-8"))
            self.assertIn(sig, sql_test.read_text(encoding="utf-8"))

    def test_documents_contain_no_secret_values(self):
        for p in list(P7.glob("*.md")) + [PACK]:
            t = p.read_text(encoding="utf-8")
            self.assertNotRegex(t, r"AIza[0-9A-Za-z_\-]{20,}", p.name)
            self.assertNotRegex(t, r"eyJ[0-9A-Za-z_\-]{20,}\.[0-9A-Za-z_\-]{20,}", p.name)


if __name__ == "__main__":
    unittest.main()
