//! Steer #18-#20 Studio v5 HTTP routes for Deep Research, Dual-Tier Persistent RAG,
//! Deep Think, 12-Artifact Proactive Lifecycle OS, 2-Tier Auto-Learn, Gap Radar,
//! and Bilingual Skills / Cold Vault / 4-Stage Execution DAG.
//!
//! Zero-4xx Mount Invariant: every `GET` list/status endpoint returns HTTP `200 OK`
//! with empty arrays (`[]`) when no records exist yet.

use std::collections::BTreeMap;
use std::sync::Arc;

use omnia_core::{now_epoch_ms, SecretRedactor};
use omnia_harness::artifact_os::{
    verify_artifact_content, ArtifactKind, LessonRecord, LifecycleArtifact, LinkRelation,
    SixStateReceipt,
};
use omnia_harness::deep_think::{
    BranchKind, DeepThinkEngine, DeepThinkSession, EpistemicBand, RedTeamChallenge, ThinkBranch,
};
use omnia_harness::research_vault::{
    EvidenceGrade, ResearchSourceRecord, SourceStage, VaultTier,
};
use omnia_harness::skill_registry::CodifySkillRequest;
use serde_json::{json, Value};

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;

/// Returns `true` if `path` belongs to the Steer #18-#20 Research / Think / Lifecycle / Learn / Skills v5 surface
/// or Steer #27B Super / Computer Use v5 routes.
#[must_use]
pub fn is_known_route(path: &str) -> bool {
    crate::routes_super_v5::is_known_route(path)
        || crate::routes_computer_v5::is_known_route(path)
        || matches!(
        path,
        "/api/v5/research/status"
            | "/api/v5/research/sources"
            | "/api/v5/research/search"
            | "/api/v5/research/fetch"
            | "/api/v5/research/ingest"
            | "/api/v5/research/query"
            | "/api/v5/research/claim"
            | "/api/v5/research/verify-citations"
            | "/api/v5/research/table"
            | "/api/v5/research/export"
            | "/api/v5/rag/query"
            | "/api/v5/rag/sources"
            | "/api/v5/rag/pin"
            | "/api/v5/think/sessions"
            | "/api/v5/think/start"
            | "/api/v5/think/branch"
            | "/api/v5/think/falsify"
            | "/api/v5/think/redteam"
            | "/api/v5/think/conclude"
            | "/api/v5/lifecycle/artifacts"
            | "/api/v5/lifecycle/upsert"
            | "/api/v5/lifecycle/link"
            | "/api/v5/lifecycle/todo"
            | "/api/v5/lifecycle/dod"
            | "/api/v5/lifecycle/handoff"
            | "/api/v5/lifecycle/super-state"
            | "/api/v5/lifecycle/verify"
            | "/api/v5/learn/lessons"
            | "/api/v5/learn/capture"
            | "/api/v5/learn/promote-skill"
            | "/api/v5/learn/gap-radar"
            | "/api/v5/learn/sync-global"
            | "/api/v5/skills/route"
            | "/api/v5/skills/vault"
            | "/api/v5/skills/dag"
            | "/api/v5/skills/pipelines"
            | "/api/v5/skills/doctor"
            | "/api/v5/skills/codify"
    )
}

/// Dispatches all `/api/v5/{research,rag,think,lifecycle,learn,skills,super,computer}/*` endpoints.
pub async fn dispatch(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    if let Some(resp) = crate::routes_super_v5::dispatch(state, req).await {
        return Some(resp);
    }
    if let Some(resp) = crate::routes_computer_v5::dispatch(state, req).await {
        return Some(resp);
    }
    if !is_known_route(req.path.as_str()) {
        return None;
    }

    match (req.method.as_str(), req.path.as_str()) {
        // ---- Deep Research & Persistent Dual-Tier RAG ----
        ("GET", "/api/v5/research/status") => Some(handle_research_status(state)),
        ("GET", "/api/v5/research/sources") | ("GET", "/api/v5/rag/sources") => {
            Some(handle_research_sources(state, req))
        }
        ("POST", "/api/v5/research/search") | ("GET", "/api/v5/research/search") => {
            Some(handle_research_search(state, req).await)
        }
        ("POST", "/api/v5/research/fetch") => Some(handle_research_fetch(state, req).await),
        ("POST", "/api/v5/research/ingest") => Some(handle_research_ingest(state, req)),
        ("GET", "/api/v5/research/query")
        | ("POST", "/api/v5/research/query")
        | ("GET", "/api/v5/rag/query")
        | ("POST", "/api/v5/rag/query") => Some(handle_research_query(state, req)),
        ("POST", "/api/v5/rag/pin") => Some(handle_rag_pin(state, req)),
        ("POST", "/api/v5/research/claim") => Some(handle_research_claim(state, req)),
        ("POST", "/api/v5/research/verify-citations") => {
            Some(handle_research_verify_citations(state, req))
        }
        ("POST", "/api/v5/research/table") => Some(handle_research_table(state, req)),
        ("GET", "/api/v5/research/export") => Some(handle_research_export(state, req)),

        // ---- Deep Think Deliberation Engine ----
        ("GET", "/api/v5/think/sessions") => Some(handle_think_sessions(state, req)),
        ("POST", "/api/v5/think/start") => Some(handle_think_start(state, req)),
        ("POST", "/api/v5/think/branch") => Some(handle_think_branch(state, req)),
        ("POST", "/api/v5/think/falsify") => Some(handle_think_falsify(state, req)),
        ("POST", "/api/v5/think/redteam") => Some(handle_think_redteam(state, req)),
        ("POST", "/api/v5/think/conclude") => Some(handle_think_conclude(state, req)),

        // ---- 12-Artifact Proactive Lifecycle OS ----
        ("GET", "/api/v5/lifecycle/artifacts") => Some(handle_lifecycle_artifacts(state, req)),
        ("POST", "/api/v5/lifecycle/upsert") => Some(handle_lifecycle_upsert(state, req)),
        ("POST", "/api/v5/lifecycle/link") => Some(handle_lifecycle_link(state, req)),
        ("POST", "/api/v5/lifecycle/todo") => Some(handle_lifecycle_todo(state, req)),
        ("POST", "/api/v5/lifecycle/dod") => Some(handle_lifecycle_dod(state, req)),
        ("POST", "/api/v5/lifecycle/handoff") => Some(handle_lifecycle_handoff(state, req)),
        ("GET", "/api/v5/lifecycle/super-state") => Some(handle_lifecycle_super_state_get(state)),
        ("POST", "/api/v5/lifecycle/super-state") => {
            Some(handle_lifecycle_super_state_post(state, req))
        }
        ("POST", "/api/v5/lifecycle/verify") => Some(handle_lifecycle_verify(state, req)),

        // ---- 2-Tier Auto-Learn & Gap Radar ----
        ("GET", "/api/v5/learn/lessons") => Some(handle_learn_lessons(state, req)),
        ("POST", "/api/v5/learn/capture") => Some(handle_learn_capture(state, req)),
        ("POST", "/api/v5/learn/promote-skill") => Some(handle_learn_promote_skill(state, req)),
        ("GET", "/api/v5/learn/gap-radar") => Some(handle_learn_gap_radar_get(state)),
        ("POST", "/api/v5/learn/gap-radar") => Some(handle_learn_gap_radar_post(state, req)),
        ("POST", "/api/v5/learn/sync-global") => Some(handle_learn_sync_global(state, req)),

        // ---- Bilingual Skills, Cold Vault, 4-Stage DAG & Doctor ----
        ("GET", "/api/v5/skills/route") | ("POST", "/api/v5/skills/route") => {
            Some(handle_skills_route(state, req))
        }
        ("GET", "/api/v5/skills/vault") => Some(handle_skills_vault(state, req)),
        ("GET", "/api/v5/skills/dag") | ("POST", "/api/v5/skills/dag") => {
            Some(handle_skills_dag(state, req))
        }
        ("GET", "/api/v5/skills/pipelines") => Some(handle_skills_pipelines(state)),
        ("GET", "/api/v5/skills/doctor") => Some(handle_skills_doctor(state)),
        ("POST", "/api/v5/skills/codify") => Some(handle_skills_codify(state, req)),

        _ => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for v5 research/lifecycle route.",
        )),
    }
}

fn parse_obj(req: &HttpRequest) -> Result<serde_json::Map<String, Value>, HttpResponse> {
    if req.body.is_empty() {
        return Ok(serde_json::Map::new());
    }
    req.json_object()
}

fn str_field<'a>(obj: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = obj
            .get(*k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(s);
        }
    }
    None
}

fn str_vec_field(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Vec<String> {
    for k in keys {
        if let Some(arr) = obj.get(*k).and_then(Value::as_array) {
            return arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect();
        }
        if let Some(single) = obj
            .get(*k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return vec![single.to_string()];
        }
    }
    Vec::new()
}

fn parse_tier_filter(raw: Option<&str>) -> Option<VaultTier> {
    match raw
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "local" | "project" | "s" => Some(VaultTier::Local),
        "global" | "g" => Some(VaultTier::Global),
        _ => None,
    }
}

