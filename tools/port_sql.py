#!/usr/bin/env python3
"""One-time (re-runnable) port of the SQL from the two source projects.

Sources are READ ONLY:
  ../hrms/supabase/migrations            HRMS business logic (Supabase)
  ../hrms/supabase/tests/database        HRMS SQL test suites
  ~/Documents/Projects/november/fingertipssl/supabase/{migrations,tests}

Output (committed, then owned by this repo):
  server/migrations/*.sql                 applied by sqlx at server start-up
  server/tests/sql/hrms/*.sql            SQL suites run by tools/db_test.sh
  (server/tests/sql/device/* were ported once and are now hand-maintained)

Transformations (all mechanical, listed in each output file's header):
  * auth.uid() / auth.jwt() / auth.role() / auth.users / auth.sessions
      -> iam.*   (our own identity schema; Supabase's `auth` schema is unused,
                  so nothing collides with the hosted project's GoTrue tables)
  * `insert into storage.buckets ...;`   -> removed (files live in Cloudflare R2)
  * fingertipssl `hrms_stub_*` migrations are skipped: HRMS provides the real
    tables and helpers with identical names (fingertipssl README "Folding").

Usage: python3 tools/port_sql.py [--check]
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HRMS = ROOT.parent / "hrms" / "supabase"
FT = pathlib.Path.home() / "Documents/Projects/november/fingertipssl/supabase"

OUT_MIG = ROOT / "server" / "migrations"
OUT_TEST = ROOT / "server" / "tests" / "sql"

IAM_RE = re.compile(r"\bauth\.(uid|jwt|role)\(\)")
IAM_TBL_RE = re.compile(r"\bauth\.(users|sessions)\b")
BUCKET_RE = re.compile(r"insert\s+into\s+storage\.buckets\b.*?;\s*\n", re.IGNORECASE | re.DOTALL)


# Fixture-only patches for behaviour web-hrms deliberately changed.
# (file name, exact text, replacement). Business logic is never patched.
TEST_PATCHES = [
    (
        "20_roles_requests_deductions.sql",
        "update hrms.employees set status = 'active', end_date = null, credentials_valid_after = now() - interval '1 day'\n"
        "where id = test.emp('HR02');\n",
        "update hrms.employees set status = 'active', end_date = null, credentials_valid_after = now() - interval '1 day'\n"
        "where id = test.emp('HR02');\n"
        "-- [web-hrms] deactivation now signs the person out everywhere (sessions are\n"
        "-- deleted); re-create HR02's fixture session for the rest of the suite.\n"
        "insert into iam.sessions (id, user_id) select session_id, auth_user_id from test.people\n"
        " where code = 'HR02' on conflict (id) do nothing;\n",
    ),
]


def patch_test(name: str, sql: str, notes: list[str]) -> str:
    for fname, old, new in TEST_PATCHES:
        if fname == name:
            if sql.count(old) != 1:
                raise SystemExit(f"patch for {name} no longer applies")
            sql = sql.replace(old, new)
            notes.append("fixture patch: session re-created after deactivation")
    return sql


def transform(sql: str) -> tuple[str, list[str]]:
    notes: list[str] = []
    sql, n1 = IAM_RE.subn(lambda m: f"iam.{m.group(1)}()", sql)
    sql, n2 = IAM_TBL_RE.subn(lambda m: f"iam.{m.group(1)}", sql)
    if n1 or n2:
        notes.append(f"auth.* -> iam.* ({n1 + n2} references)")
    sql, n3 = BUCKET_RE.subn("-- [web-hrms] storage bucket removed: files live in Cloudflare R2.\n", sql)
    if n3:
        notes.append(f"storage.buckets insert removed ({n3})")
    return sql, notes


def header(src: pathlib.Path, notes: list[str]) -> str:
    rel = src.as_posix().replace(str(pathlib.Path.home()), "~")
    lines = [f"-- [web-hrms] Ported from {rel}"]
    lines += [f"-- [web-hrms]   {n}" for n in notes] or ["-- [web-hrms]   unchanged"]
    return "\n".join(lines) + "\n\n"


def port(src: pathlib.Path, dst: pathlib.Path, check: bool) -> bool:
    body, notes = transform(src.read_text())
    if dst.parent.name == "hrms" and dst.parent.parent.name == "sql":
        body = patch_test(src.name, body, notes)
    out = header(src, notes) + body
    if check:
        return dst.exists() and dst.read_text() == out
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(out)
    return True


def main() -> int:
    check = "--check" in sys.argv
    jobs: list[tuple[pathlib.Path, pathlib.Path]] = []

    for f in sorted((HRMS / "migrations").glob("*.sql")):
        jobs.append((f, OUT_MIG / f.name))
    for f in sorted((FT / "migrations").glob("*.sql")):
        if "hrms_stub" in f.name:
            continue
        jobs.append((f, OUT_MIG / f.name))

    for f in sorted((HRMS / "tests" / "database").glob("*.sql")):
        jobs.append((f, OUT_TEST / "hrms" / f.name))
    # Device tests were ported once, then adapted to the HRMS schema by hand
    # (fixtures, stub-only employee functions). They are owned here now.

    stale = [str(d.relative_to(ROOT)) for s, d in jobs if not port(s, d, check)]
    if check and stale:
        print("out of date:", *stale, sep="\n  ")
        return 1
    print(f"{'checked' if check else 'ported'} {len(jobs)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
