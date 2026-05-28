import { encodeNpub, encodeNsec } from "../nostr/nip19";
import {
  buildMiningPatternConfig,
  matchesNpubAffixes,
  normalizeMiningRequest,
  type MiningPatternConfig,
} from "./affix";
import { validateMinerBatchSize } from "./batchSize";
import shaderCode from "./webgpuMiner.wgsl?raw";
import {
  deriveSecretSummary,
  generatorWindowTable,
  pubkeyHexFromSecret,
} from "./wasm";

const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const WORKGROUP_SIZE = 64;
const CANDIDATE_CAPACITY = 1024;
const PROGRESS_INTERVAL_MS = 250;
const CONFIG_WORD_COUNT = 9;
const BASE_POINT_WORD_COUNT = 16;
const DEBUG_WORD_COUNT = 8;
const WEBGPU_ADAPTER_ATTEMPT_TIMEOUT_MS = 3_000;
const WEBGPU_ADAPTER_RECOVERY_DELAY_MS = 2_500;
const WEBGPU_INIT_STEP_TIMEOUT_MS = 8_000;
const WEBGPU_PIPELINE_HARD_TIMEOUT_MS = 45_000;
const WEBGPU_SELF_TEST_TIMEOUT_MS = 4_000;
const SELF_TEST_SECRET_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";

type MiningEngine = "webgpu" | "cpu";
type MiningDebugLevel = "info" | "warn" | "error";

export type MiningProgress = {
  engine: MiningEngine;
  keysProcessed: number;
  batchesProcessed: number;
  candidatesChecked: number;
  elapsedMs: number;
  keysPerSecond: number;
};

export type MiningMatch = {
  secretHex: string;
  pubkeyHex: string;
  npub: string;
  nsec: string;
};

export type MiningDebugLog = {
  timestampMs: number;
  level: MiningDebugLevel;
  event: string;
  message: string;
  context?: Record<string, unknown>;
};

type BasePointWords = {
  xWords: number[];
  yWords: number[];
};

type BatchDebugSnapshot = {
  xMsw: number;
  prefixEnabled: boolean;
  prefixPattern: number;
  prefixMask: number;
  prefixMatch: boolean;
  suffixMatch: boolean;
  combinedMatch: boolean;
  stage: number;
};

type BatchRunResult = {
  candidateIndexes: number[];
  debugSnapshot?: BatchDebugSnapshot;
  diagnostics: string[];
};

type RuntimeInitializationStatus = "idle" | "pending" | "ready" | "failed";

type AdapterRequestOption = {
  label: "high-performance" | "default" | "low-power";
  powerPreference?: "high-performance" | "low-power";
};

type AdapterAcquisitionResult = {
  adapter: any | null;
  attemptCount: number;
  selectedAttempt: number | null;
  selectedPreference: AdapterRequestOption["label"] | null;
  totalElapsedMs: number;
  diagnostics: string[];
};

export type WebGpuRuntimeSnapshot = {
  supported: boolean;
  status: RuntimeInitializationStatus | "unavailable";
  failureMessage: string | null;
};

type DebugLogEmitter = (args: {
  level: MiningDebugLevel;
  event: string;
  message: string;
  context?: Record<string, unknown>;
}) => void;

type DeviceDiagnosticsAttachment = {
  suppress: () => void;
};

class RuntimeInitializationAbortedError extends Error {
  constructor() {
    super("WebGPU 初期化は破棄されました");
    this.name = "RuntimeInitializationAbortedError";
  }
}

let runtimePromise: Promise<WebGpuBatchRunner> | null = null;
let runtimeReady: WebGpuBatchRunner | null = null;
let runtimeInitializationStatus: RuntimeInitializationStatus = "idle";
let runtimeFailureMessage: string | null = null;
let runtimeDebugEmitter: DebugLogEmitter | null = null;
let runtimeToken = 0;

export function isWebGpuSupported() {
  return (
    typeof navigator !== "undefined"
    && Boolean((navigator as Navigator & { gpu?: unknown }).gpu)
  );
}

export function getWebGpuRuntimeSnapshot(): WebGpuRuntimeSnapshot {
  if (!isWebGpuSupported()) {
    return {
      supported: false,
      status: "unavailable",
      failureMessage: null,
    };
  }

  return {
    supported: true,
    status: runtimeInitializationStatus,
    failureMessage: runtimeFailureMessage,
  };
}

export function prewarmWebGpuMiner() {
  if (!isWebGpuSupported()) {
    return;
  }

  beginRuntimeInitialization({
    skipSelfTest: true,
  });
}

export function clearWebGpuMinerDebugEmitter() {
  runtimeDebugEmitter = null;
}

export function disposeWebGpuMinerRuntime() {
  resetRuntime();
}

export class NostrKeyMiner {
  private readonly abortController = new AbortController();

  stop() {
    this.abortController.abort();
  }

  isStopped() {
    return this.abortController.signal.aborted;
  }