fn format_source_for_ui(src: &ResearchSourceRecord) -> Value {
    let mut val = serde_json::to_value(src).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut map) = val {
        map.insert("id".to_string(), json!(src.citation_id));
        map.insert("status".to_string(), json!(src.stage.as_str()));
        map.insert("excerpt".to_string(), json!(src.markdown_excerpt));
        map.insert("sha256".to_string(), json!(src.sha256_hex));
        map.insert("observedAtMs".to_string(), json!(src.fetched_at_ms));
        map.insert(
            "blockedReason".to_string(),
            src.error_note
                .as_ref()
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        let grade = match src.stage {
            SourceStage::Extracted => "verified",
            SourceStage::Viewed => "single_source",
            SourceStage::Searched => "unverified_gap",
            SourceStage::Blocked | SourceStage::AuthRequired | SourceStage::Failed => {
                "unverified_gap"
            }
        };
        map.insert("evidenceGrade".to_string(), json!(grade));
    }
    val
}

fn format_think_session_for_ui(sess: &DeepThinkSession) -> Value {
    let mut val = serde_json::to_value(sess).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut map) = val {
        map.insert("id".to_string(), json!(sess.think_id));
        map.insert("question".to_string(), json!(sess.problem));
    }
    val
}

fn format_artifact_for_ui(art: &LifecycleArtifact) -> Value {
    let mut val = serde_json::to_value(art).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut map) = val {
        map.insert("content".to_string(), json!(art.body_md));
        map.insert("body".to_string(), json!(art.body_md));
    }
    val
}

fn format_lesson_for_ui(lesson: &LessonRecord) -> Value {
    let mut val = serde_json::to_value(lesson).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut map) = val {
        map.insert("tier".to_string(), json!(lesson.scope));
        map.insert("lesson".to_string(), json!(lesson.invariant));
        map.insert("content".to_string(), json!(lesson.invariant));
    }
    val
}

fn slugify(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        format!("item-{}", now_epoch_ms())
    } else {
        trimmed
    }
}

// =========================================================================
// 1. Deep Research & Persistent Dual-Tier RAG
// =========================================================================

fn handle_research_status(state: &Arc<StudioState>) -> HttpResponse {
    let ledger = state.research_vault.sources_ledger(None).ok();
    let claims_count = state.research_vault.count_claims(None).unwrap_or(0);
    let (local_count, global_count, searched, viewed, extracted, blocked, auth_req, failed, total) =
        if let Some(l) = ledger {
            let local_n = l
                .sources
                .iter()
                .filter(|s| s.tier == VaultTier::Local)
                .count();
            let global_n = l
                .sources
                .iter()
                .filter(|s| s.tier == VaultTier::Global)
                .count();
            (
                local_n,
                global_n,
                l.total_searched,
                l.total_viewed,
                l.total_extracted,
                l.total_blocked,
                l.total_auth_required,
                l.total_failed,
                l.sources.len(),
            )
        } else {
            (0, 0, 0, 0, 0, 0, 0, 0, 0)
        };

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "defaultMode": "auto",
        "localCount": local_count,
        "globalCount": global_count,
        "totalSources": total,
        "searched": searched,
        "viewed": viewed,
        "extracted": extracted,
        "blocked": blocked,
        "authRequired": auth_req,
        "failed": failed,
        "claimsCount": claims_count,
    }))
}

fn handle_research_sources(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let tier_param = req
        .query_param("tier")
        .or_else(|| req.query_param("scope"));
    let tier_filter = parse_tier_filter(tier_param.as_deref());

    match state.research_vault.sources_ledger(tier_filter) {
        Ok(ledger) => {
            let sources: Vec<Value> = ledger.sources.iter().map(format_source_for_ui).collect();
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "count": sources.len(),
                "summary": {
                    "searched": ledger.total_searched,
                    "viewed": ledger.total_viewed,
                    "extracted": ledger.total_extracted,
                    "blocked": ledger.total_blocked,
                    "authRequired": ledger.total_auth_required,
                    "failed": ledger.total_failed,
                    "citedIds": ledger.cited_ids,
                    "total": sources.len(),
                },
                "sources": sources,
            }))
        }
        Err(_) => HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "count": 0,
            "summary": {
                "searched": 0,
                "viewed": 0,
                "extracted": 0,
                "blocked": 0,
                "authRequired": 0,
                "failed": 0,
                "citedIds": [],
                "total": 0,
            },
            "sources": [],
        })),
    }
}

async fn handle_research_search(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let (query, scope, tier, max_results) = if req.method == "GET" {
        let q = req
            .query_param("q")
            .or_else(|| req.query_param("query"))
            .unwrap_or_default();
        let sc = req
            .query_param("scope")
            .unwrap_or_else(|| "all".to_string());
        let tr = req.query_param("tier");
        let mr = req
            .query_param("maxResults")
            .or_else(|| req.query_param("limit"))
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(8);
        (q, sc, tr, mr)
    } else {
        let obj = match parse_obj(req) {
            Ok(m) => m,
            Err(resp) => return resp,
        };
        let q = str_field(&obj, &["query", "q"])
            .unwrap_or("")
            .to_string();
        let sc = str_field(&obj, &["scope", "mode"])
            .unwrap_or("all")
            .to_string();
        let tr = str_field(&obj, &["tier"]).map(ToString::to_string);
        let mr = obj
            .get("maxResults")
            .or_else(|| obj.get("max_results"))
            .or_else(|| obj.get("topK"))
            .or_else(|| obj.get("limit"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(8);
        (q, sc, tr, mr)
    };

    let clean_q = query.trim();
    if clean_q.is_empty() {
        return HttpResponse::error(400, "missing_query", "Field 'query' is required.");
    }
    let top_k = max_results.clamp(1, 32);
    let tier_filter = parse_tier_filter(tier.as_deref());

    let vault_hits = state
        .research_vault
        .query_rag(clean_q, tier_filter, top_k)
        .unwrap_or_default();
    let rag_plan = state.rag.plan_and_retrieve(clean_q, top_k.min(12));
    let ledger = state.research_vault.sources_ledger(tier_filter).ok();
    let sources: Vec<Value> = ledger
        .as_ref()
        .map(|l| l.sources.iter().map(format_source_for_ui).collect())
        .unwrap_or_default();

    let sub_queries: Vec<Value> = rag_plan.sub_queries.iter().map(|s| s.to_json()).collect();
    let workspace_hits: Vec<Value> = rag_plan.cited_sources.iter().map(|c| c.to_json()).collect();

    state.event_feed.publish(
        "research",
        "search_completed",
        None,
        json!({
            "query": SecretRedactor::redact(clean_q),
            "scope": scope,
            "vaultHitCount": vault_hits.len(),
            "workspaceHitCount": workspace_hits.len(),
        }),
    );

    HttpResponse::ok(SecretRedactor::redact_json(&json!({
        "ok": true,
        "state": "online",
        "query": clean_q,
        "scope": scope,
        "subQueries": sub_queries,
        "hits": vault_hits,
        "ragHits": vault_hits,
        "workspaceHits": workspace_hits,
        "sources": sources,
        "ledger": ledger.map(|l| json!({
            "searched": l.total_searched,
            "viewed": l.total_viewed,
            "extracted": l.total_extracted,
            "blocked": l.total_blocked,
            "authRequired": l.total_auth_required,
            "failed": l.total_failed,
        })),
    })))
}

async fn handle_research_fetch(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let urls = str_vec_field(&obj, &["urls", "url"]);
    if urls.is_empty() {
        return HttpResponse::error(400, "missing_urls", "Field 'urls' or 'url' is required.");
    }
    let tier = VaultTier::from_str_lossy(str_field(&obj, &["tier"]).unwrap_or("local"));
    let query_origin = str_field(&obj, &["queryOrigin", "query_origin", "query"])
        .unwrap_or("studio-fetch");
    let max_conc = obj
        .get("maxConcurrency")
        .or_else(|| obj.get("max_concurrency"))
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 6))
        .unwrap_or(3);

    // Strictly fail-closed SSRF egress (`allow_loopback = false`) on HTTP API.
    let fetched = state
        .research_vault
        .fetch_urls_parallel(tier, &urls, query_origin, max_conc, false)
        .await;
    let formatted: Vec<Value> = fetched.iter().map(format_source_for_ui).collect();

    state.event_feed.publish(
        "research",
        "sources_fetched",
        None,
        json!({
            "count": formatted.len(),
            "tier": tier.as_str(),
        }),
    );

    let ledger = state.research_vault.sources_ledger(None).ok();
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": formatted.len(),
        "sources": formatted,
        "ledger": ledger.map(|l| json!({
            "searched": l.total_searched,
            "viewed": l.total_viewed,
            "extracted": l.total_extracted,
            "blocked": l.total_blocked,
            "authRequired": l.total_auth_required,
            "failed": l.total_failed,
        })),
    }))
}

