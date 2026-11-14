//! Generic RPC gateway over the HRMS SQL API (PostgREST-style, but narrower).
//!
//! At start-up the server reads the catalog of `public` functions. A browser
//! may call a function only when it is:
//!   * in schema `public`, a plain function (not a procedure/aggregate),
//!   * EXECUTE-able by role `authenticated` (Postgres grants are the allowlist),
//!   * not named `internal_*` (server-only by convention and by grants).
//!
//! Arguments are a JSON object of the function's own parameter names. The SQL
//! is built only from catalog identifiers and types (quoted), never from user
//! text; values travel as one bound jsonb parameter decoded by
//! `jsonb_to_record`. The function itself authorises the caller (HRMS rule).

use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

use serde_json::{Map, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    db::{self, Caller},
    error::{ApiError, ApiResult},
};

#[derive(Debug, Clone)]
pub struct Arg {
    pub name: String,
    pub ty: String,
    pub has_default: bool,
}

#[derive(Debug, Clone)]
pub struct Signature {
    pub name: String,
    pub args: Vec<Arg>,
    pub returns_set: bool,
    pub returns_void: bool,
}

#[derive(Debug, Default, Clone)]
pub struct Catalog {
    /// Callable by signed-in users.
    public: HashMap<String, Vec<Signature>>,
    /// `internal_*`, callable only by the server.
    internal: HashMap<String, Vec<Signature>>,
}

pub type SharedCatalog = Arc<Catalog>;

const CATALOG_SQL: &str = r#"
select p.proname::text as name,
       coalesce(p.proargnames, '{}')::text[] as arg_names,
       coalesce((select array_agg(format_type(t, null) order by i)
                   from unnest(p.proargtypes::oid[]) with ordinality u(t, i)), '{}')::text[] as arg_types,
       p.pronargdefaults::int as n_defaults,
       p.proretset as returns_set,
       (p.prorettype = 'pg_catalog.void'::regtype) as returns_void,
       has_function_privilege('authenticated', p.oid, 'execute') as user_callable,
       has_function_privilege('service_role', p.oid, 'execute') as service_callable
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proargmodes is null            -- IN arguments only
  and p.pronargs = coalesce(array_length(p.proargnames, 1), 0)  -- every argument is named
"#;

impl Catalog {
    pub async fn load(pool: &PgPool) -> Result<Self, sqlx::Error> {
        let rows = sqlx::query(CATALOG_SQL).fetch_all(pool).await?;
        let mut cat = Catalog::default();
        for row in rows {
            let name: String = row.get("name");
            let names: Vec<String> = row.get("arg_names");
            let types: Vec<String> = row.get("arg_types");
            let n_defaults = row.get::<i32, _>("n_defaults") as usize;
            let first_default = names.len().saturating_sub(n_defaults);
            let sig = Signature {
                name: name.clone(),
                args: names
                    .into_iter()
                    .zip(types)
                    .enumerate()
                    .map(|(i, (name, ty))| Arg {
                        name,
                        ty,
                        has_default: i >= first_default,
                    })
                    .collect(),
                returns_set: row.get("returns_set"),
                returns_void: row.get("returns_void"),
            };
            let internal = name.starts_with("internal_");
            if internal && row.get::<bool, _>("service_callable") {
                cat.internal.entry(name).or_default().push(sig);
            } else if !internal && row.get::<bool, _>("user_callable") {
                cat.public.entry(name).or_default().push(sig);
            }
        }
        Ok(cat)
    }

    pub fn public_len(&self) -> usize {
        self.public.len()
    }
    pub fn has_public(&self, name: &str) -> bool {
        self.public.contains_key(name)
    }
}