  async mine(args: {
    prefix: string;
    suffix: string;
    batchSize: number;
    onProgress?: (progress: MiningProgress) => void;
    onDebugLog?: (entry: MiningDebugLog) => void;
  }): Promise<MiningMatch | null> {
    const request = normalizeMiningRequest({
      prefix: args.prefix,
      suffix: args.suffix,
    });
    const batchSize = validateMinerBatchSize(args.batchSize);
    const patterns = buildMiningPatternConfig(request);
    const startedAt = performance.now();
    let lastProgressAt = 0;
    let hasEmittedProgress = false;
    let keysProcessed = 0;
    let batchesProcessed = 0;
    let candidatesChecked = 0;
    let engine: MiningEngine = "cpu";
    let runtime: WebGpuBatchRunner | null = null;
    let runtimeFailureLogged = false;
    const emitDebugLog = (argsForLog: {
      level: MiningDebugLevel;
      event: string;
      message: string;
      context?: Record<string, unknown>;
    }) => {
      args.onDebugLog?.({
        timestampMs: Date.now(),
        level: argsForLog.level,
        event: argsForLog.event,
        message: argsForLog.message,
        context: argsForLog.context,
      });
    };

    emitDebugLog({
      level: "info",
      event: "mine.start",
      message: "探索を開始しました",
      context: {
        prefix: request.prefix || null,
        suffix: request.suffix || null,
        batchSize,
      },
    });

    runtime = peekRuntime();

    if (runtime) {
      await runtime.ensureHealthy({
        emitDebugLog,
      });
      engine = "webgpu";
      emitDebugLog({
        level: "info",
        event: "engine.selected",
        message: "WebGPU を使用します",
      });

      if (runtime.getSelfTestWarning()) {
        emitDebugLog({
          level: "warn",
          event: "webgpu.self_test",
          message: runtime.getSelfTestWarning() ?? "",
        });
      }
    } else if (!isWebGpuSupported()) {
      emitDebugLog({
        level: "warn",
        event: "engine.cpu_only",
        message: "この環境では WebGPU が使えないため、CPU で探索を開始します",
      });
    } else {
      const previousFailureMessage = peekRuntimeFailure();

      beginRuntimeInitialization({
        emitDebugLog,
      });
      runtimeFailureLogged = false;
      emitDebugLog({
        level: "warn",
        event: "engine.defer_to_cpu",
        message: "WebGPU 初期化を継続しつつ、先に CPU で探索を開始します",
        context: previousFailureMessage
          ? {
              reason: `前回の WebGPU 初期化失敗後に再試行しています: ${previousFailureMessage}`,
            }
          : {
              reason: "WebGPU 初期化中です",
            },
      });
    }

    const emitProgress = async (force = false) => {
      const now = performance.now();

      if (!args.onProgress) {
        return;
      }

      if (!force && hasEmittedProgress && now - lastProgressAt < PROGRESS_INTERVAL_MS) {
        return;
      }

      const elapsedMs = now - startedAt;
      args.onProgress?.({
        engine,
        keysProcessed,
        batchesProcessed,
        candidatesChecked,
        elapsedMs,
        keysPerSecond: elapsedMs <= 0 ? 0 : (keysProcessed / elapsedMs) * 1000,
      });
      hasEmittedProgress = true;
      lastProgressAt = now;
      await yieldToBrowser();
    };

    while (!this.abortController.signal.aborted) {
      if (!runtime) {
        const warmedUpRuntime = peekRuntime();

        if (warmedUpRuntime) {
          await warmedUpRuntime.ensureHealthy({
            emitDebugLog,
          });
          runtime = warmedUpRuntime;
          engine = "webgpu";
          runtimeFailureLogged = false;
          emitDebugLog({
            level: "info",
            event: "engine.selected_background",
            message: "バックグラウンド初期化が完了したため WebGPU に切り替えました",
          });

          if (runtime.getSelfTestWarning()) {
            emitDebugLog({
              level: "warn",
              event: "webgpu.self_test",
              message: runtime.getSelfTestWarning() ?? "",
            });
          }
          continue;
        }

        const backgroundFailureMessage = peekRuntimeFailure();

        if (backgroundFailureMessage && !runtimeFailureLogged) {
          runtimeFailureLogged = true;
          emitDebugLog({
            level: "warn",
            event: "engine.init.failed_background",
            message: "バックグラウンドで継続していた WebGPU 初期化が失敗したため、CPU で探索を継続します",
            context: {
              reason: backgroundFailureMessage,
            },
          });
        }
      }

      const baseSecretValue = createRandomBaseSecret(batchSize);

      if (runtime) {
        try {
          const baseSecretHex = bigintToSecretHex(baseSecretValue);
          const summary = await deriveSecretSummary(baseSecretHex);
          const batchResult = await runtime.runBatch({
            batchSize,
            patterns,
            basePoint: {
              xWords: summary.xWords,
              yWords: summary.yWords,
            },
          });
          const candidateIndexes = batchResult.candidateIndexes;

          keysProcessed += batchSize;
          batchesProcessed += 1;

          if (shouldEmitBatchDebugLog(batchesProcessed, candidateIndexes.length)) {
            emitDebugLog({
              level: "info",
              event: "webgpu.batch",
              message: "WebGPU batch を処理しました",
              context: {
                batch: batchesProcessed,
                batchSize,
                candidateCount: candidateIndexes.length,
                sampleCandidateIndexes: candidateIndexes.slice(0, 8),
                keysProcessed,
                candidatesChecked,
              },
            });
          }

          await emitProgress();

          for (const candidateIndex of candidateIndexes) {
            const candidateSecretHex = bigintToSecretHex(
              baseSecretValue + BigInt(candidateIndex),
            );
            const match = await buildMatch(candidateSecretHex, request);
            candidatesChecked += 1;
            await emitProgress();

            if (!match) {
              continue;
            }

            emitDebugLog({
              level: "info",
              event: "mine.match",
              message: "一致する鍵を見つけました",
              context: {
                engine,
                batch: batchesProcessed,
                candidateIndex,
                keysProcessed,
                candidatesChecked,
                npubPrefix: match.npub.slice(0, 18),
              },
            });
            await emitProgress(true);
            return match;
          }

          await emitProgress();
          continue;
        } catch (error) {
          console.warn("WebGPU miner batch failed, falling back to CPU", error);
          const failureMessage = getErrorMessage(error);

          emitDebugLog({
            level: "error",
            event: "webgpu.batch_error",
            message: "WebGPU batch が失敗したため CPU fallback に切り替えました",
            context: {
              batch: batchesProcessed + 1,
              reason: failureMessage,
            },
          });
          markRuntimeFailed(failureMessage);
          runtime = null;
          engine = "cpu";
        }
      }

      batchesProcessed += 1;

      for (let candidateIndex = 0; candidateIndex < batchSize; candidateIndex += 1) {
        if (this.abortController.signal.aborted) {
          return null;
        }

        const candidateSecretHex = bigintToSecretHex(
          baseSecretValue + BigInt(candidateIndex),
        );
        const match = await buildMatch(candidateSecretHex, request);
        keysProcessed += 1;
        candidatesChecked += 1;
        await emitProgress();

        if (match) {
          emitDebugLog({
            level: "info",
            event: "mine.match",
            message: "一致する鍵を見つけました",
            context: {
              engine,
              batch: batchesProcessed,
              candidateIndex,
              keysProcessed,
              candidatesChecked,
              npubPrefix: match.npub.slice(0, 18),
            },
          });
          await emitProgress(true);
          return match;
        }
      }

      if (shouldEmitBatchDebugLog(batchesProcessed, 0)) {
        emitDebugLog({
          level: "info",
          event: "cpu.batch",
          message: "CPU batch を処理しました",
          context: {
            batch: batchesProcessed,
            batchSize,
            keysProcessed,
            candidatesChecked,
          },
        });
      }
    }

    emitDebugLog({
      level: "info",
      event: "mine.stop",
      message: "探索を停止しました",
      context: {
        engine,
        keysProcessed,
        batchesProcessed,
        candidatesChecked,
      },
    });
    return null;
  }
}

