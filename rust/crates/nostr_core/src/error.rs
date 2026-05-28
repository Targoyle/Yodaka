use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("event json could not be parsed")]
    InvalidEventJson(#[source] serde_json::Error),
    #[error("tags json could not be parsed")]
    InvalidTagsJson(#[source] serde_json::Error),
    #[error("secret key could not be parsed")]
    InvalidSecretKey,
    #[error("unsigned event json could not be parsed")]
    InvalidUnsignedEventJson,
    #[error("unsigned event is invalid")]
    InvalidUnsignedEvent,
    #[error("event id is required")]
    MissingEventId,
    #[error("pubkey is required")]
    MissingPubkey,
    #[error("content is required")]
    MissingContent,
    #[error("signature placeholder is required")]
    MissingSignature,
    #[error("content exceeds the local size limit")]
    ContentTooLarge,
    #[error("too many tags")]
    TooManyTags,
    #[error("tag has too many fields")]
    TooManyTagFields,
    #[error("tag value exceeds the local size limit")]
    TagValueTooLarge,
    #[error("unsigned event pubkey does not match signer")]
    SignerPubkeyMismatch,
    #[error("local signer is not initialized")]
    LocalSignerUnavailable,
}

#[derive(Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

impl CoreError {
    pub fn payload_json(&self) -> String {
        let payload = ErrorPayload {
            code: self.code(),
            message: self.to_string(),
        };

        serde_json::to_string(&payload).unwrap_or_else(|_| {
            String::from(
                "{\"code\":\"serialization_failed\",\"message\":\"failed to serialize error\"}",
            )
        })
    }

    fn code(&self) -> &'static str {
        match self {
            Self::InvalidEventJson(_) => "invalid_event_json",
            Self::InvalidTagsJson(_) => "invalid_tags_json",
            Self::InvalidSecretKey => "invalid_secret_key",
            Self::InvalidUnsignedEventJson => "invalid_unsigned_event_json",
            Self::InvalidUnsignedEvent => "invalid_unsigned_event",
            Self::MissingEventId => "missing_event_id",
            Self::MissingPubkey => "missing_pubkey",
            Self::MissingContent => "missing_content",
            Self::MissingSignature => "missing_signature",
            Self::ContentTooLarge => "content_too_large",
            Self::TooManyTags => "too_many_tags",
            Self::TooManyTagFields => "too_many_tag_fields",
            Self::TagValueTooLarge => "tag_value_too_large",
            Self::SignerPubkeyMismatch => "signer_pubkey_mismatch",
            Self::LocalSignerUnavailable => "local_signer_unavailable",
        }
    }
}