fn handle_research_ingest(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let content = str_field(&obj, &["content", "text", "body", "markdown"]).unwrap_or("");
    if content.is_empty() {
        return HttpResponse::error(400, "missing_content", "Field 'content' is required.");
    }
    let url = str_field(&obj, &["url", "sourceUrl", "canonicalUrl"])
        .unwrap_or("https://omnia.local/ingested");
    let canonical = str_field(&obj, &["canonicalUrl", "canonical_url"]);
    let title = str_field(&obj, &["title", "name"]);
    let content_type = str_field(&obj, &["contentType", "content_type"])
        .unwrap_or("text/markdown");
    let tier = VaultTier::from_str_lossy(str_field(&obj, &["tier", "scope"]).unwrap_or("local"));
    let query_origin = str_field(&obj, &["queryOrigin", "query_origin", "query"])
        .unwrap_or("studio-ingest");

    match state.research_vault.ingest_document(
        tier,
        url,
        canonical,
        title,
        content,
        content_type,
        Some(200),
        query_origin,
    ) {
        Ok(rec) => {
            let formatted = format_source_for_ui(&rec);
            state.event_feed.publish(
                "research",
                "source_ingested",
                Some(&rec.citation_id),
                json!({
                    "citationId": rec.citation_id,
                    "tier": rec.tier.as_str(),
                    "title": rec.title,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "citationId": rec.citation_id,
                "source": formatted,
            }))
        }
        Err(err) => HttpResponse::error(400, "research_ingest_failed", &err),
    }
}

fn handle_research_query(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let (query, tier_raw, top_k) = if req.method == "GET" {
        let q = req
            .query_param("q")
            .or_else(|| req.query_param("query"))
            .unwrap_or_default();
        let t = req
            .query_param("tier")
            .or_else(|| req.query_param("scope"));
        let k = req
            .query_param("topK")
            .or_else(|| req.query_param("top_k"))
            .or_else(|| req.query_param("limit"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(10);
        (q, t, k)
    } else {
        let obj = match parse_obj(req) {
            Ok(m) => m,
            Err(resp) => return resp,
        };
        let q = str_field(&obj, &["query", "q"]).unwrap_or("").to_string();
        let t = str_field(&obj, &["tier", "scope"]).map(ToString::to_string);
        let k = obj
            .get("topK")
            .or_else(|| obj.get("top_k"))
            .or_else(|| obj.get("limit"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(10);
        (q, t, k)
    };

    let clean_q = query.trim();
    if clean_q.is_empty() {
        return HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "query": "",
            "hits": [],
            "count": 0,
        }));
    }
    let tier_filter = parse_tier_filter(tier_raw.as_deref());
    match state
        .research_vault
        .query_rag(clean_q, tier_filter, top_k.clamp(1, 64))
    {
        Ok(hits) => {
            let total_sources = state
                .research_vault
                .sources_ledger(tier_filter)
                .map(|l| l.sources.len())
                .unwrap_or(0);
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "query": clean_q,
                "count": hits.len(),
                "totalSources": total_sources,
                "hits": hits,
            }))
        }
        Err(err) => HttpResponse::error(500, "rag_query_failed", &err),
    }
}

fn handle_rag_pin(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(citation_id) = str_field(&obj, &["citationId", "citation_id", "sourceId", "id"])
    else {
        return HttpResponse::error(
            400,
            "missing_citation_id",
            "Field 'citationId' is required.",
        );
    };
    let target_raw = str_field(&obj, &["targetTier", "target_tier", "target", "tier"])
        .unwrap_or("global");
    let to_atelier = target_raw.eq_ignore_ascii_case("atelier");
    let target_tier = if to_atelier {
        VaultTier::Global
    } else {
        VaultTier::from_str_lossy(target_raw)
    };

    match state.research_vault.pin_source(citation_id, target_tier) {
        Ok(src) => {
            if to_atelier {
                let _ = state.artifact_os.upsert_artifact(
                    ArtifactKind::Memory,
                    &format!("atelier-pin-{}", slugify(&src.citation_id)),
                    &src.title,
                    "verified",
                    "project",
                    &format!(
                        "Pinned source `[{}]` ({})\n\n{}",
                        src.citation_id, src.canonical_url, src.markdown_excerpt
                    ),
                    json!({
                        "citationId": src.citation_id,
                        "pinnedToAtelier": true,
                        "canonicalUrl": src.canonical_url,
                    }),
                    None,
                    false,
                );
            }
            state.event_feed.publish(
                "research",
                "source_pinned",
                Some(&src.citation_id),
                json!({
                    "citationId": src.citation_id,
                    "tier": src.tier.as_str(),
                    "pinnedToAtelier": to_atelier,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "citationId": src.citation_id,
                "targetTier": src.tier.as_str(),
                "pinnedToAtelier": to_atelier,
                "source": format_source_for_ui(&src),
            }))
        }
        Err(err) => {
            let status = if err.contains("not found") { 404 } else { 400 };
            HttpResponse::error(status, "rag_pin_failed", &err)
        }
    }
}

fn handle_research_claim(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(text) = str_field(&obj, &["text", "claim"]) else {
        return HttpResponse::error(400, "missing_claim_text", "Field 'text' is required.");
    };
    let session_id = str_field(&obj, &["sessionId", "session_id"]).unwrap_or("default");
    let citations = str_vec_field(&obj, &["citations", "citationIds"]);
    let grade = EvidenceGrade::from_str_lossy(
        str_field(&obj, &["grade", "evidenceGrade", "requestedGrade"]).unwrap_or("verified"),
    );
    let notes = str_field(&obj, &["notes", "note"]).unwrap_or("");

    match state
        .research_vault
        .record_claim(session_id, text, citations, grade, notes)
    {
        Ok(claim) => {
            let citation_check = state.research_vault.verify_inline_citations(text);
            state.event_feed.publish(
                "research",
                "claim_recorded",
                Some(&claim.claim_id),
                json!({
                    "claimId": claim.claim_id,
                    "grade": claim.grade.as_str(),
                    "conflicts": claim.conflicts_with.len(),
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "claim": claim,
                "citationCheck": citation_check,
            }))
        }
        Err(err) => HttpResponse::error(400, "research_claim_failed", &err),
    }
}

fn handle_research_verify_citations(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(draft) = str_field(&obj, &["draft", "text", "content", "markdown"]) else {
        return HttpResponse::error(
            400,
            "missing_draft",
            "Field 'draft' (or 'text') is required.",
        );
    };
    let strict = obj
        .get("strict")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let report = state.research_vault.verify_citations_text(draft, strict);
    let ok = report.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        HttpResponse::ok(SecretRedactor::redact_json(&report))
    } else {
        let msg = report
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("citation verification failed");
        HttpResponse::error(400, "citation_verification_failed", msg)
    }
}

fn handle_research_table(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let result_set_id = str_field(&obj, &["resultSetId", "result_set_id"]);
    let query = str_field(&obj, &["query", "q"]).unwrap_or("");
    if result_set_id.is_none() && query.is_empty() {
        return HttpResponse::error(
            400,
            "missing_table_query",
            "Field 'query' or 'resultSetId' is required.",
        );
    }
    let columns = str_vec_field(&obj, &["columns", "fields"]);
    let top_k = obj
        .get("topK")
        .or_else(|| obj.get("top_k"))
        .or_else(|| obj.get("limit"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, 64))
        .unwrap_or(12);

    match state
        .research_vault
        .extract_structured_table(result_set_id, query, &columns, top_k)
    {
        Ok(table) => HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "resultSetId": table.result_set_id,
            "table": table,
        })),
        Err(err) => HttpResponse::error(400, "research_table_failed", &err),
    }
}

fn handle_research_export(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let format = req
        .query_param("format")
        .unwrap_or_else(|| "markdown".to_string());
    let session_id = req
        .query_param("session_id")
        .or_else(|| req.query_param("sessionId"))
        .filter(|s| !s.trim().is_empty());

    match state
        .research_vault
        .export_dossier(&format, session_id.as_deref())
    {
        Ok(payload) => {
            if format.eq_ignore_ascii_case("json") {
                HttpResponse::bytes(
                    200,
                    "application/json; charset=utf-8",
                    payload.into_bytes(),
                )
            } else {
                HttpResponse::bytes(
                    200,
                    "text/markdown; charset=utf-8",
                    payload.into_bytes(),
                )
            }
        }
        Err(err) => HttpResponse::error(500, "research_export_failed", &err),
    }
}

// =========================================================================
// 2. Deep Think Persisted Deliberation Engine
// =========================================================================

fn resolve_think_id(state: &StudioState, obj: &serde_json::Map<String, Value>) -> Option<String> {
    if let Some(tid) = str_field(obj, &["thinkId", "think_id", "id"]) {
        return Some(tid.to_string());
    }
    if let Some(sid) = str_field(obj, &["sessionId", "session_id"]) {
        if state.deep_think.get_session(sid).ok().flatten().is_some() {
            return Some(sid.to_string());
        }
        if let Ok(list) = state.deep_think.list_sessions(Some(sid), 1) {
            if let Some(latest) = list.first() {
                return Some(latest.think_id.clone());
            }
        }
        return Some(sid.to_string());
    }
    None
}

