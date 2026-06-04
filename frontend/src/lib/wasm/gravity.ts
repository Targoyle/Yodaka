import init, { GravityWorld as WasmGravityWorld } from "@physics-wasm/nostr_physics_wasm.js";

export type GravityBodySeed = {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
};

export type GravityBodySnapshot = GravityBodySeed;

let initializePromise: ReturnType<typeof init> | null = null;

export async function initializePhysicsWasm() {
  if (!initializePromise) {
    initializePromise = init();
  }

  return initializePromise;
}

export class GravityWorld {
  private constructor(private readonly inner: WasmGravityWorld) {}

  static async create(width: number, height: number) {
    await initializePhysicsWasm();
    return new GravityWorld(new WasmGravityWorld(width, height));
  }

  setBounds(width: number, height: number) {
    this.inner.set_bounds(width, height);
  }

  setBodies(seeds: GravityBodySeed[]) {
    this.inner.set_bodies(JSON.stringify(seeds));
  }

  step(dtMs: number): GravityBodySnapshot[] {
    return JSON.parse(this.inner.step(dtMs)) as GravityBodySnapshot[];
  }

  pointerDown(index: number, x: number, y: number) {
    return this.inner.pointer_down(index, x, y);
  }

  pointerMove(x: number, y: number) {
    this.inner.pointer_move(x, y);
  }

  pointerUp() {
    this.inner.pointer_up();
  }
}