function ensureRuntimePromise(emitDebugLog?: DebugLogEmitter) {
  return ensureRuntimePromiseWithOptions({
    emitDebugLog,
  });
}

function ensureRuntimePromiseWithOptions(args?: {
  emitDebugLog?: DebugLogEmitter;
  skipSelfTest?: boolean;
}) {
  if (args?.emitDebugLog) {
    runtimeDebugEmitter = args.emitDebugLog;
  }

  if (!runtimePromise) {
    const token = ++runtimeToken;
    runtimeInitializationStatus = "pending";
    runtimeFailureMessage = null;
    runtimePromise = WebGpuBatchRunner.create({
      emitDebugLog: emitRuntimeDebugLog,
      runtimeTokenSnapshot: token,
      skipSelfTest: args?.skipSelfTest ?? false,
    })
      .then((runtime) => {
        if (token !== runtimeToken) {
          runtime.dispose();
          return runtime;
        }

        runtimeReady = runtime;
        runtimeInitializationStatus = "ready";
        runtimeFailureMessage = null;
        return runtime;
      })
      .catch((error) => {
        if (token === runtimeToken) {
          markRuntimeFailed(getErrorMessage(error));
        }
        throw error;
      });
  }

  return runtimePromise;
}

function beginRuntimeInitialization(args?: {
  emitDebugLog?: DebugLogEmitter;
  skipSelfTest?: boolean;
}) {
  void ensureRuntimePromiseWithOptions(args).catch((error) => {
    if (isRuntimeInitializationAbortedError(error)) {
      return;
    }

    console.warn("WebGPU miner background initialization failed", error);
  });
}

function peekRuntime() {
  return runtimeReady;
}

function peekRuntimeFailure() {
  if (runtimeInitializationStatus !== "failed") {
    return null;
  }

  return runtimeFailureMessage;
}

function resetRuntime() {
  releaseCurrentRuntime({
    nextStatus: "idle",
    nextFailureMessage: null,
  });
}

function markRuntimeFailed(message: string) {
  releaseCurrentRuntime({
    nextStatus: "failed",
    nextFailureMessage: message,
  });
}

function releaseCurrentRuntime(args: {
  nextStatus: RuntimeInitializationStatus;
  nextFailureMessage: string | null;
}) {
  const stalePromise = runtimePromise;
  const staleReady = runtimeReady;

  runtimeToken += 1;
  runtimePromise = null;
  runtimeReady = null;
  runtimeInitializationStatus = args.nextStatus;
  runtimeFailureMessage = args.nextFailureMessage;
  staleReady?.dispose();

  if (stalePromise) {
    void stalePromise.then((runner) => {
      runner.dispose();
    }).catch(() => undefined);
  }
}

function emitRuntimeDebugLog(args: Parameters<DebugLogEmitter>[0]) {
  runtimeDebugEmitter?.(args);
}

function throwIfRuntimeInitializationStale(runtimeTokenSnapshot?: number) {
  if (
    runtimeTokenSnapshot !== undefined
    && runtimeTokenSnapshot !== runtimeToken
  ) {
    throw new RuntimeInitializationAbortedError();
  }
}

function isRuntimeInitializationAbortedError(error: unknown) {
  return error instanceof RuntimeInitializationAbortedError;
}

function rethrowRuntimeInitializationAbortedError(error: unknown) {
  if (isRuntimeInitializationAbortedError(error)) {
    throw error;
  }
}

class WebGpuBatchRunner {
  private readonly device: any;
  private readonly pipeline: any;
  private readonly bindGroup: any;
  private readonly configBuffer: any;
  private readonly basePointBuffer: any;
  private readonly windowTableBuffer: any;
  private readonly candidateBuffer: any;
  private readonly debugBuffer: any;
  private readonly candidateReset: Uint32Array;
  private readonly candidateBufferSize: number;
  private readonly debugReset: Uint32Array;
  private readonly debugBufferSize: number;
  private readonly deviceDiagnosticsAttachment: DeviceDiagnosticsAttachment | null;
  private readonly diagnostics: string[] = [];
  private selfTestWarning: string | null = null;
  private selfTestCompleted = false;
  private selfTestPromise: Promise<void> | null = null;
  private activeBatchCount = 0;
  private disposeRequested = false;
  private disposed = false;