fn resolve_branch_id_in_session(sess: &DeepThinkSession, selector: &str) -> String {
    let clean = selector.trim();
    if let Some(b) = sess.branches.iter().find(|b| b.branch_id == clean) {
        return b.branch_id.clone();
    }
    let low = clean.to_ascii_lowercase();
    if let Some(b) = sess.branches.iter().find(|b| {
        b.branch_id.to_ascii_lowercase() == low
            || b.title.to_ascii_lowercase() == low
            || format!("{:?}", b.kind).to_ascii_lowercase() == low
    }) {
        return b.branch_id.clone();
    }
    clean.to_string()
}

fn handle_think_sessions(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let sid = req
        .query_param("sessionId")
        .or_else(|| req.query_param("session_id"))
        .filter(|s| !s.trim().is_empty());
    let limit = req
        .query_param("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(50)
        .clamp(1, 200);

    let sessions: Vec<Value> = state
        .deep_think
        .list_sessions(sid.as_deref(), limit)
        .unwrap_or_default()
        .iter()
        .map(format_think_session_for_ui)
        .collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": sessions.len(),
        "sessions": sessions,
    }))
}

fn handle_think_start(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(problem) = str_field(&obj, &["problem", "question", "prompt", "title"]) else {
        return HttpResponse::error(
            400,
            "missing_problem",
            "Field 'problem' (or 'question') is required.",
        );
    };
    let session_id = str_field(&obj, &["sessionId", "session_id"]).unwrap_or("default");
    let invariants = str_vec_field(&obj, &["invariants"]);
    let assumptions = str_vec_field(&obj, &["assumptions"]);
    let effort = str_field(&obj, &["effort"]).unwrap_or("high");

    match state
        .deep_think
        .start_session(session_id, problem, invariants, assumptions, effort)
    {
        Ok(sess) => {
            let formatted = format_think_session_for_ui(&sess);
            state.event_feed.publish(
                "think",
                "session_started",
                Some(&sess.think_id),
                json!({ "thinkId": sess.think_id, "effort": sess.effort }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": sess.think_id,
                "thinkId": sess.think_id,
                "sessionId": sess.think_id,
                "session": formatted,
            }))
        }
        Err(err) => HttpResponse::error(400, "think_start_failed", &err),
    }
}

fn handle_think_branch(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(think_id) = resolve_think_id(state, &obj) else {
        return HttpResponse::error(
            400,
            "missing_think_id",
            "Field 'thinkId' (or 'sessionId') is required.",
        );
    };
    let kind_raw = str_field(&obj, &["kind", "category"]).unwrap_or("custom");
    let kind = BranchKind::from_str_lossy(kind_raw);
    let title = str_field(&obj, &["title", "label", "name"])
        .unwrap_or(kind_raw)
        .to_string();
    let hypothesis = str_field(&obj, &["hypothesis", "description", "summary"])
        .unwrap_or(&title)
        .to_string();
    let default_branch_id = match kind {
        BranchKind::Baseline => "baseline".to_string(),
        BranchKind::Sota => "sota".to_string(),
        BranchKind::Contrarian => "contrarian".to_string(),
        BranchKind::Custom => slugify(&title),
    };
    let branch_id = str_field(&obj, &["branchId", "branch_id", "branch"])
        .map(ToString::to_string)
        .unwrap_or(default_branch_id);

    let branch = ThinkBranch {
        branch_id,
        kind,
        title,
        hypothesis,
        complexity: str_field(&obj, &["complexity"])
            .unwrap_or("O(n)")
            .to_string(),
        failure_modes: str_vec_field(&obj, &["failureModes", "failure_modes"]),
        blast_radius: str_field(&obj, &["blastRadius", "blast_radius"])
            .unwrap_or("localized")
            .to_string(),
        citations: str_vec_field(&obj, &["citations"]),
        epistemic_band: EpistemicBand::from_str_lossy(
            str_field(&obj, &["epistemicBand", "epistemic_band"]).unwrap_or("hypothesis"),
        ),
        falsification_cmd: None,
        falsification_passed: None,
        falsification_receipt: None,
        score_bps: obj
            .get("scoreBps")
            .or_else(|| obj.get("score_bps"))
            .and_then(Value::as_u64)
            .map(|n| (n as u32).min(10_000))
            .unwrap_or(5_000),
        rejected_reason: None,
    };

    match state.deep_think.add_branch(&think_id, branch) {
        Ok(sess) => {
            state.event_feed.publish(
                "think",
                "branch_added",
                Some(&sess.think_id),
                json!({ "thinkId": sess.think_id, "branchCount": sess.branches.len() }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "thinkId": sess.think_id,
                "session": format_think_session_for_ui(&sess),
            }))
        }
        Err(err) => {
            let status = if err.contains("not found") { 404 } else { 400 };
            HttpResponse::error(status, "think_branch_failed", &err)
        }
    }
}

fn handle_think_falsify(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(think_id) = resolve_think_id(state, &obj) else {
        return HttpResponse::error(
            400,
            "missing_think_id",
            "Field 'thinkId' (or 'sessionId') is required.",
        );
    };
    let Some(branch_sel) = str_field(&obj, &["branchId", "branch_id", "branch", "branchLabel"])
    else {
        return HttpResponse::error(400, "missing_branch", "Field 'branchId' is required.");
    };

    let branch_id = match state.deep_think.get_session(&think_id) {
        Ok(Some(sess)) => resolve_branch_id_in_session(&sess, branch_sel),
        Ok(None) => {
            return HttpResponse::error(
                404,
                "think_session_not_found",
                &format!("Deep Think session '{think_id}' not found."),
            );
        }
        Err(err) => return HttpResponse::error(500, "think_store_error", &err),
    };

    let cmd = str_field(&obj, &["cmd", "command", "checkCommand", "check"])
        .unwrap_or("executable-falsification");
    let receipt = str_field(&obj, &["receipt", "evidence", "result", "detail"])
        .unwrap_or("falsification recorded");
    let passed = obj.get("passed").and_then(Value::as_bool).unwrap_or_else(|| {
        let low = receipt.to_ascii_lowercase();
        !(low.contains("falsified") || low.contains("fail") || low.contains("reject"))
    });

    match state
        .deep_think
        .record_falsification(&think_id, &branch_id, cmd, passed, receipt)
    {
        Ok(sess) => {
            state.event_feed.publish(
                "think",
                "branch_falsified",
                Some(&sess.think_id),
                json!({
                    "thinkId": sess.think_id,
                    "branchId": branch_id,
                    "passed": passed,
                    "strikeLevel": sess.escalation.strike_level,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "thinkId": sess.think_id,
                "escalation": sess.escalation,
                "session": format_think_session_for_ui(&sess),
            }))
        }
        Err(err) => {
            let status = if err.contains("not found") { 404 } else { 400 };
            HttpResponse::error(status, "think_falsify_failed", &err)
        }
    }
}

fn handle_think_redteam(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(think_id) = resolve_think_id(state, &obj) else {
        return HttpResponse::error(
            400,
            "missing_think_id",
            "Field 'thinkId' (or 'sessionId') is required.",
        );
    };
    let challenger = str_field(
        &obj,
        &["challengerModel", "challenger_model", "criticModel", "critic"],
    )
    .unwrap_or("claude-opus-4-6")
    .to_string();
    let primary = str_field(&obj, &["primaryModel", "primary_model"])
        .unwrap_or("gpt-5.4-codex")
        .to_string();
    let critiques = str_vec_field(&obj, &["critiques", "critique"]);
    if critiques.is_empty() {
        return HttpResponse::error(
            400,
            "missing_critique",
            "Field 'critiques' (or 'critique') is required.",
        );
    }
    let mitigations = str_vec_field(&obj, &["mitigations", "mitigation"]);
    let verdict = str_field(&obj, &["verdict"])
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if obj.get("resolved").and_then(Value::as_bool) == Some(true) {
                "resolved".to_string()
            } else {
                "addressed".to_string()
            }
        });

    let challenge = RedTeamChallenge {
        challenger_model: challenger,
        primary_model: primary,
        distinct_family: false,
        critiques,
        mitigations,
        verdict,
        created_at_ms: now_epoch_ms(),
    };

    match state.deep_think.record_redteam(&think_id, challenge) {
        Ok(sess) => {
            state.event_feed.publish(
                "think",
                "redteam_recorded",
                Some(&sess.think_id),
                json!({ "thinkId": sess.think_id, "redTeamCount": sess.red_team.len() }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "thinkId": sess.think_id,
                "session": format_think_session_for_ui(&sess),
            }))
        }
        Err(err) => {
            let status = if err.contains("not found") { 404 } else { 400 };
            HttpResponse::error(status, "think_redteam_failed", &err)
        }
    }
}

