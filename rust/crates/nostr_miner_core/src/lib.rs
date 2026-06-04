mod error;

use secp256k1::{PublicKey, Secp256k1, SecretKey};
use serde::Serialize;

pub use error::MinerError;

const WINDOW_SEGMENTS: usize = 4;
const WINDOW_VALUES: usize = 256;
const WORDS_PER_POINT: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretSummary {
    pub pubkey_hex: String,
    pub x_words: [u32; 8],
    pub y_words: [u32; 8],
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorWindowTable {
    pub segment_count: usize,
    pub window_size: usize,
    pub point_word_len: usize,
    pub words: Vec<u32>,
}

pub fn derive_secret_summary(secret_hex: &str) -> Result<SecretSummary, MinerError> {
    let secret_key = secret_key_from_hex(secret_hex)?;
    let secp = Secp256k1::new();
    let public_key = secret_key.public_key(&secp);
    let (x_words, y_words) = pubkey_to_words(&public_key);

    Ok(SecretSummary {
        pubkey_hex: xonly_pubkey_hex(&public_key),
        x_words,
        y_words,
    })
}

pub fn pubkey_hex_from_secret(secret_hex: &str) -> Result<String, MinerError> {
    Ok(derive_secret_summary(secret_hex)?.pubkey_hex)
}

pub fn generator_window_table() -> GeneratorWindowTable {
    let secp = Secp256k1::new();
    let mut words = Vec::with_capacity(WINDOW_SEGMENTS * WINDOW_VALUES * WORDS_PER_POINT);

    for segment in 0..WINDOW_SEGMENTS {
        for value in 0..WINDOW_VALUES {
            if value == 0 {
                words.extend_from_slice(&[0u32; WORDS_PER_POINT]);
                continue;
            }

            let scalar = (value as u64) << (segment * 8);
            let secret_key = scalar_secret_key(scalar);
            let public_key = secret_key.public_key(&secp);
            let (x_words, y_words) = pubkey_to_words(&public_key);

            words.extend_from_slice(&x_words);
            words.extend_from_slice(&y_words);
        }
    }

    GeneratorWindowTable {
        segment_count: WINDOW_SEGMENTS,
        window_size: WINDOW_VALUES,
        point_word_len: WORDS_PER_POINT,
        words,
    }
}

fn secret_key_from_hex(secret_hex: &str) -> Result<SecretKey, MinerError> {
    let bytes = secret_bytes_from_hex(secret_hex)?;
    SecretKey::from_slice(&bytes).map_err(|_| MinerError::InvalidSecretKey)
}

fn secret_bytes_from_hex(secret_hex: &str) -> Result<[u8; 32], MinerError> {
    let normalized = secret_hex
        .trim()
        .strip_prefix("0x")
        .unwrap_or(secret_hex.trim());

    if normalized.len() != 64 {
        return Err(MinerError::InvalidSecretKeyLength);
    }

    let mut bytes = [0u8; 32];
    for index in 0..32 {
        let offset = index * 2;
        let slice = &normalized[offset..offset + 2];
        bytes[index] =
            u8::from_str_radix(slice, 16).map_err(|_| MinerError::InvalidSecretKeyHex)?;
    }

    Ok(bytes)
}

fn scalar_secret_key(value: u64) -> SecretKey {
    let mut scalar_bytes = [0u8; 32];
    scalar_bytes[24..32].copy_from_slice(&value.to_be_bytes());
    SecretKey::from_slice(&scalar_bytes).expect("window scalar should be valid")
}

fn pubkey_to_words(public_key: &PublicKey) -> ([u32; 8], [u32; 8]) {
    let serialized = public_key.serialize_uncompressed();

    let mut x_words = [0u32; 8];
    let mut y_words = [0u32; 8];

    for index in 0..8 {
        let x_offset = 29usize - index * 4;
        let y_offset = 61usize - index * 4;

        x_words[index] = u32::from_be_bytes(
            serialized[x_offset..x_offset + 4]
                .try_into()
                .expect("x limb should fit"),
        );
        y_words[index] = u32::from_be_bytes(
            serialized[y_offset..y_offset + 4]
                .try_into()
                .expect("y limb should fit"),
        );
    }

    (x_words, y_words)
}

fn xonly_pubkey_hex(public_key: &PublicKey) -> String {
    let serialized = public_key.serialize();
    bytes_to_hex(&serialized[1..33])
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);

    for byte in bytes {
        use core::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }

    output
}

#[cfg(test)]
mod tests {
    use super::{WINDOW_VALUES, WORDS_PER_POINT, derive_secret_summary, generator_window_table};

    fn secret_hex(value: u64) -> String {
        format!("{value:064x}")
    }

    #[test]
    fn derives_pubkey_for_secret_one() {
        let summary = derive_secret_summary(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .expect("secret summary should succeed");

        assert_eq!(
            summary.pubkey_hex,
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
        assert_eq!(
            summary.x_words,
            [
                0x16f81798, 0x59f2815b, 0x2dce28d9, 0x029bfcdb, 0xce870b07, 0x55a06295, 0xf9dcbbac,
                0x79be667e,
            ]
        );
    }

    #[test]
    fn generator_table_starts_with_generator_point() {
        let table = generator_window_table();
        let generator_summary = derive_secret_summary(&secret_hex(1)).expect("summary should work");

        let generator_words = &table.words[WORDS_PER_POINT..WORDS_PER_POINT * 2];

        assert_eq!(table.segment_count, 4);
        assert_eq!(table.window_size, WINDOW_VALUES);
        assert_eq!(table.point_word_len, WORDS_PER_POINT);
        assert_eq!(
            generator_words[..8],
            generator_summary.x_words.as_slice()[..8]
        );
        assert_eq!(
            generator_words[8..16],
            generator_summary.y_words.as_slice()[..8]
        );
    }

    #[test]
    fn generator_table_contains_segment_shifted_points() {
        let table = generator_window_table();
        let scalar_256 = derive_secret_summary(&secret_hex(0x100)).expect("summary should work");
        let point_index = WINDOW_VALUES + 1; // segment 1, value 1
        let start = point_index * WORDS_PER_POINT;
        let point_words = &table.words[start..start + WORDS_PER_POINT];

        assert_eq!(point_words[..8], scalar_256.x_words.as_slice()[..8]);
        assert_eq!(point_words[8..16], scalar_256.y_words.as_slice()[..8]);
    }

    #[test]
    fn rejects_invalid_secret_hex() {
        assert!(derive_secret_summary("xyz").is_err());
        assert!(derive_secret_summary("00").is_err());
    }
}