  private constructor(args: {
    device: any;
    pipeline: any;
    bindGroup: any;
    configBuffer: any;
    basePointBuffer: any;
    windowTableBuffer: any;
    candidateBuffer: any;
    debugBuffer: any;
    candidateBufferSize: number;
    debugBufferSize: number;
    deviceDiagnosticsAttachment: DeviceDiagnosticsAttachment | null;
  }) {
    this.device = args.device;
    this.pipeline = args.pipeline;
    this.bindGroup = args.bindGroup;
    this.configBuffer = args.configBuffer;
    this.basePointBuffer = args.basePointBuffer;
    this.windowTableBuffer = args.windowTableBuffer;
    this.candidateBuffer = args.candidateBuffer;
    this.debugBuffer = args.debugBuffer;
    this.candidateBufferSize = args.candidateBufferSize;
    this.debugBufferSize = args.debugBufferSize;
    this.candidateReset = new Uint32Array(1 + CANDIDATE_CAPACITY);
    this.debugReset = new Uint32Array(DEBUG_WORD_COUNT);
    this.deviceDiagnosticsAttachment = args.deviceDiagnosticsAttachment;
  }

  static async create(args?: {
    emitDebugLog?: DebugLogEmitter;
    runtimeTokenSnapshot?: number;
    skipSelfTest?: boolean;
  }) {
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    const emitDebugLog = args?.emitDebugLog ?? (() => undefined);
    const initStartedAt = performance.now();
    let device: any = null;
    let deviceDiagnosticsAttachment: DeviceDiagnosticsAttachment | null = null;
    const createdBuffers: any[] = [];
    const trackBuffer = (buffer: any) => {
      createdBuffers.push(buffer);
      return buffer;
    };

    if (!gpu) {
      throw new Error("このブラウザでは WebGPU が使えません");
    }

    emitDebugLog({
      level: "info",
      event: "engine.init.request_adapter",
      message: "WebGPU adapter を取得しています",
    });
    const adapterResult = await requestAdapterWithRecovery({
      gpu,
      emitDebugLog,
      runtimeTokenSnapshot: args?.runtimeTokenSnapshot,
    });
    throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);
    const adapter: any = adapterResult.adapter;

    if (!adapter) {
      throw new Error(
        buildDiagnosticErrorMessage(
          "WebGPU adapter を取得できませんでした",
          "すべての requestAdapter() 試行で adapter を取得できませんでした",
          adapterResult.diagnostics,
        ),
      );
    }

    if (adapterResult.selectedAttempt !== null && adapterResult.selectedAttempt > 1) {
      emitDebugLog({
        level: "info",
        event: "engine.init.request_adapter_selected",
        message: "WebGPU adapter を代替設定で取得しました",
        context: {
          attempt: adapterResult.selectedAttempt,
          powerPreference: adapterResult.selectedPreference,
          elapsedMs: adapterResult.totalElapsedMs,
        },
      });
    }

    emitDebugLog({
      level: "info",
      event: "engine.init.request_device",
      message: "WebGPU device を取得しています",
    });
    try {
      device = await withTimeout<any>(
        adapter.requestDevice(),
        WEBGPU_INIT_STEP_TIMEOUT_MS,
        "WebGPU device の取得がタイムアウトしました",
      );
      throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);
      const usage = (globalThis as any).GPUBufferUsage;

      if (!usage) {
        throw new Error("GPUBufferUsage が見つかりません");
      }

