import init, {
  derive_secret_summary,
  generator_window_table,
  pubkey_hex_from_secret,
} from "@miner-wasm/nostr_miner_wasm.js";

export type SecretSummary = {
  pubkeyHex: string;
  xWords: number[];
  yWords: number[];
};

export type GeneratorWindowTable = {
  segmentCount: number;
  windowSize: number;
  pointWordLen: number;
  words: number[];
};

let initializePromise: Promise<void> | null = null;

export async function initializeMinerWasm() {
  if (!initializePromise) {
    initializePromise = init();
  }

  return initializePromise;
}

export async function deriveSecretSummary(secretHex: string): Promise<SecretSummary> {
  await initializeMinerWasm();
  const json = derive_secret_summary(secretHex);
  const parsed = JSON.parse(json) as {
    pubkeyHex: string;
    xWords: number[];
    yWords: number[];
  };

  return {
    pubkeyHex: parsed.pubkeyHex,
    xWords: parsed.xWords,
    yWords: parsed.yWords,
  };
}

export async function generatorWindowTable(): Promise<GeneratorWindowTable> {
  await initializeMinerWasm();
  const json = generator_window_table();
  const parsed = JSON.parse(json) as {
    segmentCount: number;
    windowSize: number;
    pointWordLen: number;
    words: number[];
  };

  return {
    segmentCount: parsed.segmentCount,
    windowSize: parsed.windowSize,
    pointWordLen: parsed.pointWordLen,
    words: parsed.words,
  };
}

export async function pubkeyHexFromSecret(secretHex: string): Promise<string> {
  await initializeMinerWasm();
  return pubkey_hex_from_secret(secretHex);
}
