use nostr_miner_core::{
    GeneratorWindowTable, MinerError, SecretSummary, derive_secret_summary as derive_summary_core,
    generator_window_table as generator_window_table_core,
    pubkey_hex_from_secret as pubkey_hex_from_secret_core,
};
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn derive_secret_summary(secret_hex: &str) -> Result<String, JsValue> {
    let summary = derive_summary_core(secret_hex).map_err(map_error)?;
    to_json(&summary)
}

#[wasm_bindgen]
pub fn generator_window_table() -> Result<String, JsValue> {
    let table = generator_window_table_core();
    to_json(&table)
}

#[wasm_bindgen]
pub fn pubkey_hex_from_secret(secret_hex: &str) -> Result<String, JsValue> {
    pubkey_hex_from_secret_core(secret_hex).map_err(map_error)
}

fn to_json(value: &impl serde::Serialize) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|_| map_error(MinerError::SerializationFailed))
}

fn map_error(error: MinerError) -> JsValue {
    JsValue::from_str(&error.payload_json())
}

#[allow(dead_code)]
fn _assert_types(summary: &SecretSummary, table: &GeneratorWindowTable) -> usize {
    summary.x_words.len() + summary.y_words.len() + table.words.len()
}