      const diagnostics: string[] = [];
      deviceDiagnosticsAttachment = attachDeviceDiagnostics(device, diagnostics, {
        shouldReport: () => args?.runtimeTokenSnapshot === runtimeToken,
      });
      emitDebugLog({
        level: "info",
        event: "engine.init.create_shader_module",
        message: "WebGPU shader module を作成しています",
      });
      const shaderModule = device.createShaderModule({
        code: shaderCode,
      });
      diagnostics.push(...(await collectShaderCompilationDiagnostics(shaderModule)));
      throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);

      let pipeline: any;
      const pipelineDescriptor = {
        layout: "auto",
        compute: {
          module: shaderModule,
          entryPoint: "mine_batch",
        },
      };
      const pipelineStartedAt = performance.now();

      try {
        emitDebugLog({
          level: "info",
          event: "engine.init.create_pipeline",
          message: "WebGPU compute pipeline を作成しています",
        });
        pipeline = await createComputePipelineAsyncWithTimeout({
          device,
          descriptor: pipelineDescriptor,
        });
        throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);
        const compileMs = roundDurationMs(performance.now() - pipelineStartedAt);
        diagnostics.push(`pipeline.compile_ms:${compileMs}`);
        emitDebugLog({
          level: "info",
          event: "engine.init.create_pipeline_done",
          message: "WebGPU compute pipeline の作成が完了しました",
          context: {
            compileMs,
          },
        });
      } catch (error) {
        rethrowRuntimeInitializationAbortedError(error);
        diagnostics.push(
          `pipeline.compile_error_after_ms:${roundDurationMs(performance.now() - pipelineStartedAt)}`,
        );
        throw new Error(
          buildDiagnosticErrorMessage(
            "WebGPU compute pipeline の作成に失敗しました",
            error,
            diagnostics,
          ),
        );
      }

      emitDebugLog({
        level: "info",
        event: "engine.init.prepare_table",
        message: "ジェネレータテーブルを準備しています",
      });
      throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);
      const table = await withTimeout<any>(
        generatorWindowTable(),
        WEBGPU_INIT_STEP_TIMEOUT_MS,
        "ジェネレータテーブルの準備がタイムアウトしました",
      );
      throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);
      const tableWords = Uint32Array.from(table.words);
      const configBuffer = trackBuffer(device.createBuffer({
        size: CONFIG_WORD_COUNT * Uint32Array.BYTES_PER_ELEMENT,
        usage: usage.STORAGE | usage.COPY_DST,
      }));
      const basePointBuffer = trackBuffer(device.createBuffer({
        size: BASE_POINT_WORD_COUNT * Uint32Array.BYTES_PER_ELEMENT,
        usage: usage.STORAGE | usage.COPY_DST,
      }));
      const windowTableBuffer = trackBuffer(device.createBuffer({
        size: tableWords.byteLength,
        usage: usage.STORAGE | usage.COPY_DST,
      }));
      const candidateBufferSize =
        (1 + CANDIDATE_CAPACITY) * Uint32Array.BYTES_PER_ELEMENT;
      const candidateBuffer = trackBuffer(device.createBuffer({
        size: candidateBufferSize,
        usage: usage.STORAGE | usage.COPY_DST | usage.COPY_SRC,
      }));
      const debugBufferSize = DEBUG_WORD_COUNT * Uint32Array.BYTES_PER_ELEMENT;
      const debugBuffer = trackBuffer(device.createBuffer({
        size: debugBufferSize,
        usage: usage.STORAGE | usage.COPY_DST | usage.COPY_SRC,
      }));

      device.queue.writeBuffer(windowTableBuffer, 0, tableWords);

      let bindGroup: any;

      try {
        await pushErrorScopes(device);
        emitDebugLog({
          level: "info",
          event: "engine.init.create_bind_group",
          message: "WebGPU bind group を作成しています",
        });
        bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: { buffer: configBuffer },
            },
            {
              binding: 1,
              resource: { buffer: basePointBuffer },
            },
            {
              binding: 2,
              resource: { buffer: windowTableBuffer },
            },
            {
              binding: 3,
              resource: { buffer: candidateBuffer },
            },
            {
              binding: 4,
              resource: { buffer: debugBuffer },
            },
          ],
        });
        diagnostics.push(...(await popErrorScopes(device, "createBindGroup")));
        throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);
      } catch (error) {
        diagnostics.push(...(await popErrorScopes(device, "createBindGroup")));
        rethrowRuntimeInitializationAbortedError(error);
        throw new Error(
          buildDiagnosticErrorMessage(
            "WebGPU bind group の作成に失敗しました",
            error,
            diagnostics,
          ),
        );
      }

      const runner = new WebGpuBatchRunner({
        device,
        pipeline,
        bindGroup,
        configBuffer,
        basePointBuffer,
        windowTableBuffer,
        candidateBuffer,
        debugBuffer,
        candidateBufferSize,
        debugBufferSize,
        deviceDiagnosticsAttachment,
      });
      runner.pushDiagnostics(diagnostics);
      createdBuffers.length = 0;

      if (!args?.skipSelfTest) {
        await runner.ensureHealthy({
          emitDebugLog,
        });
      }
      throwIfRuntimeInitializationStale(args?.runtimeTokenSnapshot);

      emitDebugLog({
        level: "info",
        event: "engine.init.ready",
        message: "WebGPU 初期化が完了しました",
        context: {
          totalInitMs: roundDurationMs(performance.now() - initStartedAt),
        },
      });

      return runner;
    } catch (error) {
      deviceDiagnosticsAttachment?.suppress();

      for (const buffer of createdBuffers) {
        safeDestroyBuffer(buffer);
      }

      safeDestroyDevice(device);
      throw error;
    }
  }

  async runBatch(args: {
    batchSize: number;
    patterns: MiningPatternConfig;
    basePoint: BasePointWords;
    captureDebug?: boolean;
  }): Promise<BatchRunResult> {
    if (this.disposed || this.disposeRequested) {
      throw new Error("WebGPU runtime は破棄されています");
    }

    const usage = (globalThis as any).GPUMapMode;

    if (!usage) {
      throw new Error("GPUMapMode が見つかりません");
    }

    const configWords = new Uint32Array([
      args.batchSize >>> 0,
      args.patterns.prefixEnabled ? 1 : 0,
      args.patterns.prefixPattern32 >>> 0,
      args.patterns.prefixMask32 >>> 0,
      args.patterns.suffixEnabled ? 1 : 0,
      args.patterns.suffixPatternHi >>> 0,
      args.patterns.suffixPatternLo >>> 0,
      args.patterns.suffixMaskHi >>> 0,
      args.patterns.suffixMaskLo >>> 0,
    ]);
    const basePointWords = new Uint32Array([
      ...args.basePoint.xWords,
      ...args.basePoint.yWords,
    ]);

    this.device.queue.writeBuffer(this.configBuffer, 0, configWords);
    this.device.queue.writeBuffer(this.basePointBuffer, 0, basePointWords);
    this.device.queue.writeBuffer(this.candidateBuffer, 0, this.candidateReset);

    if (args.captureDebug) {
      this.device.queue.writeBuffer(this.debugBuffer, 0, this.debugReset);
    }

    const usageFlags = (globalThis as any).GPUBufferUsage;

    if (!usageFlags) {
      throw new Error("GPUBufferUsage が見つかりません");
    }

    this.activeBatchCount += 1;
    let candidateReadbackBuffer: any = null;
    let debugReadbackBuffer: any = null;
    let errorScopesPushed = false;

    try {
      candidateReadbackBuffer = this.device.createBuffer({
        size: this.candidateBufferSize,
        usage: usageFlags.COPY_DST | usageFlags.MAP_READ,
      });
      debugReadbackBuffer = args.captureDebug
        ? this.device.createBuffer({
            size: this.debugBufferSize,
            usage: usageFlags.COPY_DST | usageFlags.MAP_READ,
          })
        : null;

      await pushErrorScopes(this.device);
      errorScopesPushed = true;
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(args.batchSize / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(
        this.candidateBuffer,
        0,
        candidateReadbackBuffer,
        0,
        this.candidateBufferSize,
      );

      if (args.captureDebug && debugReadbackBuffer) {
        encoder.copyBufferToBuffer(
          this.debugBuffer,
          0,
          debugReadbackBuffer,
          0,
          this.debugBufferSize,
        );
      }

      this.device.queue.submit([encoder.finish()]);

      if (typeof this.device.queue.onSubmittedWorkDone === "function") {
        await this.device.queue.onSubmittedWorkDone();
      }
      const diagnostics = [
        ...this.drainDiagnostics(),
        ...(await popErrorScopes(this.device, "runBatch")),
      ];
      errorScopesPushed = false;

      await candidateReadbackBuffer.mapAsync(usage.READ);
      const candidateSnapshot = readMappedUint32Buffer(candidateReadbackBuffer);
      const count = Math.min(candidateSnapshot[0] ?? 0, CANDIDATE_CAPACITY);
      let debugSnapshot: BatchDebugSnapshot | undefined;

      if (args.captureDebug && debugReadbackBuffer) {
        await debugReadbackBuffer.mapAsync(usage.READ);
        const debugWords = readMappedUint32Buffer(debugReadbackBuffer);
        debugSnapshot = parseBatchDebugSnapshot(debugWords);
      }

      return {
        candidateIndexes: Array.from(candidateSnapshot.slice(1, 1 + count)),
        debugSnapshot,
        diagnostics,
      };
    } catch (error) {
      if (errorScopesPushed) {
        this.pushDiagnostics(await popErrorScopes(this.device, "runBatch"));
      }

      throw error;
    } finally {
      this.activeBatchCount = Math.max(0, this.activeBatchCount - 1);
      safeDestroyBuffer(candidateReadbackBuffer);
      safeDestroyBuffer(debugReadbackBuffer);
      this.maybeDispose();
    }
  }

  async ensureHealthy(args?: {
    emitDebugLog?: DebugLogEmitter;
  }) {
    if (this.selfTestCompleted) {
      return;
    }

    if (this.disposed || this.disposeRequested) {
      throw new Error("WebGPU runtime は破棄されています");
    }

    if (!this.selfTestPromise) {
      const emitDebugLog = args?.emitDebugLog ?? (() => undefined);

      this.selfTestPromise = (async () => {
        try {
          emitDebugLog({
            level: "info",
            event: "engine.init.self_test",
            message: "WebGPU マイナーを自己診断しています",
          });
          await withTimeout(
            this.assertHealthy(),
            WEBGPU_SELF_TEST_TIMEOUT_MS,
            "WebGPU 自己診断がタイムアウトしました",
          );
          this.selfTestWarning = null;
        } catch (error) {
          this.selfTestWarning = getErrorMessage(error);
          console.warn("WebGPU miner self-test failed; continuing with WebGPU", error);
        } finally {
          this.selfTestCompleted = true;
        }
      })();
    }

    await this.selfTestPromise;

    if (this.disposed || this.disposeRequested) {
      throw new Error("WebGPU runtime は破棄されています");
    }
  }

  private async assertHealthy() {
    const summary = await deriveSecretSummary(SELF_TEST_SECRET_HEX);
    const npub = encodeNpub(summary.pubkeyHex);

    if (!npub) {
      throw new Error("WebGPU 自己診断用の npub を生成できませんでした");
    }

    const prefix = npub.slice(5, 6);
    const noFilterResult = await this.runBatch({
      batchSize: 1,
      patterns: {
        prefixEnabled: false,
        prefixPattern32: 0,
        prefixMask32: 0,
        suffixEnabled: false,
        suffixPatternHi: 0,
        suffixPatternLo: 0,
        suffixMaskHi: 0,
        suffixMaskLo: 0,
      },
      basePoint: {
        xWords: summary.xWords,
        yWords: summary.yWords,
      },
      captureDebug: true,
    });

    if (
      !(
        noFilterResult.candidateIndexes.length === 1
        && noFilterResult.candidateIndexes[0] === 0
      )
    ) {
      throw new Error(
        `WebGPU 自己診断に失敗しました。フィルタなし smoke test が不正です。candidateCount=${noFilterResult.candidateIndexes.length}, indices=${JSON.stringify(noFilterResult.candidateIndexes.slice(0, 8))}, debug=${formatBatchDebugSnapshot(noFilterResult.debugSnapshot)}, diagnostics=${JSON.stringify(noFilterResult.diagnostics)}`
      );
    }

    const prefixResult = await this.runBatch({
      batchSize: 1,
      patterns: buildMiningPatternConfig({
        prefix,
        suffix: "",
      }),
      basePoint: {
        xWords: summary.xWords,
        yWords: summary.yWords,
      },
      captureDebug: true,
    });

    if (prefixResult.candidateIndexes.length === 1 && prefixResult.candidateIndexes[0] === 0) {
      return;
    }

    throw new Error(
      `WebGPU マイナー自己診断に失敗しました。既知の 1 文字 prefix '${prefix}' でも候補が返りません。candidateCount=${prefixResult.candidateIndexes.length}, indices=${JSON.stringify(prefixResult.candidateIndexes.slice(0, 8))}, debug=${formatBatchDebugSnapshot(prefixResult.debugSnapshot)}, diagnostics=${JSON.stringify(prefixResult.diagnostics)}`,
    );
  }

  getSelfTestWarning() {
    return this.selfTestWarning;
  }

  drainDiagnostics() {
    if (this.diagnostics.length === 0) {
      return [];
    }

    return this.diagnostics.splice(0, this.diagnostics.length);
  }

  private pushDiagnostics(entries: string[]) {
    this.diagnostics.push(...entries);
  }

  dispose() {
    if (this.disposeRequested || this.disposed) {
      return;
    }

    this.disposeRequested = true;
    this.deviceDiagnosticsAttachment?.suppress();
    this.maybeDispose();
  }

  private maybeDispose() {
    if (!this.disposeRequested || this.disposed || this.activeBatchCount > 0) {
      return;
    }

    this.disposed = true;
    safeDestroyBuffer(this.configBuffer);
    safeDestroyBuffer(this.basePointBuffer);
    safeDestroyBuffer(this.windowTableBuffer);
    safeDestroyBuffer(this.candidateBuffer);
    safeDestroyBuffer(this.debugBuffer);
    safeDestroyDevice(this.device);
  }
}