fn handle_think_conclude(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(think_id) = resolve_think_id(state, &obj) else {
        return HttpResponse::error(
            400,
            "missing_think_id",
            "Field 'thinkId' (or 'sessionId') is required.",
        );
    };
    let Some(winner_sel) = str_field(&obj, &["winnerBranchId", "winner_branch_id", "winner"])
    else {
        return HttpResponse::error(400, "missing_winner", "Field 'winnerBranchId' is required.");
    };

    let winner_id = match state.deep_think.get_session(&think_id) {
        Ok(Some(sess)) => resolve_branch_id_in_session(&sess, winner_sel),
        Ok(None) => {
            return HttpResponse::error(
                404,
                "think_session_not_found",
                &format!("Deep Think session '{think_id}' not found."),
            );
        }
        Err(err) => return HttpResponse::error(500, "think_store_error", &err),
    };

    let synthesis = str_field(&obj, &["synthesis", "summary", "rationale", "conclusion"])
        .unwrap_or("Selected highest-scoring verified branch.");
    let receipt = obj
        .get("receipt6State")
        .or_else(|| obj.get("receipt_6state"))
        .or_else(|| obj.get("receipt"))
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "verified": [format!("winner:{winner_id}")],
                "partial": [],
                "unresolved": [],
                "blocked": [],
                "next": [],
                "exactPracticalLimits": [],
            })
        });

    match state
        .deep_think
        .conclude_session(&think_id, &winner_id, synthesis, receipt)
    {
        Ok(sess) => {
            let rejected = DeepThinkEngine::rejected_alternatives_matrix(&sess);
            state.event_feed.publish(
                "think",
                "session_concluded",
                Some(&sess.think_id),
                json!({
                    "thinkId": sess.think_id,
                    "winnerBranchId": winner_id,
                    "rejectedCount": rejected.len(),
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "thinkId": sess.think_id,
                "winnerBranchId": winner_id,
                "rejectedAlternatives": rejected,
                "session": format_think_session_for_ui(&sess),
            }))
        }
        Err(err) => {
            let status = if err.contains("not found") || err.contains("does not exist") {
                404
            } else {
                400
            };
            HttpResponse::error(status, "think_conclude_failed", &err)
        }
    }
}

// =========================================================================
// 3. 12-Artifact Proactive Lifecycle OS
// =========================================================================

fn parse_optional_receipt(obj: &serde_json::Map<String, Value>) -> Option<SixStateReceipt> {
    if let Some(rcpt_val) = obj.get("receipt").or_else(|| obj.get("receipt6State")) {
        if let Ok(mut parsed) = serde_json::from_value::<SixStateReceipt>(rcpt_val.clone()) {
            parsed.seal();
            return Some(parsed);
        }
        if let Some(s) = rcpt_val.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            let mut r = SixStateReceipt {
                verified: vec![SecretRedactor::redact(s)],
                ..SixStateReceipt::default()
            };
            r.seal();
            return Some(r);
        }
    }
    if let Some(ev) = str_field(obj, &["evidence", "evidenceReceipt", "evidence_receipt"]) {
        let mut r = SixStateReceipt {
            verified: vec![SecretRedactor::redact(ev)],
            ..SixStateReceipt::default()
        };
        r.seal();
        return Some(r);
    }
    None
}

fn handle_lifecycle_artifacts(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let kind = req
        .query_param("kind")
        .as_deref()
        .and_then(ArtifactKind::from_str_lossy);
    let scope = req
        .query_param("scope")
        .filter(|s| !s.trim().is_empty() && !s.eq_ignore_ascii_case("all"));

    let artifacts = state
        .artifact_os
        .list_artifacts(kind, scope.as_deref())
        .unwrap_or_default();
    let links = state.artifact_os.list_all_links().unwrap_or_default();
    let super_state = state.artifact_os.super_state().unwrap_or_default();

    let mut counts_by_kind: BTreeMap<String, usize> = BTreeMap::new();
    for k in ArtifactKind::ALL {
        counts_by_kind.insert(k.as_str().to_string(), 0);
    }
    for art in &artifacts {
        *counts_by_kind
            .entry(art.kind.as_str().to_string())
            .or_insert(0) += 1;
    }

    let formatted: Vec<Value> = artifacts.iter().map(format_artifact_for_ui).collect();
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": formatted.len(),
        "artifacts": formatted,
        "links": links,
        "superState": super_state,
        "summary": counts_by_kind,
        "tokenBudget": Value::Null,
    }))
}

fn handle_lifecycle_upsert(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(kind_raw) = str_field(&obj, &["kind", "type"]) else {
        return HttpResponse::error(400, "missing_kind", "Field 'kind' is required.");
    };
    let Some(kind) = ArtifactKind::from_str_lossy(kind_raw) else {
        return HttpResponse::error(
            400,
            "invalid_artifact_kind",
            &format!("Unsupported lifecycle artifact kind '{kind_raw}'."),
        );
    };
    let title = str_field(&obj, &["title", "name", "slug", "id"]).unwrap_or(kind.as_str());
    let slug = str_field(&obj, &["slug", "id"])
        .map(ToString::to_string)
        .unwrap_or_else(|| slugify(title));
    let status = str_field(&obj, &["status", "state"]).unwrap_or("active");
    let scope = str_field(&obj, &["scope"]).unwrap_or("project");
    let body_md = obj
        .get("bodyMd")
        .or_else(|| obj.get("body_md"))
        .or_else(|| obj.get("body"))
        .or_else(|| obj.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let metadata = obj
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let receipt = parse_optional_receipt(&obj);
    let sync_to_disk = obj
        .get("syncToDisk")
        .or_else(|| obj.get("sync_to_disk"))
        .or_else(|| obj.get("projectToDisk"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match state.artifact_os.upsert_artifact(
        kind,
        &slug,
        title,
        status,
        scope,
        body_md,
        metadata,
        receipt,
        sync_to_disk,
    ) {
        Ok(art) => {
            state.event_feed.publish(
                "lifecycle",
                "artifact_upserted",
                Some(&art.id),
                json!({
                    "id": art.id,
                    "kind": art.kind.as_str(),
                    "status": art.status,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": art.id,
                "artifact": format_artifact_for_ui(&art),
            }))
        }
        Err(err) => HttpResponse::error(400, "lifecycle_upsert_failed", &err),
    }
}

fn handle_lifecycle_link(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(from_id) = str_field(&obj, &["fromId", "from_id", "from"]) else {
        return HttpResponse::error(400, "missing_from_id", "Field 'fromId' is required.");
    };
    let Some(to_id) = str_field(&obj, &["toId", "to_id", "to"]) else {
        return HttpResponse::error(400, "missing_to_id", "Field 'toId' is required.");
    };
    let rel = LinkRelation::from_str_lossy(
        str_field(&obj, &["relation", "kind"]).unwrap_or("cites"),
    );
    let note = str_field(&obj, &["note", "reason"]).unwrap_or("");

    match state.artifact_os.link_artifacts(from_id, to_id, rel, note) {
        Ok(link) => {
            state.event_feed.publish(
                "lifecycle",
                "artifact_linked",
                Some(from_id),
                json!({ "fromId": from_id, "toId": to_id, "relation": rel.as_str() }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "link": link,
            }))
        }
        Err(err) => HttpResponse::error(400, "lifecycle_link_failed", &err),
    }
}

fn handle_lifecycle_todo(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let action = str_field(&obj, &["action"]).unwrap_or("auto");
    let status = str_field(&obj, &["status", "state"]).unwrap_or("pending");
    let evidence = str_field(&obj, &["evidenceReceipt", "evidence_receipt", "evidence"]);

    if action.eq_ignore_ascii_case("add")
        || action.eq_ignore_ascii_case("create")
        || str_field(&obj, &["id", "todoId", "todo_id"]).is_none()
    {
        let Some(title) = str_field(&obj, &["title", "text", "name"]) else {
            return HttpResponse::error(
                400,
                "missing_todo_fields",
                "Field 'id' (to update) or 'title' (to create) is required.",
            );
        };
        let slug = str_field(&obj, &["slug"])
            .map(ToString::to_string)
            .unwrap_or_else(|| slugify(title));
        let body = str_field(&obj, &["body", "bodyMd", "content"]).unwrap_or(title);
        let receipt = parse_optional_receipt(&obj);
        return match state.artifact_os.upsert_artifact(
            ArtifactKind::Todo,
            &slug,
            title,
            status,
            "project",
            body,
            json!({}),
            receipt,
            false,
        ) {
            Ok(art) => {
                state.event_feed.publish(
                    "lifecycle",
                    "todo_updated",
                    Some(&art.id),
                    json!({ "id": art.id, "status": art.status }),
                );
                HttpResponse::ok(json!({
                    "ok": true,
                    "state": "online",
                    "id": art.id,
                    "todo": format_artifact_for_ui(&art),
                    "artifact": format_artifact_for_ui(&art),
                }))
            }
            Err(err) => HttpResponse::error(400, "lifecycle_todo_failed", &err),
        };
    }

    let id = str_field(&obj, &["id", "todoId", "todo_id"]).unwrap_or("");
    match state.artifact_os.update_todo_status(id, status, evidence) {
        Ok(art) => {
            state.event_feed.publish(
                "lifecycle",
                "todo_updated",
                Some(&art.id),
                json!({ "id": art.id, "status": art.status }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": art.id,
                "todo": format_artifact_for_ui(&art),
                "artifact": format_artifact_for_ui(&art),
            }))
        }
        Err(err) => {
            let code_status = if err.contains("not found") { 404 } else { 400 };
            HttpResponse::error(code_status, "lifecycle_todo_failed", &err)
        }
    }
}

fn handle_lifecycle_dod(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(raw_id) = str_field(&obj, &["id", "gateId", "gate_id", "slug"]) else {
        return HttpResponse::error(400, "missing_dod_id", "Field 'gateId' or 'id' is required.");
    };

    let state_str = str_field(&obj, &["state", "status"]).unwrap_or("");
    let passed = obj.get("passed").and_then(Value::as_bool).unwrap_or_else(|| {
        matches!(
            state_str.to_ascii_lowercase().as_str(),
            "verified" | "pass" | "passed" | "done"
        )
    });

    let receipt = parse_optional_receipt(&obj).unwrap_or_default();
    if passed && receipt.verified.is_empty() {
        return HttpResponse::error(
            400,
            "dod_receipt_required",
            "DoD gate cannot be marked Verified/passed without fresh ExecutionReceipt evidence.",
        );
    }

    // Ensure the DoD artifact exists (supporting one-shot gate upsert + receipt verification).
    let existing = state
        .artifact_os
        .list_artifacts(Some(ArtifactKind::Dod), None)
        .unwrap_or_default();
    let target_id = if let Some(found) = existing
        .iter()
        .find(|a| a.id == raw_id || a.slug.eq_ignore_ascii_case(&slugify(raw_id)))
    {
        found.id.clone()
    } else {
        let title = str_field(&obj, &["title", "name"]).unwrap_or(raw_id);
        let slug = slugify(raw_id.trim_start_matches("dod_"));
        match state.artifact_os.upsert_artifact(
            ArtifactKind::Dod,
            &slug,
            title,
            "open",
            "project",
            str_field(&obj, &["body", "bodyMd", "content"]).unwrap_or(title),
            json!({ "gateId": raw_id }),
            None,
            false,
        ) {
            Ok(created) => created.id,
            Err(err) => return HttpResponse::error(400, "lifecycle_dod_failed", &err),
        }
    };

    match state.artifact_os.update_dod_gate(&target_id, passed, receipt) {
        Ok(art) => {
            state.event_feed.publish(
                "lifecycle",
                "dod_gate_updated",
                Some(&art.id),
                json!({ "id": art.id, "passed": passed, "status": art.status }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": art.id,
                "passed": passed,
                "artifact": format_artifact_for_ui(&art),
            }))
        }
        Err(err) => HttpResponse::error(400, "lifecycle_dod_failed", &err),
    }
}

