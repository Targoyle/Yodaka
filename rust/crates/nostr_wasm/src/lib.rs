use std::cell::RefCell;

use nostr_core::{
    CoreError, LocalSignerSession, Timeline, build_unsigned_event, presign_unsigned_event,
    verify_event,
    verify_profile_summary_event,
};
use wasm_bindgen::prelude::*;

thread_local! {
  static TIMELINE: RefCell<Timeline> = RefCell::new(Timeline::new());
  static LOCAL_SIGNER: RefCell<Option<LocalSignerSession>> = const { RefCell::new(None) };
}

fn replace_local_signer(next: Option<LocalSignerSession>) {
    LOCAL_SIGNER.with(|signer| {
        let mut signer = signer.borrow_mut();

        if let Some(mut current) = signer.take() {
            current.wipe();
        }

        *signer = next;
    });
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn build_unsigned_event_js(
    pubkey: &str,
    content: &str,
    tags_json: &str,
    kind: u32,
) -> Result<String, JsValue> {
    build_unsigned_event(pubkey, content, tags_json, kind).map_err(map_error)
}

#[wasm_bindgen(js_name = build_unsigned_event)]
pub fn build_unsigned_event_export(
    pubkey: &str,
    content: &str,
    tags_json: &str,
    kind: u32,
) -> Result<String, JsValue> {
    build_unsigned_event_js(pubkey, content, tags_json, kind)
}

#[wasm_bindgen]
pub fn presign_unsigned_event_js(unsigned_event_json: &str) -> Result<String, JsValue> {
    presign_unsigned_event(unsigned_event_json).map_err(map_error)
}

#[wasm_bindgen(js_name = presign_unsigned_event)]
pub fn presign_unsigned_event_export(
    unsigned_event_json: &str,
) -> Result<String, JsValue> {
    presign_unsigned_event_js(unsigned_event_json)
}

#[wasm_bindgen]
pub fn login_with_nsec_js(nsec: &str) -> Result<String, JsValue> {
    let session = LocalSignerSession::from_nsec(nsec).map_err(map_error)?;
    let pubkey = session.pubkey_hex();
    replace_local_signer(Some(session));
    Ok(pubkey)
}

#[wasm_bindgen(js_name = login_with_nsec)]
pub fn login_with_nsec_export(nsec: &str) -> Result<String, JsValue> {
    login_with_nsec_js(nsec)
}

#[wasm_bindgen]
pub fn has_local_signer() -> bool {
    LOCAL_SIGNER.with(|signer| signer.borrow().is_some())
}

#[wasm_bindgen]
pub fn local_signer_pubkey() -> Option<String> {
    LOCAL_SIGNER.with(|signer| signer.borrow().as_ref().map(LocalSignerSession::pubkey_hex))
}

#[wasm_bindgen]
pub fn sign_unsigned_event_with_local_signer(unsigned_event_json: &str) -> Result<String, JsValue> {
    LOCAL_SIGNER.with(|signer| {
        let signer = signer.borrow();
        let session = signer
            .as_ref()
            .ok_or_else(|| map_error(CoreError::LocalSignerUnavailable))?;

        session
            .sign_unsigned_event(unsigned_event_json)
            .map_err(map_error)
    })
}

#[wasm_bindgen]
pub fn logout_local_signer() {
    replace_local_signer(None);
}

#[wasm_bindgen]
pub fn verify_and_insert(event_json: &str) -> Result<bool, JsValue> {
    TIMELINE.with(|timeline| {
        timeline
            .borrow_mut()
            .verify_and_insert(event_json)
            .map_err(map_error)
    })
}

#[wasm_bindgen]
pub fn verify_event_js(event_json: &str) -> Result<bool, JsValue> {
    verify_event(event_json).map_err(map_error)
}

#[wasm_bindgen(js_name = verify_event)]
pub fn verify_event_export(event_json: &str) -> Result<bool, JsValue> {
    verify_event_js(event_json)
}

#[wasm_bindgen]
pub fn verify_profile_summary_event_js(event_json: &str) -> Result<String, JsValue> {
    serde_json::to_string(&verify_profile_summary_event(event_json).map_err(map_error)?)
        .map_err(|error| map_error(CoreError::InvalidEventJson(error)))
}

#[wasm_bindgen(js_name = verify_profile_summary_event)]
pub fn verify_profile_summary_event_export(event_json: &str) -> Result<String, JsValue> {
    verify_profile_summary_event_js(event_json)
}

#[wasm_bindgen]
pub fn list_timeline(limit: u32, until: Option<u64>) -> Result<String, JsValue> {
    TIMELINE.with(|timeline| {
        let timeline = timeline.borrow();
        serde_json::to_string(&timeline.list_timeline(limit, until))
            .map_err(|error| map_error(CoreError::InvalidEventJson(error)))
    })
}

#[wasm_bindgen]
pub fn since_hint() -> Result<String, JsValue> {
    TIMELINE.with(|timeline| {
        let timeline = timeline.borrow();
        serde_json::to_string(&timeline.since_hint())
            .map_err(|error| map_error(CoreError::InvalidEventJson(error)))
    })
}

#[wasm_bindgen]
pub fn reset_timeline() {
    TIMELINE.with(|timeline| timeline.borrow_mut().reset());
}

fn map_error(error: CoreError) -> JsValue {
    JsValue::from_str(&error.payload_json())
}