function createRandomBaseSecret(batchSize: number) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto が利用できません");
  }

  const maxBase = SECP256K1_ORDER - BigInt(batchSize);

  if (maxBase <= 0n) {
    throw new Error("batch size が大きすぎるため探索を開始できません");
  }

  const bytes = new Uint8Array(32);

  while (true) {
    globalThis.crypto.getRandomValues(bytes);
    const value = bytesToBigInt(bytes);

    if (value > 0n && value <= maxBase) {
      return value;
    }
  }
}

function bytesToBigInt(bytes: Uint8Array) {
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value;
}

function bigintToSecretHex(value: bigint) {
  return value.toString(16).padStart(64, "0");
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildDiagnosticErrorMessage(
  message: string,
  cause: unknown,
  diagnostics: string[],
) {
  const parts = [message, getErrorMessage(cause)];

  if (diagnostics.length > 0) {
    parts.push(`diagnostics=${JSON.stringify(diagnostics)}`);
  }

  return parts.join(": ");
}

function shouldEmitBatchDebugLog(batchNumber: number, candidateCount: number) {
  return candidateCount > 0 || batchNumber <= 3 || batchNumber % 50 === 0;
}

async function createComputePipelineAsyncWithTimeout(args: {
  device: any;
  descriptor: any;
}) {
  if (typeof args.device.createComputePipelineAsync !== "function") {
    return args.device.createComputePipeline(args.descriptor);
  }

  return withTimeout(
    args.device.createComputePipelineAsync(args.descriptor),
    WEBGPU_PIPELINE_HARD_TIMEOUT_MS,
    "WebGPU compute pipeline の作成がタイムアウトしました",
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: number | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  });
}