/// Picks the overload whose parameters accept exactly the given keys.
fn resolve<'a>(sigs: &'a [Signature], keys: &BTreeSet<&str>) -> ApiResult<&'a Signature> {
    let mut best: Option<&Signature> = None;
    let mut unknown: Option<&str> = None;
    let mut missing: Option<&str> = None;
    for sig in sigs {
        if let Some(k) = keys
            .iter()
            .find(|k| !sig.args.iter().any(|a| a.name == **k))
        {
            unknown.get_or_insert(k);
            continue;
        }
        if let Some(a) = sig
            .args
            .iter()
            .find(|a| !a.has_default && !keys.contains(a.name.as_str()))
        {
            missing.get_or_insert(a.name.as_str());
            continue;
        }
        // Prefer the overload with the fewest parameters (most specific).
        if best.is_none_or(|b| sig.args.len() < b.args.len()) {
            best = Some(sig);
        }
    }
    best.ok_or_else(|| match (missing, unknown) {
        (Some(m), _) => ApiError::validation_field(m, "required", format!("Missing value: {m}.")),
        (None, Some(u)) => ApiError::validation_field(u, "unknown", format!("Unknown field: {u}.")),
        _ => ApiError::validation("Invalid arguments."),
    })
}

fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Builds the SQL for one call. Only catalog identifiers/types are spliced in.
pub fn build_sql(sig: &Signature, keys: &BTreeSet<&str>) -> String {
    let used: Vec<&Arg> = sig
        .args
        .iter()
        .filter(|a| keys.contains(a.name.as_str()))
        .collect();
    let call_args = used
        .iter()
        .map(|a| format!("{n} => x.{n}", n = quote_ident(&a.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let fname = format!("public.{}", quote_ident(&sig.name));
    let from = if used.is_empty() {
        String::new()
    } else {
        let cols = used
            .iter()
            .map(|a| format!("{} {}", quote_ident(&a.name), a.ty))
            .collect::<Vec<_>>()
            .join(", ");
        format!(" from jsonb_to_record($1::jsonb) as x({cols})")
    };
    if sig.returns_set {
        if used.is_empty() {
            format!(
                "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from {fname}() r where $1::jsonb is not null"
            )
        } else {
            let cols = from.trim_start_matches(" from ");
            format!(
                "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from {cols} cross join lateral {fname}({call_args}) r"
            )
        }
    } else if sig.returns_void {
        if used.is_empty() {
            format!("select null::jsonb from (select {fname}()) v where $1::jsonb is not null")
        } else {
            format!("select null::jsonb from (select {fname}({call_args}){from}) v")
        }
    } else if used.is_empty() {
        format!("select to_jsonb({fname}()) where $1::jsonb is not null")
    } else {
        format!("select to_jsonb({fname}({call_args})){from}")
    }
}

fn args_object(args: &Value) -> ApiResult<&Map<String, Value>> {
    match args {
        Value::Object(m) => Ok(m),
        Value::Null => {
            static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
            Ok(EMPTY.get_or_init(Map::new))
        }
        _ => Err(ApiError::validation(
            "The request body must be a JSON object.",
        )),
    }
}

/// Browser-facing call (role `authenticated`).
pub async fn call_public(
    pool: &PgPool,
    catalog: &Catalog,
    claims: &db::Claims,
    name: &str,
    args: Value,
    request_id: Uuid,
) -> ApiResult<Value> {
    let sigs = catalog.public.get(name).ok_or_else(ApiError::not_found)?;
    let obj = args_object(&args)?;
    let keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
    let sig = resolve(sigs, &keys)?;
    let sql = build_sql(sig, &keys);
    let arg = Value::Object(obj.clone());
    db::query_json(pool, Caller::User(claims), request_id, &sql, arg)
        .await
        .map_err(|e| e.with_request_id(Some(request_id.to_string())))
}

/// Server-only call of an `internal_*` function (role `service_role`).
/// The catalog is re-read lazily so this works without a shared catalog.
pub async fn call_internal(
    pool: &PgPool,
    name: &str,
    args: Value,
    request_id: Uuid,
) -> ApiResult<Value> {
    static CATALOG: tokio::sync::OnceCell<Catalog> = tokio::sync::OnceCell::const_new();
    let cat = CATALOG
        .get_or_try_init(|| Catalog::load(pool))
        .await
        .map_err(ApiError::from)?;
    let sigs = cat.internal.get(name).ok_or_else(|| {
        tracing::error!(
            name,
            "internal function missing or not granted to service_role"
        );
        ApiError::internal()
    })?;
    let obj = args_object(&args)?;
    let keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
    let sig = resolve(sigs, &keys)?;
    let sql = build_sql(sig, &keys);
    db::query_json(
        pool,
        Caller::Service,
        request_id,
        &sql,
        Value::Object(obj.clone()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(name: &str, args: &[(&str, &str, bool)], set: bool, void: bool) -> Signature {
        Signature {
            name: name.into(),
            args: args
                .iter()
                .map(|(n, t, d)| Arg {
                    name: (*n).into(),
                    ty: (*t).into(),
                    has_default: *d,
                })
                .collect(),
            returns_set: set,
            returns_void: void,
        }
    }

    #[test]
    fn builds_named_call_with_only_given_args() {
        let s = sig(
            "list_x",
            &[("p_a", "uuid", false), ("p_limit", "integer", true)],
            false,
            false,
        );
        let keys = BTreeSet::from(["p_a"]);
        let sql = build_sql(&s, &keys);
        assert_eq!(
            sql,
            r#"select to_jsonb(public."list_x"("p_a" => x."p_a")) from jsonb_to_record($1::jsonb) as x("p_a" uuid)"#
        );
    }

    #[test]
    fn no_arg_call_still_binds_param() {
        let s = sig("get_session_context", &[], false, false);
        let sql = build_sql(&s, &BTreeSet::new());
        assert!(sql.contains("$1::jsonb"), "{sql}");
        assert!(sql.contains(r#"public."get_session_context"()"#));
    }

    #[test]
    fn set_returning_functions_are_aggregated() {
        let s = sig("rows", &[("p_x", "text", false)], true, false);
        let sql = build_sql(&s, &BTreeSet::from(["p_x"]));
        assert!(sql.starts_with(
            "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from jsonb_to_record"
        ));
        assert!(sql.contains("cross join lateral"));
    }

    #[test]
    fn void_functions_return_null() {
        let s = sig("touch", &[("p_x", "text", false)], false, true);
        let sql = build_sql(&s, &BTreeSet::from(["p_x"]));
        assert!(
            sql.contains("select null::jsonb from (select public.\"touch\"("),
            "{sql}"
        );
    }

    #[test]
    fn identifiers_are_quoted() {
        let s = sig("we\"ird", &[("p\"a", "text", false)], false, false);
        let sql = build_sql(&s, &BTreeSet::from(["p\"a"]));
        assert!(sql.contains(r#"public."we""ird""#));
        assert!(sql.contains(r#""p""a" => x."p""a""#));
    }

    #[test]
    fn resolve_rejects_unknown_and_missing() {
        let sigs = vec![sig(
            "f",
            &[("p_a", "uuid", false), ("p_b", "text", true)],
            false,
            false,
        )];
        let e = resolve(&sigs, &BTreeSet::from(["p_a", "p_zzz"])).unwrap_err();
        assert_eq!(e.code, "VALIDATION_FAILED");
        assert_eq!(e.field_errors["p_zzz"], "unknown");
        let e = resolve(&sigs, &BTreeSet::from(["p_b"])).unwrap_err();
        assert_eq!(e.field_errors["p_a"], "required");
        assert!(resolve(&sigs, &BTreeSet::from(["p_a"])).is_ok());
        assert!(resolve(&sigs, &BTreeSet::from(["p_a", "p_b"])).is_ok());
    }

    #[test]
    fn resolve_picks_matching_overload() {
        let sigs = vec![
            sig(
                "f",
                &[("p_a", "uuid", false), ("p_b", "text", false)],
                false,
                false,
            ),
            sig("f", &[("p_a", "uuid", false)], false, false),
        ];
        assert_eq!(
            resolve(&sigs, &BTreeSet::from(["p_a"])).unwrap().args.len(),
            1
        );
        assert_eq!(
            resolve(&sigs, &BTreeSet::from(["p_a", "p_b"]))
                .unwrap()
                .args
                .len(),
            2
        );
    }

    #[test]
    fn body_must_be_object_or_null() {
        assert!(args_object(&Value::Null).unwrap().is_empty());
        assert!(args_object(&serde_json::json!([1])).is_err());
        assert!(args_object(&serde_json::json!("x")).is_err());
    }
}