fn handle_lifecycle_handoff(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let title = str_field(&obj, &["title"]).unwrap_or("Session Handoff");
    let mut body_md = str_field(&obj, &["bodyMd", "body_md", "body", "summary", "content"])
        .unwrap_or("Session checkpoint handoff.")
        .to_string();
    if let Some(next_step) = str_field(&obj, &["nextStep", "next_step"]) {
        body_md.push_str("\n\n## Next Executable Action\n\n");
        body_md.push_str(next_step);
    }
    if let Some(notes) = str_field(&obj, &["agentNotes", "agent_notes"]) {
        if !body_md.contains("<!-- AGENT_NOTES_START -->") {
            body_md.push_str("\n\n<!-- AGENT_NOTES_START -->\n");
            body_md.push_str(notes);
            body_md.push_str("\n<!-- AGENT_NOTES_END -->\n");
        }
    }
    let receipt = parse_optional_receipt(&obj).unwrap_or_default();
    let sync_to_disk = obj
        .get("syncToDisk")
        .or_else(|| obj.get("sync_to_disk"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match state
        .artifact_os
        .write_handoff_preserving_notes(title, &body_md, receipt, sync_to_disk)
    {
        Ok(art) => {
            state.event_feed.publish(
                "lifecycle",
                "handoff_written",
                Some(&art.id),
                json!({ "id": art.id, "sha256": art.sha256_hex }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": art.id,
                "handoff": format_artifact_for_ui(&art),
                "artifact": format_artifact_for_ui(&art),
            }))
        }
        Err(err) => HttpResponse::error(400, "lifecycle_handoff_failed", &err),
    }
}

fn handle_lifecycle_super_state_get(state: &Arc<StudioState>) -> HttpResponse {
    let super_state = state.artifact_os.super_state().unwrap_or_default();
    let engine_map = omnia_harness::artifact_os::read_engine_state_map(&state.config.workspace_root);
    let mut out = serde_json::to_value(&super_state).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut map) = out {
        map.insert("ok".to_string(), json!(true));
        map.insert("state".to_string(), json!("online"));
        map.insert("tokenBudget".to_string(), Value::Null);
        map.insert("superState".to_string(), json!(super_state));
        map.insert("engineState".to_string(), Value::Object(engine_map));
    }
    HttpResponse::ok(out)
}

fn handle_lifecycle_super_state_post(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let sync_to_disk = obj
        .get("syncToDisk")
        .or_else(|| obj.get("sync_to_disk"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match state
        .artifact_os
        .update_super_state(Value::Object(obj.clone()), false)
    {
        Ok(st) => {
            let engine_state = if sync_to_disk {
                let mut patch = serde_json::Map::new();
                patch.insert("phase".to_string(), json!(st.phase));
                patch.insert("lifecyclePhase".to_string(), json!(st.phase));
                patch.insert("wave".to_string(), json!(st.wave));
                patch.insert("strikeCount".to_string(), json!(st.strike_count));
                patch.insert("tokenBudget".to_string(), Value::Null);
                omnia_harness::artifact_os::merge_engine_state_lossless(
                    &state.config.workspace_root,
                    Value::Object(patch),
                )
                .ok()
            } else {
                None
            };
            state.event_feed.publish(
                "lifecycle",
                "super_state_updated",
                None,
                json!({ "phase": st.phase, "wave": st.wave, "strikeCount": st.strike_count }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "tokenBudget": Value::Null,
                "superState": st,
                "engineState": engine_state,
            }))
        }
        Err(err) => HttpResponse::error(400, "super_state_update_failed", &err),
    }
}

fn handle_lifecycle_verify(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let content = obj
        .get("content")
        .or_else(|| obj.get("bodyMd"))
        .or_else(|| obj.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let fg_hex = str_field(&obj, &["fgHex", "fg_hex", "fg"]);
    let bg_hex = str_field(&obj, &["bgHex", "bg_hex", "bg"]);
    let check_citations = obj
        .get("checkCitations")
        .or_else(|| obj.get("check_citations"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let report = verify_artifact_content(
        content,
        fg_hex,
        bg_hex,
        if check_citations {
            Some(&state.research_vault)
        } else {
            None
        },
    );
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "passed": report.ok,
        "report": report,
    }))
}

// =========================================================================
// 4. 2-Tier Auto-Learn & Gap Radar
// =========================================================================

fn handle_learn_lessons(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let scope = req
        .query_param("scope")
        .or_else(|| req.query_param("tier"))
        .filter(|s| !s.trim().is_empty() && !s.eq_ignore_ascii_case("all"));

    let lessons: Vec<Value> = state
        .artifact_os
        .list_lessons(scope.as_deref())
        .unwrap_or_default()
        .iter()
        .map(format_lesson_for_ui)
        .collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": lessons.len(),
        "lessons": lessons,
    }))
}