async function requestAdapterWithRecovery(args: {
  gpu: any;
  emitDebugLog: DebugLogEmitter;
  runtimeTokenSnapshot?: number;
}): Promise<AdapterAcquisitionResult> {
  const requestOptions: AdapterRequestOption[] = [
    {
      label: "high-performance",
      powerPreference: "high-performance",
    },
    {
      label: "default",
    },
    {
      label: "low-power",
      powerPreference: "low-power",
    },
  ];
  const diagnostics: string[] = [];
  const startedAt = performance.now();
  let attemptCount = 0;

  for (let pass = 0; pass < 2; pass += 1) {
    throwIfRuntimeInitializationStale(args.runtimeTokenSnapshot);

    if (pass > 0) {
      args.emitDebugLog({
        level: "warn",
        event: "engine.init.request_adapter_retry",
        message: "WebGPU adapter が取得できないため、短時間待機して再試行します",
        context: {
          delayMs: WEBGPU_ADAPTER_RECOVERY_DELAY_MS,
        },
      });
      await delayMs(WEBGPU_ADAPTER_RECOVERY_DELAY_MS);
      throwIfRuntimeInitializationStale(args.runtimeTokenSnapshot);
    }

    for (const requestOption of requestOptions) {
      throwIfRuntimeInitializationStale(args.runtimeTokenSnapshot);
      attemptCount += 1;

      if (attemptCount > 1) {
        args.emitDebugLog({
          level: "info",
          event: "engine.init.request_adapter_variant",
          message: "WebGPU adapter を別設定で取得しています",
          context: {
            attempt: attemptCount,
            powerPreference: requestOption.label,
          },
        });
      }

      try {
        const adapter = await withTimeout<any>(
          requestOption.powerPreference
            ? args.gpu.requestAdapter({
                powerPreference: requestOption.powerPreference,
              })
            : args.gpu.requestAdapter(),
          WEBGPU_ADAPTER_ATTEMPT_TIMEOUT_MS,
          `WebGPU adapter の取得がタイムアウトしました (${requestOption.label})`,
        );
        throwIfRuntimeInitializationStale(args.runtimeTokenSnapshot);

        if (adapter) {
          return {
            adapter,
            attemptCount,
            selectedAttempt: attemptCount,
            selectedPreference: requestOption.label,
            totalElapsedMs: roundDurationMs(performance.now() - startedAt),
            diagnostics,
          };
        }

        diagnostics.push(`attempt${attemptCount}:${requestOption.label}:null`);
      } catch (error) {
        rethrowRuntimeInitializationAbortedError(error);
        diagnostics.push(
          `attempt${attemptCount}:${requestOption.label}:${getErrorMessage(error)}`,
        );
      }
    }
  }

  return {
    adapter: null,
    attemptCount,
    selectedAttempt: null,
    selectedPreference: null,
    totalElapsedMs: roundDurationMs(performance.now() - startedAt),
    diagnostics,
  };
}

