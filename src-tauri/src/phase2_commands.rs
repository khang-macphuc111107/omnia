use serde::Deserialize;
#[cfg(test)]
use serde::Serialize;

use crate::error::{NativeError, NativeResult};

const MAX_SCOPE_ID_BYTES: usize = 128;
#[cfg(test)]
const MAX_FILE_NAME_BYTES: usize = 512;
const MAX_MEDIA_TYPE_BYTES: usize = 255;
#[cfg(test)]
const MAX_ARTIFACT_TITLE_BYTES: usize = 500;
#[cfg(test)]
const MAX_ARTIFACT_LANGUAGE_BYTES: usize = 128;
#[cfg(test)]
const MAX_RETRIEVAL_QUERY_BYTES: usize = 16 * 1024;
#[cfg(test)]
const MAX_RETRIEVAL_TOP_K: u16 = 100;
#[cfg(test)]
const MAX_RETRIEVAL_TOKEN_BUDGET: u32 = 256_000;
#[cfg(test)]
const MAX_CITATION_SPANS: usize = 256;
#[cfg(test)]
const SHA256_HEX_BYTES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentPickRequest {
    pub conversation_id: String,
    pub branch_id: String,
    #[serde(default)]
    pub accepted_media_types: Vec<String>,
    pub max_files: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDraftGetRequest {
    pub draft_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDraftListRequest {
    pub conversation_id: String,
    pub branch_id: Option<String>,
    #[serde(default)]
    pub include_terminal: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDraftRemoveRequest {
    pub draft_id: String,
    pub attachment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDraftAbandonRequest {
    pub draft_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentListRequest {
    pub project_id: Option<String>,
    pub message_id: Option<String>,
    #[serde(default)]
    pub include_deleted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentTextReadRequest {
    pub attachment_id: String,
    pub max_bytes: Option<u32>,
}

/// Reads a bounded, verified projection of an encrypted attachment.  The
/// native side decrypts and authenticates the blob; the renderer receives only
/// a base64 payload and immutable metadata, never a path, nonce, or key.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentBinaryPreviewRequest {
    pub attachment_id: String,
    pub max_bytes: Option<u32>,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactCreateRequest {
    pub conversation_id: String,
    pub source_message_id: Option<String>,
    pub producing_run_id: String,
    pub kind: String,
    pub title: String,
    pub language: Option<String>,
    pub media_type: String,
    pub content: String,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRetrievalSearchRequest {
    pub project_id: String,
    pub query: String,
    pub top_k: Option<u16>,
    pub token_budget: Option<u32>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[cfg(test)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitationSpanInput {
    pub source_id: String,
    pub source_content_sha256: String,
    pub start: u32,
    pub end: u32,
    pub quoted_text: String,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitationValidateRequest {
    pub run_id: String,
    pub answer_text: String,
    pub spans: Vec<CitationSpanInput>,
}

#[cfg(test)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationValidationResult {
    pub valid: bool,
    pub span_count: usize,
    pub invalid_span_indexes: Vec<usize>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactKind {
    Document,
    Code,
    Table,
    Diagram,
    Html,
    Svg,
    Json,
    Csv,
    Text,
}

#[cfg(test)]
impl ArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Code => "code",
            Self::Table => "table",
            Self::Diagram => "diagram",
            Self::Html => "html",
            Self::Svg => "svg",
            Self::Json => "json",
            Self::Csv => "csv",
            Self::Text => "text",
        }
    }
}

pub fn validate_attachment_pick_request(request: &AttachmentPickRequest) -> NativeResult<()> {
    validate_prefixed_id("conversationId", &request.conversation_id, "conversation_")?;
    validate_prefixed_id("branchId", &request.branch_id, "branch_")?;
    let max_files = request.max_files.unwrap_or(20);
    if !(1..=100).contains(&max_files) {
        return Err(NativeError::invalid(
            "maxFiles",
            "must be between 1 and 100",
        ));
    }
    if request.accepted_media_types.len() > 64 {
        return Err(NativeError::invalid(
            "acceptedMediaTypes",
            "must contain at most 64 entries",
        ));
    }
    for media_type in &request.accepted_media_types {
        validate_media_type(media_type)?;
    }
    Ok(())
}

pub fn validate_attachment_draft_get_request(
    request: &AttachmentDraftGetRequest,
) -> NativeResult<()> {
    validate_prefixed_id("draftId", &request.draft_id, "attachment_draft_")
}

pub fn validate_attachment_draft_list_request(
    request: &AttachmentDraftListRequest,
) -> NativeResult<()> {
    validate_prefixed_id("conversationId", &request.conversation_id, "conversation_")?;
    if let Some(branch_id) = request.branch_id.as_deref() {
        validate_prefixed_id("branchId", branch_id, "branch_")?;
    }
    Ok(())
}

pub fn validate_attachment_draft_remove_request(
    request: &AttachmentDraftRemoveRequest,
) -> NativeResult<()> {
    validate_prefixed_id("draftId", &request.draft_id, "attachment_draft_")?;
    validate_prefixed_id("attachmentId", &request.attachment_id, "attachment_")
}

pub fn validate_attachment_draft_abandon_request(
    request: &AttachmentDraftAbandonRequest,
) -> NativeResult<()> {
    validate_prefixed_id("draftId", &request.draft_id, "attachment_draft_")
}

pub fn validate_attachment_list_request(request: &AttachmentListRequest) -> NativeResult<()> {
    validate_at_most_one_scope(request.project_id.as_deref(), request.message_id.as_deref())
}

pub fn validate_attachment_text_read_request(
    request: &AttachmentTextReadRequest,
) -> NativeResult<usize> {
    validate_prefixed_id("attachmentId", &request.attachment_id, "attachment_")?;
    validate_max_bytes(request.max_bytes, 16 * 1024 * 1024)
}

pub fn validate_attachment_binary_preview_request(
    request: &AttachmentBinaryPreviewRequest,
) -> NativeResult<usize> {
    validate_prefixed_id("attachmentId", &request.attachment_id, "attachment_")?;
    // Keep the IPC projection bounded. The ContentStore still enforces its
    // own configured ceiling and authenticates the complete blob before any
    // bytes are returned.
    validate_max_bytes(request.max_bytes, 16 * 1024 * 1024)
}

#[cfg(test)]
pub fn validate_artifact_create_request(
    request: &ArtifactCreateRequest,
) -> NativeResult<ArtifactKind> {
    validate_prefixed_id("conversationId", &request.conversation_id, "conversation_")?;
    if let Some(message_id) = request.source_message_id.as_deref() {
        validate_prefixed_id("sourceMessageId", message_id, "message_")?;
    }
    validate_prefixed_id("producingRunId", &request.producing_run_id, "run_")?;
    let kind = parse_artifact_kind(&request.kind)?;
    validate_bounded_text("title", &request.title, MAX_ARTIFACT_TITLE_BYTES, false)?;
    if let Some(language) = request.language.as_deref() {
        validate_bounded_text("language", language, MAX_ARTIFACT_LANGUAGE_BYTES, false)?;
    }
    validate_media_type(&request.media_type)?;
    validate_artifact_content(&request.content)?;
    Ok(kind)
}

#[cfg(test)]
pub fn validate_project_retrieval_search_request(
    request: &ProjectRetrievalSearchRequest,
) -> NativeResult<(u16, u32)> {
    validate_prefixed_id("projectId", &request.project_id, "project_")?;
    validate_bounded_text("query", &request.query, MAX_RETRIEVAL_QUERY_BYTES, false)?;
    let top_k = request.top_k.unwrap_or(12);
    if !(1..=MAX_RETRIEVAL_TOP_K).contains(&top_k) {
        return Err(NativeError::invalid(
            "topK",
            format!("must be between 1 and {MAX_RETRIEVAL_TOP_K}"),
        ));
    }
    let token_budget = request.token_budget.unwrap_or(8_000);
    if !(1..=MAX_RETRIEVAL_TOKEN_BUDGET).contains(&token_budget) {
        return Err(NativeError::invalid(
            "tokenBudget",
            format!("must be between 1 and {MAX_RETRIEVAL_TOKEN_BUDGET}"),
        ));
    }
    if request.attachment_ids.len() > 1_000 {
        return Err(NativeError::invalid(
            "attachmentIds",
            "must contain at most 1000 entries",
        ));
    }
    for attachment_id in &request.attachment_ids {
        validate_prefixed_id("attachmentId", attachment_id, "attachment_")?;
    }
    Ok((top_k, token_budget))
}

#[cfg(test)]
pub fn validate_citation_request(
    request: &CitationValidateRequest,
) -> NativeResult<CitationValidationResult> {
    validate_prefixed_id("runId", &request.run_id, "run_")?;
    if request.spans.len() > MAX_CITATION_SPANS {
        return Err(NativeError::invalid(
            "spans",
            format!("must contain at most {MAX_CITATION_SPANS} entries"),
        ));
    }
    let answer_len = request.answer_text.len();
    let mut invalid_span_indexes = Vec::new();
    for (index, span) in request.spans.iter().enumerate() {
        let source_valid = validate_source_id(&span.source_id).is_ok();
        let hash_valid = is_sha256_hex(&span.source_content_sha256);
        let start = span.start as usize;
        let end = span.end as usize;
        let range_valid = start < end
            && end <= answer_len
            && request.answer_text.is_char_boundary(start)
            && request.answer_text.is_char_boundary(end);
        let quote_valid =
            range_valid && request.answer_text.get(start..end) == Some(span.quoted_text.as_str());
        if !(source_valid && hash_valid && quote_valid) {
            invalid_span_indexes.push(index);
        }
    }
    Ok(CitationValidationResult {
        valid: invalid_span_indexes.is_empty(),
        span_count: request.spans.len(),
        invalid_span_indexes,
    })
}

#[cfg(test)]
fn validate_artifact_content(content: &str) -> NativeResult<()> {
    validate_bounded_text("content", content, 32 * 1024 * 1024, true)
}

fn validate_max_bytes(value: Option<u32>, hard_max: u32) -> NativeResult<usize> {
    let value = value.unwrap_or(hard_max.min(4 * 1024 * 1024));
    if value == 0 || value > hard_max {
        return Err(NativeError::invalid(
            "maxBytes",
            format!("must be between 1 and {hard_max}"),
        ));
    }
    Ok(value as usize)
}

#[cfg(test)]
fn parse_artifact_kind(value: &str) -> NativeResult<ArtifactKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "document" => Ok(ArtifactKind::Document),
        "code" => Ok(ArtifactKind::Code),
        "table" => Ok(ArtifactKind::Table),
        "diagram" => Ok(ArtifactKind::Diagram),
        "html" => Ok(ArtifactKind::Html),
        "svg" => Ok(ArtifactKind::Svg),
        "json" => Ok(ArtifactKind::Json),
        "csv" => Ok(ArtifactKind::Csv),
        "text" => Ok(ArtifactKind::Text),
        _ => Err(NativeError::invalid("kind", "is not supported")),
    }
}

fn validate_at_most_one_scope(first: Option<&str>, second: Option<&str>) -> NativeResult<()> {
    if first.is_some() && second.is_some() {
        return Err(NativeError::invalid(
            "scope",
            "must identify only one parent",
        ));
    }
    if let Some(project_id) = first {
        validate_prefixed_id("projectId", project_id, "project_")?;
    }
    if let Some(scoped_id) = second {
        let prefix = if scoped_id.starts_with("conversation_") {
            "conversation_"
        } else {
            "message_"
        };
        validate_prefixed_id("scopeId", scoped_id, prefix)?;
    }
    Ok(())
}

fn validate_prefixed_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    if value.len() > MAX_SCOPE_ID_BYTES {
        return Err(NativeError::invalid(field, "is too long"));
    }
    let suffix = value.strip_prefix(prefix).unwrap_or_default();
    if suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(NativeError::invalid(field, "is malformed"))
    }
}

#[cfg(test)]
fn validate_source_id(value: &str) -> NativeResult<()> {
    for prefix in ["attachment_", "workspace_chunk_", "source_chunk_"] {
        if validate_prefixed_id("sourceId", value, prefix).is_ok() {
            return Ok(());
        }
    }
    Err(NativeError::invalid("sourceId", "is malformed"))
}

fn validate_media_type(value: &str) -> NativeResult<()> {
    validate_bounded_text("mediaType", value, MAX_MEDIA_TYPE_BYTES, false)?;
    let Some((category, subtype)) = value.trim().split_once('/') else {
        return Err(NativeError::invalid("mediaType", "must be a MIME type"));
    };
    if category.is_empty()
        || subtype.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !byte.is_ascii_control())
    {
        return Err(NativeError::invalid(
            "mediaType",
            "must be a printable MIME type",
        ));
    }
    Ok(())
}

fn validate_bounded_text(
    field: &'static str,
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
) -> NativeResult<()> {
    if !allow_empty && value.trim().is_empty() {
        return Err(NativeError::invalid(field, "cannot be empty"));
    }
    if value.len() > max_bytes {
        return Err(NativeError::invalid(
            field,
            format!("must be at most {max_bytes} UTF-8 bytes"),
        ));
    }
    if value.chars().any(|character| character == '\0') {
        return Err(NativeError::invalid(field, "cannot contain NUL"));
    }
    Ok(())
}

#[cfg(test)]
fn is_sha256_hex(value: &str) -> bool {
    value.len() == SHA256_HEX_BYTES && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(prefix: &str, digit: char) -> String {
        format!("{prefix}{}", digit.to_string().repeat(32))
    }

    #[test]
    fn attachment_picker_requires_a_native_owned_conversation_branch_scope() {
        let valid = AttachmentPickRequest {
            conversation_id: id("conversation_", 'a'),
            branch_id: id("branch_", 'b'),
            accepted_media_types: vec!["application/pdf".to_owned(), "image/png".to_owned()],
            max_files: Some(20),
        };
        assert!(validate_attachment_pick_request(&valid).is_ok());

        let invalid = AttachmentPickRequest {
            conversation_id: id("project_", 'c'),
            branch_id: valid.branch_id.clone(),
            accepted_media_types: Vec::new(),
            max_files: None,
        };
        assert!(validate_attachment_pick_request(&invalid).is_err());
    }

    #[test]
    fn attachment_draft_requests_accept_only_opaque_native_ids() {
        let get = AttachmentDraftGetRequest {
            draft_id: id("attachment_draft_", 'a'),
        };
        assert!(validate_attachment_draft_get_request(&get).is_ok());

        let list = AttachmentDraftListRequest {
            conversation_id: id("conversation_", 'b'),
            branch_id: Some(id("branch_", 'c')),
            include_terminal: false,
        };
        assert!(validate_attachment_draft_list_request(&list).is_ok());

        let remove = AttachmentDraftRemoveRequest {
            draft_id: get.draft_id.clone(),
            attachment_id: id("attachment_", 'd'),
        };
        assert!(validate_attachment_draft_remove_request(&remove).is_ok());

        let abandon = AttachmentDraftAbandonRequest {
            draft_id: get.draft_id,
        };
        assert!(validate_attachment_draft_abandon_request(&abandon).is_ok());

        let wrong_scope = AttachmentDraftListRequest {
            conversation_id: id("project_", 'e'),
            branch_id: Some(id("branch_", 'f')),
            include_terminal: true,
        };
        assert!(validate_attachment_draft_list_request(&wrong_scope).is_err());
    }

    #[test]
    fn binary_attachment_preview_is_bounded_and_native_id_only() {
        let valid = AttachmentBinaryPreviewRequest {
            attachment_id: id("attachment_", 'a'),
            max_bytes: Some(1024),
        };
        assert_eq!(
            validate_attachment_binary_preview_request(&valid).unwrap(),
            1024
        );

        let invalid_id = AttachmentBinaryPreviewRequest {
            attachment_id: "C:\\private\\secret.bin".to_owned(),
            max_bytes: Some(1024),
        };
        assert!(validate_attachment_binary_preview_request(&invalid_id).is_err());

        let oversized = AttachmentBinaryPreviewRequest {
            max_bytes: Some(16 * 1024 * 1024 + 1),
            ..valid
        };
        assert!(validate_attachment_binary_preview_request(&oversized).is_err());
    }

    #[test]
    fn artifact_contract_rejects_unknown_kinds_and_unbounded_content() {
        let request = ArtifactCreateRequest {
            conversation_id: id("conversation_", '1'),
            source_message_id: Some(id("message_", '2')),
            producing_run_id: id("run_", '3'),
            kind: "executable".to_owned(),
            title: "Unsafe".to_owned(),
            language: None,
            media_type: "application/octet-stream".to_owned(),
            content: "payload".to_owned(),
        };
        assert!(validate_artifact_create_request(&request).is_err());

        let mut supported = request;
        supported.kind = "code".to_owned();
        supported.media_type = "text/plain".to_owned();
        assert_eq!(
            validate_artifact_create_request(&supported)
                .unwrap()
                .as_str(),
            "code"
        );
    }

    #[test]
    fn retrieval_budget_is_explicit_and_bounded() {
        let request = ProjectRetrievalSearchRequest {
            project_id: id("project_", 'a'),
            query: "native content-addressed persistence".to_owned(),
            top_k: Some(12),
            token_budget: Some(8_000),
            attachment_ids: vec![id("attachment_", 'b')],
        };
        assert_eq!(
            validate_project_retrieval_search_request(&request).unwrap(),
            (12, 8_000)
        );

        let oversized = ProjectRetrievalSearchRequest {
            token_budget: Some(MAX_RETRIEVAL_TOKEN_BUDGET + 1),
            ..request
        };
        assert!(validate_project_retrieval_search_request(&oversized).is_err());
    }

    #[test]
    fn citation_validation_uses_utf8_byte_boundaries_and_exact_quotes() {
        let answer = "Grounded café answer";
        let start = answer.find("café").unwrap();
        let end = start + "café".len();
        let request = CitationValidateRequest {
            run_id: id("run_", 'c'),
            answer_text: answer.to_owned(),
            spans: vec![CitationSpanInput {
                source_id: id("attachment_", 'd'),
                source_content_sha256: "e".repeat(64),
                start: start as u32,
                end: end as u32,
                quoted_text: "café".to_owned(),
            }],
        };
        let result = validate_citation_request(&request).unwrap();
        assert!(result.valid);

        let invalid = CitationValidateRequest {
            spans: vec![CitationSpanInput {
                quoted_text: "cafe".to_owned(),
                ..request.spans[0].clone()
            }],
            ..request
        };
        let result = validate_citation_request(&invalid).unwrap();
        assert!(!result.valid);
        assert_eq!(result.invalid_span_indexes, vec![0]);
    }

    #[test]
    fn request_deserialization_denies_unknown_fields() {
        let value = serde_json::json!({
            "projectId": id("project_", 'a'),
            "messageId": null,
            "acceptedMediaTypes": [],
            "maxFiles": 1,
            "rawPath": "C:\\\\secret.txt"
        });
        assert!(serde_json::from_value::<AttachmentPickRequest>(value).is_err());

        let value = serde_json::json!({
            "draftId": id("attachment_draft_", 'b'),
            "attachmentId": id("attachment_", 'c'),
            "rawPath": "C:\\\\secret.txt"
        });
        assert!(serde_json::from_value::<AttachmentDraftRemoveRequest>(value).is_err());
    }

    #[test]
    fn filenames_and_media_types_are_bounded() {
        assert!(
            validate_bounded_text("filename", "document.pdf", MAX_FILE_NAME_BYTES, false).is_ok()
        );
        assert!(validate_media_type("application/pdf").is_ok());
        assert!(validate_media_type("not-a-mime").is_err());
    }
}