fn handle_learn_capture(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(title) = str_field(&obj, &["title", "name"]) else {
        return HttpResponse::error(400, "missing_title", "Field 'title' is required.");
    };
    let invariant = str_field(&obj, &["invariant", "lesson", "content", "body"])
        .unwrap_or("")
        .to_string();
    if invariant.is_empty() {
        return HttpResponse::error(
            400,
            "missing_invariant",
            "Field 'invariant' (or 'lesson') is required.",
        );
    }
    let scope = str_field(&obj, &["scope", "tier"]).unwrap_or("project");
    let sync_to_disk = obj
        .get("syncToDisk")
        .or_else(|| obj.get("sync_to_disk"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let record = LessonRecord {
        id: str_field(&obj, &["id"]).unwrap_or("").to_string(),
        scope: scope.to_string(),
        title: title.to_string(),
        symptom: str_field(&obj, &["symptom"])
            .unwrap_or(title)
            .to_string(),
        root_cause: str_field(&obj, &["rootCause", "root_cause"])
            .unwrap_or(&invariant)
            .to_string(),
        invariant,
        anti_pattern: str_field(&obj, &["antiPattern", "anti_pattern"])
            .unwrap_or("")
            .to_string(),
        verify_cmd: str_field(&obj, &["verifyCmd", "verify_cmd"])
            .unwrap_or("")
            .to_string(),
        tags: str_vec_field(&obj, &["tags"]),
        provenance_sha: String::new(),
        promoted_skill_slug: None,
        overlap_warning: None,
        created_at_ms: now_epoch_ms(),
    };

    match state.artifact_os.capture_lesson(record, sync_to_disk) {
        Ok(saved) => {
            state.event_feed.publish(
                "lifecycle",
                "lesson_captured",
                Some(&saved.id),
                json!({
                    "id": saved.id,
                    "scope": saved.scope,
                    "overlapWarning": saved.overlap_warning,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "id": saved.id,
                "lesson": format_lesson_for_ui(&saved),
            }))
        }
        Err(err) => HttpResponse::error(400, "lesson_capture_failed", &err),
    }
}

fn handle_learn_promote_skill(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let lesson_id = str_field(&obj, &["lessonId", "lesson_id", "id"]).unwrap_or("");
    let slug = str_field(&obj, &["slug", "skillSlug", "skill_slug"])
        .map(ToString::to_string)
        .unwrap_or_else(|| slugify(lesson_id));
    let description = str_field(&obj, &["description"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("Use when applying verified lesson {slug}."));
    let dry_run = obj
        .get("dryRun")
        .or_else(|| obj.get("dry_run"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let lessons = state.artifact_os.list_lessons(None).unwrap_or_default();
    let matched = lessons.iter().find(|l| l.id == lesson_id);
    let body_md = str_field(&obj, &["bodyMd", "body_md", "body"])
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if let Some(l) = matched {
                format!(
                    "# {}\n\n## Invariant\n{}\n\n## Root Cause\n{}\n\n## Verify\n`{}`\n",
                    l.title, l.invariant, l.root_cause, l.verify_cmd
                )
            } else {
                format!("# {slug}\n\n## Purpose\nPromoted verified Omnia lesson.\n")
            }
        });

    let codify_req = CodifySkillRequest {
        slug: slug.clone(),
        description,
        category: str_field(&obj, &["category"])
            .unwrap_or("Omnia Learned Skill")
            .to_string(),
        canonical_artifacts: str_vec_field(&obj, &["canonicalArtifacts", "canonical_artifacts"]),
        body_md,
        invariants_md: str_field(&obj, &["invariantsMd", "invariants_md"]).map(ToString::to_string),
        dry_run,
    };

    match state
        .skills
        .codify_skill(&state.config.workspace_root, &codify_req)
    {
        Ok(result) => {
            if !dry_run && !lesson_id.is_empty() {
                let _ = state.artifact_os.mark_lesson_promoted(lesson_id, &slug);
            }
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "lessonId": lesson_id,
                "result": result,
            }))
        }
        Err(err) => HttpResponse::error(400, "promote_skill_failed", &err),
    }
}

fn handle_learn_gap_radar_get(state: &Arc<StudioState>) -> HttpResponse {
    match state.artifact_os.gap_radar_report() {
        Ok(mut report) => {
            if let Value::Object(ref mut map) = report {
                map.insert("ok".to_string(), json!(true));
                map.insert("state".to_string(), json!("online"));
            }
            HttpResponse::ok(report)
        }
        Err(_) => HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "totalGapEvents": 0,
            "upgradeCandidates": [],
            "recentEvents": [],
        })),
    }
}

fn handle_learn_gap_radar_post(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(query) = str_field(&obj, &["query", "q"]) else {
        return HttpResponse::error(400, "missing_query", "Field 'query' is required.");
    };
    let best_score = obj
        .get("bestScore")
        .or_else(|| obj.get("best_score"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let retries = obj
        .get("retries")
        .and_then(Value::as_u64)
        .map(|n| n.min(100) as u32)
        .unwrap_or(0);
    let reason = str_field(&obj, &["reason"]).unwrap_or("low_confidence_route");

    match state
        .artifact_os
        .record_gap_telemetry(query, best_score, retries, reason)
    {
        Ok(event) => HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "event": event,
        })),
        Err(err) => HttpResponse::error(400, "gap_radar_record_failed", &err),
    }
}

fn handle_learn_sync_global(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let _obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    match omnia_harness::artifact_os::sync_global_lessons(&state.config.workspace_root) {
        Ok(report) => {
            state.event_feed.publish(
                "lifecycle",
                "global_lessons_synced",
                None,
                SecretRedactor::redact_json(&report),
            );
            HttpResponse::ok(SecretRedactor::redact_json(&report))
        }
        Err(err) => HttpResponse::error(400, "learn_sync_global_failed", &err),
    }
}

// =========================================================================
// 5. Bilingual Skills Router, Cold Vault, 4-Stage DAG, Pipelines & Doctor
// =========================================================================

