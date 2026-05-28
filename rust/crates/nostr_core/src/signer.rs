use nostr::secp256k1::{Keypair, Message, Secp256k1, XOnlyPublicKey};
use nostr::{JsonUtil, PublicKey, SecretKey, UnsignedEvent as NostrUnsignedEvent};

use crate::CoreError;
use crate::timeline::{validate_content_limit, validate_tag_matrix};

pub struct LocalSignerSession {
    secret_key: SecretKey,
    pubkey: PublicKey,
}

impl LocalSignerSession {
    pub fn from_nsec(input: &str) -> Result<Self, CoreError> {
        let secret_key = SecretKey::parse(input.trim()).map_err(|_| CoreError::InvalidSecretKey)?;
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let pubkey = PublicKey::from(XOnlyPublicKey::from_keypair(&keypair).0);

        Ok(Self { secret_key, pubkey })
    }

    pub fn pubkey_hex(&self) -> String {
        self.pubkey.to_hex()
    }

    pub fn sign_unsigned_event(&self, unsigned_event_json: &str) -> Result<String, CoreError> {
        let secp = Secp256k1::new();
        let mut unsigned: NostrUnsignedEvent = NostrUnsignedEvent::from_json(unsigned_event_json)
            .map_err(|_| CoreError::InvalidUnsignedEventJson)?;

        validate_content_limit(&unsigned.content)?;
        let tags: Vec<Vec<String>> = unsigned
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect();
        validate_tag_matrix(&tags)?;

        if unsigned.pubkey != self.pubkey {
            return Err(CoreError::SignerPubkeyMismatch);
        }

        let event_id = unsigned.id();
        let message = Message::from_digest(event_id.to_bytes());
        let keypair = Keypair::from_secret_key(&secp, &self.secret_key);
        let signature = secp.sign_schnorr_no_aux_rand(&message, &keypair);
        let signed = unsigned
            .add_signature_with_ctx(&secp, signature)
            .map_err(|_| CoreError::InvalidUnsignedEvent)?;

        serde_json::to_string(&signed).map_err(CoreError::InvalidEventJson)
    }

    pub fn wipe(&mut self) {
        self.secret_key.non_secure_erase();
    }
}

impl Drop for LocalSignerSession {
    fn drop(&mut self) {
        self.wipe();
    }
}

pub fn login_with_nsec(secret_key: &str) -> Result<String, CoreError> {
    Ok(LocalSignerSession::from_nsec(secret_key)?.pubkey_hex())
}

pub fn sign_unsigned_event_with_nsec(
    secret_key: &str,
    unsigned_event_json: &str,
) -> Result<String, CoreError> {
    LocalSignerSession::from_nsec(secret_key)?.sign_unsigned_event(unsigned_event_json)
}

#[cfg(test)]
mod tests {
    use nostr::SecretKey;
    use nostr::nips::nip19::ToBech32;

    use crate::{build_unsigned_event, verify_event};

    use super::{LocalSignerSession, login_with_nsec, sign_unsigned_event_with_nsec};

    const TEST_SECRET_HEX: &str =
        "1111111111111111111111111111111111111111111111111111111111111111";
    const OTHER_SECRET_HEX: &str =
        "2222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn login_with_nsec_derives_hex_pubkey() {
        let nsec = SecretKey::parse(TEST_SECRET_HEX)
            .expect("secret key should parse")
            .to_bech32()
            .expect("bech32 conversion should succeed");

        let pubkey = login_with_nsec(&nsec).expect("login should derive pubkey");

        assert_eq!(
            pubkey,
            "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"
        );
    }

    #[test]
    fn sign_unsigned_event_with_nsec_returns_verified_event_json() {
        let pubkey = login_with_nsec(TEST_SECRET_HEX).expect("pubkey should derive");
        let unsigned =
            build_unsigned_event(&pubkey, "hello", "[]", 1).expect("unsigned should build");
        let signed = sign_unsigned_event_with_nsec(TEST_SECRET_HEX, &unsigned)
            .expect("unsigned event should sign");

        assert!(verify_event(&signed).expect("signed event should verify"));
        assert!(signed.contains(r#""content":"hello""#));
    }

    #[test]
    fn sign_unsigned_event_with_nsec_rejects_pubkey_mismatch() {
        let other_pubkey = login_with_nsec(OTHER_SECRET_HEX).expect("pubkey should derive");
        let unsigned = build_unsigned_event(&other_pubkey, "hello", "[]", 1)
            .expect("unsigned event should build");
        let error = sign_unsigned_event_with_nsec(TEST_SECRET_HEX, &unsigned)
            .expect_err("mismatched pubkey should fail");

        assert_eq!(
            error.payload_json(),
            r#"{"code":"signer_pubkey_mismatch","message":"unsigned event pubkey does not match signer"}"#
        );
    }

    #[test]
    fn sign_unsigned_event_with_nsec_rejects_invalid_nsec() {
        let pubkey = login_with_nsec(TEST_SECRET_HEX).expect("pubkey should derive");
        let unsigned =
            build_unsigned_event(&pubkey, "hello", "[]", 1).expect("unsigned should build");
        let error = sign_unsigned_event_with_nsec("nsec1invalid", &unsigned)
            .expect_err("invalid nsec should fail");

        assert_eq!(
            error.payload_json(),
            r#"{"code":"invalid_secret_key","message":"secret key could not be parsed"}"#
        );
    }

    #[test]
    fn local_signer_session_derives_pubkey_and_signs() {
        let session =
            LocalSignerSession::from_nsec(TEST_SECRET_HEX).expect("session should initialize");
        let pubkey = session.pubkey_hex();
        let unsigned =
            build_unsigned_event(&pubkey, "hello", "[]", 1).expect("unsigned should build");
        let signed = session
            .sign_unsigned_event(&unsigned)
            .expect("session should sign unsigned event");

        assert!(verify_event(&signed).expect("signed event should verify"));
    }
}
