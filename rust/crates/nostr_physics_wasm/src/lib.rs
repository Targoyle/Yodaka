use nostr_core::{CoreError, PhysicsBodySeed, PhysicsWorld};
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct GravityWorld {
    inner: PhysicsWorld,
}

#[wasm_bindgen]
impl GravityWorld {
    #[wasm_bindgen(constructor)]
    pub fn new(width: f32, height: f32) -> Self {
        Self {
            inner: PhysicsWorld::new(width, height),
        }
    }

    #[wasm_bindgen]
    pub fn set_bounds(&mut self, width: f32, height: f32) {
        self.inner.set_bounds(width, height);
    }

    #[wasm_bindgen]
    pub fn set_bodies(&mut self, seeds_json: &str) -> Result<(), JsValue> {
        let seeds: Vec<PhysicsBodySeed> = serde_json::from_str(seeds_json)
            .map_err(CoreError::InvalidPhysicsBodiesJson)
            .map_err(map_error)?;
        self.inner.set_bodies(seeds);
        Ok(())
    }

    #[wasm_bindgen]
    pub fn step(&mut self, dt_ms: f32) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.step(dt_ms))
            .map_err(|error| map_error(CoreError::InvalidEventJson(error)))
    }

    #[wasm_bindgen]
    pub fn pointer_down(&mut self, index: usize, x: f32, y: f32) -> bool {
        self.inner.pointer_down(index, x, y)
    }

    #[wasm_bindgen]
    pub fn pointer_move(&mut self, x: f32, y: f32) {
        self.inner.pointer_move(x, y);
    }

    #[wasm_bindgen]
    pub fn pointer_up(&mut self) {
        self.inner.pointer_up();
    }
}

fn map_error(error: CoreError) -> JsValue {
    JsValue::from_str(&error.payload_json())
}