fn handle_skills_route(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let (query, limit, include_vault) = if req.method == "GET" {
        let q = req
            .query_param("q")
            .or_else(|| req.query_param("query"))
            .unwrap_or_default();
        let lim = req
            .query_param("top_k")
            .or_else(|| req.query_param("topK"))
            .or_else(|| req.query_param("limit"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(8);
        let inc = req
            .query_param("include_vault")
            .or_else(|| req.query_param("includeVault"))
            .map(|s| !matches!(s.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no"))
            .unwrap_or(true);
        (q, lim, inc)
    } else {
        let obj = match parse_obj(req) {
            Ok(m) => m,
            Err(resp) => return resp,
        };
        let q = str_field(&obj, &["query", "q"]).unwrap_or("").to_string();
        let lim = obj
            .get("topK")
            .or_else(|| obj.get("top_k"))
            .or_else(|| obj.get("limit"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(8);
        let inc = obj
            .get("includeVault")
            .or_else(|| obj.get("include_vault"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        (q, lim, inc)
    };

    let mut payload = state
        .skills
        .search_with_vault(query.trim(), limit.clamp(1, 50), include_vault);
    if let Value::Object(ref mut map) = payload {
        map.insert("ok".to_string(), json!(true));
        map.insert("state".to_string(), json!("online"));
    }
    HttpResponse::ok(payload)
}

fn handle_skills_vault(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let q = req
        .query_param("q")
        .or_else(|| req.query_param("query"))
        .unwrap_or_default();
    let category = req
        .query_param("category")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let limit = req
        .query_param("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .clamp(1, 1_200);

    let active = state.skills.list_skills().unwrap_or_default();
    let vault = state.skills.cold_vault_entries();
    let doctor = state.skills.doctor();

    let needle = q.trim().to_ascii_lowercase();
    let filtered_vault: Vec<Value> = vault
        .iter()
        .filter(|e| {
            let cat_ok = category.is_empty()
                || e.category.to_ascii_lowercase().contains(&category)
                || e.category_id.eq_ignore_ascii_case(&category);
            let q_ok = needle.is_empty()
                || e.slug.to_ascii_lowercase().contains(&needle)
                || e.focus.to_ascii_lowercase().contains(&needle)
                || e.category.to_ascii_lowercase().contains(&needle);
            cat_ok && q_ok
        })
        .take(limit)
        .map(|e| serde_json::to_value(e).unwrap_or_else(|_| json!({})))
        .collect();

    let active_json: Vec<Value> = active.iter().map(|s| s.to_json()).collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "query": q.trim(),
        "activeTotal": active.len(),
        "vaultTotal": vault.len(),
        "totalCount": active.len() + vault.len(),
        "startupTokensEst": doctor.startup_tokens_est,
        "merkleRootSha256": doctor.merkle_root_sha256,
        "activeSkills": active_json,
        "skills": filtered_vault,
        "items": filtered_vault,
    }))
}

fn handle_skills_dag(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let (query, max_per_stage) = if req.method == "GET" {
        let q = req
            .query_param("q")
            .or_else(|| req.query_param("query"))
            .unwrap_or_default();
        let m = req
            .query_param("maxPerStage")
            .or_else(|| req.query_param("max_per_stage"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(3);
        (q, m)
    } else {
        let obj = match parse_obj(req) {
            Ok(m) => m,
            Err(resp) => return resp,
        };
        let q = str_field(&obj, &["query", "q"]).unwrap_or("").to_string();
        let m = obj
            .get("maxPerStage")
            .or_else(|| obj.get("max_per_stage"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(3);
        (q, m)
    };

    let mut dag = state
        .skills
        .compose_4stage_dag(query.trim(), max_per_stage.clamp(1, 6));
    if let Value::Object(ref mut map) = dag {
        map.insert("ok".to_string(), json!(true));
        map.insert("state".to_string(), json!("online"));
    }
    HttpResponse::ok(dag)
}

fn handle_skills_pipelines(state: &Arc<StudioState>) -> HttpResponse {
    let pipelines = state.skills.pipelines();
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "count": pipelines.len(),
        "pipelines": pipelines,
    }))
}

fn handle_skills_doctor(state: &Arc<StudioState>) -> HttpResponse {
    let report = state.skills.doctor();
    let mut out = serde_json::to_value(&report).unwrap_or_else(|_| json!({}));
    if let Value::Object(ref mut map) = out {
        map.insert("state".to_string(), json!("online"));
        map.insert("report".to_string(), json!(report));
    }
    HttpResponse::ok(out)
}

fn handle_skills_codify(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(slug) = str_field(&obj, &["slug", "name"]) else {
        return HttpResponse::error(400, "missing_slug", "Field 'slug' is required.");
    };
    let Some(description) = str_field(&obj, &["description"]) else {
        return HttpResponse::error(
            400,
            "missing_description",
            "Field 'description' (starting with 'Use when...') is required.",
        );
    };
    let body_md = str_field(&obj, &["bodyMd", "body_md", "body", "content"]).unwrap_or("");
    if body_md.is_empty() {
        return HttpResponse::error(400, "missing_body", "Field 'bodyMd' is required.");
    }

    let codify_req = CodifySkillRequest {
        slug: slug.to_string(),
        description: description.to_string(),
        category: str_field(&obj, &["category"])
            .unwrap_or("Omnia Learned Skill")
            .to_string(),
        canonical_artifacts: str_vec_field(&obj, &["canonicalArtifacts", "canonical_artifacts"]),
        body_md: body_md.to_string(),
        invariants_md: str_field(&obj, &["invariantsMd", "invariants_md"]).map(ToString::to_string),
        dry_run: obj
            .get("dryRun")
            .or_else(|| obj.get("dry_run"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };

    match state
        .skills
        .codify_skill(&state.config.workspace_root, &codify_req)
    {
        Ok(mut res) => {
            if let Value::Object(ref mut map) = res {
                map.insert("state".to_string(), json!("online"));
            }
            HttpResponse::ok(res)
        }
        Err(err) => HttpResponse::error(400, "skill_codify_failed", &err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StudioConfig;
    use std::collections::BTreeMap;

    fn make_req(method: &str, path: &str, query: &str, body: Value) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            target: if query.is_empty() {
                path.to_string()
            } else {
                format!("{path}?{query}")
            },
            path: path.to_string(),
            query: query.to_string(),
            headers: BTreeMap::new(),
            cookie_header_count: 0,
            body: if method == "GET" {
                Vec::new()
            } else {
                serde_json::to_vec(&body).unwrap_or_default()
            },
        }
    }

    fn make_test_state() -> Arc<StudioState> {
        let mut cfg = StudioConfig::default();
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-rlv5-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let ws = tmp.join("ws");
        let rb = tmp.join("rb");
        let _ = std::fs::create_dir_all(&ws);
        let _ = std::fs::create_dir_all(&rb);
        cfg.workspace_root = ws;
        cfg.rollback_root = rb;
        cfg.db_path = None;
        cfg.runtime_url = None;
        Arc::new(StudioState::new(cfg).expect("build test StudioState"))
    }

    #[tokio::test]
    async fn empty_mount_endpoints_return_200_with_zero_4xx() {
        let state = make_test_state();
        for path in [
            "/api/v5/research/status",
            "/api/v5/research/sources",
            "/api/v5/rag/sources",
            "/api/v5/think/sessions",
            "/api/v5/lifecycle/artifacts",
            "/api/v5/lifecycle/super-state",
            "/api/v5/learn/lessons",
            "/api/v5/learn/gap-radar",
            "/api/v5/skills/vault",
            "/api/v5/skills/pipelines",
            "/api/v5/skills/doctor",
        ] {
            let req = make_req("GET", path, "", Value::Null);
            let resp = dispatch(&state, &req).await.expect("route matched");
            assert_eq!(resp.status, 200, "GET {path} must return 200 on empty store");
        }
    }

    #[tokio::test]
    async fn research_think_lifecycle_learn_skills_roundtrip_succeeds() {
        let state = make_test_state();

        // 1. Ingest + RAG query + Pin + Claim + Table + Export
        let ing = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/research/ingest",
                "",
                json!({
                    "url": "https://example.test/rust-wal",
                    "title": "WinSQLite WAL Guide",
                    "content": "# WAL\nCooperative leases keep WAL readers non-blocking.",
                    "tier": "local"
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(ing.status, 200);
        let ing_json: Value = serde_json::from_slice(&ing.body).unwrap();
        let cid = ing_json["citationId"].as_str().unwrap().to_string();
        assert!(cid.starts_with('S'));

        let rag_q = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/rag/query",
                "",
                json!({ "query": "cooperative leases WAL", "topK": 5 }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(rag_q.status, 200);
        let rag_json: Value = serde_json::from_slice(&rag_q.body).unwrap();
        assert!(!rag_json["hits"].as_array().unwrap().is_empty());

        let pin = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/rag/pin",
                "",
                json!({ "citationId": cid, "targetTier": "global" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(pin.status, 200);

        let clm = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/research/claim",
                "",
                json!({
                    "sessionId": "s1",
                    "text": format!("WAL keeps readers non-blocking [{cid}]."),
                    "citations": [cid],
                    "grade": "verified"
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(clm.status, 200);

        let tbl = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/research/table",
                "",
                json!({ "query": "WAL", "columns": ["citation_id", "title"] }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(tbl.status, 200);

        let exp = dispatch(
            &state,
            &make_req("GET", "/api/v5/research/export", "format=markdown", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(exp.status, 200);
        assert!(String::from_utf8_lossy(&exp.body).contains("## Sources (Searched, Viewed & Extracted)"));

        // 2. Deep Think lifecycle (start -> 3 branches -> falsify -> redteam -> conclude)
        let st = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/think/start",
                "",
                json!({ "problem": "Choose KV cache eviction policy", "effort": "high" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(st.status, 200);
        let tid = serde_json::from_slice::<Value>(&st.body).unwrap()["thinkId"]
            .as_str()
            .unwrap()
            .to_string();
        for (kind, title) in [("baseline", "LRU"), ("sota", "Prefix-0"), ("contrarian", "Zero")] {
            let br = dispatch(
                &state,
                &make_req(
                    "POST",
                    "/api/v5/think/branch",
                    "",
                    json!({ "sessionId": tid, "kind": kind, "title": title, "hypothesis": title }),
                ),
            )
            .await
            .unwrap();
            assert_eq!(br.status, 200);
        }
        let fals = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/think/falsify",
                "",
                json!({ "sessionId": tid, "branch": "baseline", "result": "falsified on jitter" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(fals.status, 200);
        let rt = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/think/redteam",
                "",
                json!({ "sessionId": tid, "critique": "Prefix drift check", "resolved": true }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(rt.status, 200);
        let conc = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/think/conclude",
                "",
                json!({ "sessionId": tid, "winner": "sota", "summary": "Prefix-0 invariant wins" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(conc.status, 200);

        // 3. Lifecycle OS + receipt-gated DoD + Handoff notes preservation + Learn + Skills DAG
        let dod_no_rcpt = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/lifecycle/dod",
                "",
                json!({ "gateId": "DOD-1", "title": "Zero secrets", "state": "Verified" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(dod_no_rcpt.status, 400);

        let dod_ok = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/lifecycle/dod",
                "",
                json!({
                    "gateId": "DOD-1",
                    "title": "Zero secrets",
                    "state": "Verified",
                    "evidence": "audit.py rc=0"
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(dod_ok.status, 200);

        let handoff = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/lifecycle/handoff",
                "",
                json!({ "summary": "Wave done", "agentNotes": "Keep Prefix-0 locked." }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(handoff.status, 200);

        let learn = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/learn/capture",
                "",
                json!({
                    "tier": "project",
                    "title": "Never delayload ws2_32",
                    "lesson": "Avoid /DELAYLOAD:ws2_32.dll on Windows Rust builds."
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(learn.status, 200);

        let dag = dispatch(
            &state,
            &make_req("GET", "/api/v5/skills/dag", "q=nghien+cuu+rust", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(dag.status, 200);
        let dag_json: Value = serde_json::from_slice(&dag.body).unwrap();
        assert_eq!(dag_json["stages"].as_array().unwrap().len(), 4);

        // Verify 4-layer citations against seeded research vault
        let vc = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/research/verify-citations",
                "",
                json!({
                    "draft": "WAL mode ensures safe durability across restarts [S001].",
                    "strict": false
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(vc.status, 200);
        let vcj: Value = serde_json::from_slice(&vc.body).unwrap();
        assert_eq!(vcj["ok"], true);
        assert!(vcj.get("citationCoveragePct").is_some());
    }

    #[tokio::test]
    async fn delegates_steer27b_super_and_computer_routes() {
        let state = make_test_state();
        for path in [
            "/api/v5/super/status",
            "/api/v5/super/capabilities",
            "/api/v5/super/proceed",
            "/api/v5/computer/status",
        ] {
            assert!(is_known_route(path), "expected known route for {path}");
            let req = make_req("GET", path, "", Value::Null);
            let resp = dispatch(&state, &req).await.expect("delegated route matched");
            assert_eq!(resp.status, 200, "GET {path} must return 200");
        }
    }
}
