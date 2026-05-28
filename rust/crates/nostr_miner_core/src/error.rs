use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MinerError {
    #[error("secret key hex must be 64 characters")]
    InvalidSecretKeyLength,
    #[error("secret key hex contains non-hex characters")]
    InvalidSecretKeyHex,
    #[error("secret key is not a valid secp256k1 scalar")]
    InvalidSecretKey,
    #[error("failed to serialize mining payload")]
    SerializationFailed,
}

#[derive(Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

impl MinerError {
    pub fn payload_json(&self) -> String {
        let payload = ErrorPayload {
            code: self.code(),
            message: self.to_string(),
        };

        serde_json::to_string(&payload).unwrap_or_else(|_| {
            String::from(
                "{\"code\":\"serialization_failed\",\"message\":\"failed to serialize mining payload\"}",
            )
        })
    }

    fn code(&self) -> &'static str {
        match self {
            Self::InvalidSecretKeyLength => "invalid_secret_key_length",
            Self::InvalidSecretKeyHex => "invalid_secret_key_hex",
            Self::InvalidSecretKey => "invalid_secret_key",
            Self::SerializationFailed => "serialization_failed",
        }
    }
}