function readMappedUint32Buffer(buffer: any) {
  try {
    const mappedRange = buffer.getMappedRange();
    return new Uint32Array(mappedRange.slice(0));
  } finally {
    try {
      buffer.unmap();
    } catch {
      // ignore cleanup failure
    }
  }
}

function safeDestroyBuffer(buffer: any) {
  if (!buffer) {
    return;
  }

  try {
    if (buffer.mapState && buffer.mapState !== "unmapped") {
      buffer.unmap();
    }
  } catch {
    // ignore cleanup failure
  }

  if (typeof buffer.destroy === "function") {
    try {
      buffer.destroy();
    } catch {
      // ignore cleanup failure
    }
  }
}

function safeDestroyDevice(device: any) {
  if (!device || typeof device.destroy !== "function") {
    return;
  }

  try {
    device.destroy();
  } catch {
    // ignore cleanup failure
  }
}

async function pushErrorScopes(device: any) {
  device.pushErrorScope("validation");
  device.pushErrorScope("internal");
  device.pushErrorScope("out-of-memory");
}

async function popErrorScopes(device: any, label: string) {
  const oom = await device.popErrorScope();
  const internal = await device.popErrorScope();
  const validation = await device.popErrorScope();
  const diagnostics: string[] = [];

  if (validation) {
    diagnostics.push(`${label}:validation:${validation.message}`);
  }

  if (internal) {
    diagnostics.push(`${label}:internal:${internal.message}`);
  }

  if (oom) {
    diagnostics.push(`${label}:oom:${oom.message}`);
  }

  return diagnostics;
}

async function collectShaderCompilationDiagnostics(shaderModule: any) {
  if (typeof shaderModule.getCompilationInfo !== "function") {
    return [];
  }

  const info = await shaderModule.getCompilationInfo();

  if (!info?.messages) {
    return [];
  }

  return info.messages.map((message: any) => {
    const line = Number.isFinite(message.lineNum) ? message.lineNum : "?";
    const pos = Number.isFinite(message.linePos) ? message.linePos : "?";

    return `shader:${message.type}:line${line}:pos${pos}:${message.message}`;
  });
}

function attachDeviceDiagnostics(
  device: any,
  diagnostics: string[],
  args?: {
    shouldReport?: () => boolean;
  },
): DeviceDiagnosticsAttachment {
  let suppressed = false;
  const shouldReport = args?.shouldReport ?? (() => true);

  if (device?.lost?.then) {
    device.lost.then((info: any) => {
      if (suppressed || !shouldReport()) {
        return;
      }

      const deviceLostMessage =
        `device.lost:${info?.reason ?? "unknown"}:${info?.message ?? ""}`;

      markRuntimeFailed(deviceLostMessage);
      diagnostics.push(deviceLostMessage);
    });
  }

  const uncapturedErrorListener = (event: any) => {
    if (suppressed || !shouldReport()) {
      return;
    }

    diagnostics.push(
      `device.uncapturederror:${event?.error?.message ?? "unknown error"}`,
    );
  };

  if (typeof device?.addEventListener === "function") {
    device.addEventListener("uncapturederror", uncapturedErrorListener);
  }

  return {
    suppress: () => {
      if (suppressed) {
        return;
      }

      suppressed = true;

      if (typeof device?.removeEventListener === "function") {
        device.removeEventListener("uncapturederror", uncapturedErrorListener);
      }
    },
  };
}

function parseBatchDebugSnapshot(words: Uint32Array): BatchDebugSnapshot {
  return {
    xMsw: words[0] ?? 0,
    prefixEnabled: (words[1] ?? 0) !== 0,
    prefixPattern: words[2] ?? 0,
    prefixMask: words[3] ?? 0,
    prefixMatch: (words[4] ?? 0) !== 0,
    suffixMatch: (words[5] ?? 0) !== 0,
    combinedMatch: (words[6] ?? 0) !== 0,
    stage: words[7] ?? 0,
  };
}

function formatBatchDebugSnapshot(snapshot?: BatchDebugSnapshot) {
  if (!snapshot) {
    return "null";
  }

  return JSON.stringify({
    xMsw: toHex32(snapshot.xMsw),
    prefixEnabled: snapshot.prefixEnabled,
    prefixPattern: toHex32(snapshot.prefixPattern),
    prefixMask: toHex32(snapshot.prefixMask),
    prefixMatch: snapshot.prefixMatch,
    suffixMatch: snapshot.suffixMatch,
    combinedMatch: snapshot.combinedMatch,
    stage: snapshot.stage,
  });
}

function toHex32(value: number) {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function roundDurationMs(value: number) {
  return Math.max(0, Math.round(value));
}

function delayMs(durationMs: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        resolve();
      });
      return;
    }

    globalThis.setTimeout(resolve, 0);
  });
}

async function buildMatch(
  candidateSecretHex: string,
  request: {
    prefix: string;
    suffix: string;
  },
): Promise<MiningMatch | null> {
  const pubkeyHex = await pubkeyHexFromSecret(candidateSecretHex);
  const npub = encodeNpub(pubkeyHex);

  if (!npub || !matchesNpubAffixes(npub, request)) {
    return null;
  }

  const nsec = encodeNsec(candidateSecretHex);

  if (!nsec) {
    throw new Error("nsec の生成に失敗しました");
  }

  return {
    secretHex: candidateSecretHex,
    pubkeyHex,
    npub,
    nsec,
  };
}
