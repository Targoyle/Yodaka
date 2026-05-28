import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  clearWebGpuMinerDebugEmitter,
  getWebGpuRuntimeSnapshot,
  type MiningDebugLog,
  NostrKeyMiner,
  isWebGpuSupported,
  type MiningMatch,
  type MiningProgress,
  type WebGpuRuntimeSnapshot,
} from "../lib/miner/webgpu";
import {
  DEFAULT_MINER_BATCH_SIZE,
  validateMinerBatchSize,
} from "../lib/miner/batchSize";
import {
  describeMiningAffixLengthNote,
  getAffixValidationError,
  MAX_MINING_AFFIX_LENGTH,
  prefixToPreviewHex,
} from "../lib/miner/affix";
import {
  estimateExpectedMiningSeconds,
  formatElapsedMiningTime,
  formatEstimatedMiningTime,
  getMiningAffixLength,
} from "../lib/miner/estimate";

const DEFAULT_BATCH_SIZE = String(DEFAULT_MINER_BATCH_SIZE);
const DEFAULT_PREFIX_PLACEHOLDER = "y0daka";
const DEFAULT_SUFFIX_PLACEHOLDER = "hawk";
const DEBUG_LOG_LIMIT = 200;
const WEBGPU_STATUS_POLL_INTERVAL_MS = 400;
const DEBUG_TIME_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const EMPTY_PROGRESS: MiningProgress = {
  engine: "webgpu",
  keysProcessed: 0,
  batchesProcessed: 0,
  candidatesChecked: 0,
  elapsedMs: 0,
  keysPerSecond: 0,
};

type WebGpuUiStatus =
  | "checking"
  | "initializing"
  | "pending"
  | "standby"
  | "active"
  | "unavailable"
  | "failed";

type StatusChipTone = "live" | "pending" | "closed" | null;

export function KeyMinerPanel(args: {
  developerModeEnabled: boolean;
  initialPrefix?: string;
  initialSuffix?: string;
}) {
  const minerRef = useRef<NostrKeyMiner | null>(null);
  const initializationStartedAtRef = useRef<number | null>(null);
  const [prefix, setPrefix] = useState(args.initialPrefix ?? "");
  const [suffix, setSuffix] = useState(args.initialSuffix ?? "");
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [isMining, setIsMining] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<MiningProgress>(EMPTY_PROGRESS);
  const [result, setResult] = useState<MiningMatch | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [initializationStartedAt, setInitializationStartedAt] = useState<number | null>(null);
  const [initializationMessage, setInitializationMessage] = useState<string | null>(null);
  const webGpuSupported = isWebGpuSupported();
  const [webGpuStatus, setWebGpuStatus] = useState<WebGpuUiStatus>(() =>
    resolveWebGpuUiStatus({
      snapshot: getWebGpuRuntimeSnapshot(),
      isMining: false,
      activeEngine: null,
    }),
  );

  useEffect(() => {
    return () => {
      minerRef.current?.stop();
      clearWebGpuMinerDebugEmitter();
    };
  }, []);

  useEffect(() => {
    if (!copyMessage) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setCopyMessage(null);
    }, 2_000);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [copyMessage]);

  useEffect(() => {
    if (
      !isMining
      || initializationStartedAt === null
      || initializationMessage === null
    ) {
      return;
    }

    const updateStatus = () => {
      setStatusMessage(
        formatInitializationStatus(
          initializationMessage,
          initializationStartedAt,
        ),
      );
    };

    updateStatus();
    const timerId = window.setInterval(updateStatus, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [initializationMessage, initializationStartedAt, isMining]);

  useEffect(() => {
    const syncWebGpuStatus = () => {
      setWebGpuStatus(
        resolveWebGpuUiStatus({
          snapshot: getWebGpuRuntimeSnapshot(),
          isMining,
          activeEngine: isMining ? progress.engine : null,
        }),
      );
    };

    syncWebGpuStatus();
    const timerId = window.setInterval(syncWebGpuStatus, WEBGPU_STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isMining, progress.engine]);

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isMining) {
      return;
    }

    const prefixValidationMessage = getAffixValidationError(prefix, "prefix");
    const suffixValidationMessage = getAffixValidationError(suffix, "suffix");

    if (prefixValidationMessage || suffixValidationMessage) {
      setErrorMessage(prefixValidationMessage ?? suffixValidationMessage);
      return;
    }

    let parsedBatchSize: number;

    try {
      parsedBatchSize = validateMinerBatchSize(
        Number.parseInt(batchSize.trim(), 10),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "batch size が不正です");
      return;
    }

    setErrorMessage(null);
    setCopyMessage(null);
    setResult(null);
    setProgress(EMPTY_PROGRESS);
    setDebugLogs([]);
    const startedAt = Date.now();
    initializationStartedAtRef.current = startedAt;
    setInitializationStartedAt(startedAt);
    const startMessage = webGpuSupported
      ? "WebGPU を初期化しています"
      : "この環境では WebGPU が使えないため、CPU で探索を開始しています";
    setInitializationMessage(startMessage);
    setStatusMessage(startMessage);
    setIsStopping(false);

    const miner = new NostrKeyMiner();
    minerRef.current = miner;
    setIsMining(true);

    try {
      const match = await miner.mine({
        prefix,
        suffix,
        batchSize: parsedBatchSize,
        onProgress: (nextProgress) => {
          initializationStartedAtRef.current = null;
          setInitializationStartedAt(null);
          setInitializationMessage(null);
          const engineLabel =
            nextProgress.engine === "cpu" ? "CPU fallback" : "WebGPU";

          setProgress(nextProgress);
          setStatusMessage(
            `探索中 (${engineLabel}): ${formatRate(nextProgress.keysPerSecond)} / ${formatCount(nextProgress.keysProcessed)} keys`,
          );
        },
        onDebugLog: (entry) => {
          appendDebugLog(formatDebugLog(entry));
          handleDebugLog(entry);
        },
      });

      if (match) {
        initializationStartedAtRef.current = null;
        setInitializationStartedAt(null);
        setInitializationMessage(null);
        setResult(match);
        setStatusMessage(null);
      } else if (miner.isStopped()) {
        initializationStartedAtRef.current = null;
        setInitializationStartedAt(null);
        setInitializationMessage(null);
        setStatusMessage("停止しました");
      } else {
        initializationStartedAtRef.current = null;
        setInitializationStartedAt(null);
        setInitializationMessage(null);
        setStatusMessage("探索を終了しました");
      }
    } catch (error) {
      initializationStartedAtRef.current = null;
      setInitializationStartedAt(null);
      setInitializationMessage(null);
      appendDebugLog(
        formatLocalDebugLog("error", "ui.error", "探索に失敗しました", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      setErrorMessage(error instanceof Error ? error.message : "探索に失敗しました");
      setStatusMessage("エラー");
    } finally {
      if (minerRef.current === miner) {
        minerRef.current = null;
      }

      initializationStartedAtRef.current = null;
      setInitializationStartedAt(null);
      setInitializationMessage(null);
      setIsMining(false);
      setIsStopping(false);
    }
  }

  function handleStop() {
    if (!minerRef.current) {
      return;
    }

    appendDebugLog(
      formatLocalDebugLog("info", "ui.stop_requested", "停止を要求しました"),
    );
    minerRef.current.stop();
    setIsStopping(true);
    setStatusMessage("現在の batch 完了後に停止します");
  }

  async function handleCopy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`${label} をコピーしました`);
    } catch {
      setCopyMessage(`${label} をコピーできませんでした`);
    }
  }

  function appendDebugLog(line: string) {
    setDebugLogs((current) => {
      const next = [...current, line];

      if (next.length <= DEBUG_LOG_LIMIT) {
        return next;
      }

      return next.slice(next.length - DEBUG_LOG_LIMIT);
    });
  }

  function handleDebugLog(entry: MiningDebugLog) {
    const nextInitializationMessage = getInitializationMessage(entry);
    applyWebGpuStatusFromDebugLog(entry, setWebGpuStatus);

    if (!nextInitializationMessage) {
      return;
    }

    setInitializationMessage(nextInitializationMessage);

    if (initializationStartedAtRef.current !== null) {
      setStatusMessage(
        formatInitializationStatus(
          nextInitializationMessage,
          initializationStartedAtRef.current,
        ),
      );
      return;
    }

    setStatusMessage(nextInitializationMessage);
  }

  const prefixPreviewStyle = buildPrefixPreviewStyle(
    prefix.trim() || DEFAULT_PREFIX_PLACEHOLDER,
  );
  const prefixValidationMessage = getAffixValidationError(prefix, "prefix");
  const suffixValidationMessage = getAffixValidationError(suffix, "suffix");
  const affixLength = getMiningAffixLength({
    prefix,
    suffix,
  });
  const displayedElapsedMs =
    progress.elapsedMs > 0
      ? progress.elapsedMs
      : isMining && initializationStartedAt !== null
        ? Date.now() - initializationStartedAt
        : 0;
  const estimatedMiningSeconds =
    prefixValidationMessage || suffixValidationMessage
      ? null
      : estimateExpectedMiningSeconds({
          affixLength,
          keysPerSecond: progress.keysPerSecond,
        });
  const affixLengthNote = describeMiningAffixLengthNote(affixLength);
  const modeBadge = buildModeBadge(webGpuStatus);
  const webGpuBadge = buildWebGpuBadge(webGpuStatus);
  const shouldShowStatusMessage = !isMining && statusMessage !== null;

  return (
    <section className="panel miner-panel">
      <div className="section-heading miner-heading">
        <h2 className="section-chip">Key Miner</h2>
        <div className="miner-heading-statuses">
          <span className={buildStatusChipClass(modeBadge.tone)}>
            {modeBadge.label}
          </span>
          <span className={buildStatusChipClass(webGpuBadge.tone)}>
            {webGpuBadge.label}
          </span>
        </div>
      </div>

      <p className="muted miner-copy">
        `npub1` を除いた bech32 断片の prefix / suffix に一致する秘密鍵を探索します。
        結果は保存せず、画面上に表示のみ行います。
      </p>

      <form className="miner-form" onSubmit={handleStart}>
        <label className="miner-field">
          <span
            className={`miner-label${prefixValidationMessage ? " miner-label-error" : ""}`}
          >
            prefix
          </span>
          <div className="miner-input-wrap">
            <span
              className="miner-prefix-preview"
              style={prefixPreviewStyle}
              aria-hidden="true"
            />
            <input
              className={`miner-input miner-input-prefix${prefixValidationMessage ? " miner-input-error" : ""}`}
              value={prefix}
              onChange={(event) => {
                setPrefix(event.target.value);
                if (errorMessage) {
                  setErrorMessage(null);
                }
              }}
              placeholder={`例: ${DEFAULT_PREFIX_PLACEHOLDER}`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={MAX_MINING_AFFIX_LENGTH}
              aria-invalid={prefixValidationMessage !== null}
              disabled={isMining}
            />
          </div>
          {prefixValidationMessage ? (
            <span className="miner-field-message miner-field-message-error">
              {prefixValidationMessage}
            </span>
          ) : null}
        </label>

        <label className="miner-field">
          <span
            className={`miner-label${suffixValidationMessage ? " miner-label-error" : ""}`}
          >
            suffix
          </span>
          <input
            className={`miner-input${suffixValidationMessage ? " miner-input-error" : ""}`}
            value={suffix}
            onChange={(event) => {
              setSuffix(event.target.value);
              if (errorMessage) {
                setErrorMessage(null);
              }
            }}
            placeholder={`例: ${DEFAULT_SUFFIX_PLACEHOLDER}`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={MAX_MINING_AFFIX_LENGTH}
            aria-invalid={suffixValidationMessage !== null}
            disabled={isMining}
          />
          {suffixValidationMessage ? (
            <span className="miner-field-message miner-field-message-error">
              {suffixValidationMessage}
            </span>
          ) : null}
        </label>

        {args.developerModeEnabled ? (
          <label className="miner-field miner-field-batch">
            <span className="miner-label">batch size</span>
            <input
              className="miner-input"
              value={batchSize}
              onChange={(event) => {
                setBatchSize(event.target.value);
                if (errorMessage) {
                  setErrorMessage(null);
                }
              }}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder={DEFAULT_BATCH_SIZE}
              disabled={isMining}
            />
          </label>
        ) : null}

        <div className="miner-actions">
          <button
            type="submit"
            className="composer-submit miner-submit miner-action-button"
            disabled={isMining}
          >
            {isMining ? "探索中" : "開始"}
          </button>
          <button
            type="button"
            className="relay-settings-button relay-settings-button-secondary miner-stop miner-action-button"
            onClick={handleStop}
            disabled={!isMining}
          >
            {isStopping ? "停止待ち..." : "停止"}
          </button>
        </div>
      </form>

      <div className="miner-metrics">
        <div className="miner-metric">
          <span className="miner-metric-label">速度</span>
          <strong className="miner-metric-value">
            {formatRate(progress.keysPerSecond)}
          </strong>
        </div>
        <div className="miner-metric">
          <span className="miner-metric-label">経過時間</span>
          <strong className="miner-metric-value">
            {formatElapsedMiningTime(displayedElapsedMs)}
          </strong>
        </div>
        <div className="miner-metric">
          <span className="miner-metric-label">探索数</span>
          <strong className="miner-metric-value">
            {formatCount(progress.keysProcessed)}
          </strong>
        </div>
        <div className="miner-metric">
          <span className="miner-metric-label">合計長</span>
          <strong className="miner-metric-value">
            {formatCount(affixLength)} 文字
          </strong>
          {affixLengthNote ? (
            <span className="miner-metric-note">{affixLengthNote}</span>
          ) : null}
        </div>
        <div className="miner-metric">
          <span className="miner-metric-label">想定時間</span>
          <strong className="miner-metric-value">
            {prefixValidationMessage || suffixValidationMessage
              ? "入力エラー"
              : affixLength <= 0
                ? "入力待ち"
                : formatEstimatedMiningTime(estimatedMiningSeconds)}
          </strong>
        </div>
        {args.developerModeEnabled ? (
          <div className="miner-metric">
            <span className="miner-metric-label">batch</span>
            <strong className="miner-metric-value">
              {formatCount(progress.batchesProcessed)}
            </strong>
          </div>
        ) : null}
        {args.developerModeEnabled ? (
          <div className="miner-metric">
            <span className="miner-metric-label">候補検証</span>
            <strong className="miner-metric-value">
              {formatCount(progress.candidatesChecked)}
            </strong>
          </div>
        ) : null}
      </div>

      {errorMessage ? (
        <p className="composer-feedback composer-status-error">
          {errorMessage}
        </p>
      ) : shouldShowStatusMessage ? (
        <p className="composer-feedback muted">{statusMessage}</p>
      ) : null}

      {copyMessage ? (
        <p className="composer-feedback muted">{copyMessage}</p>
      ) : null}

      {args.developerModeEnabled ? (
        <section className="miner-debug-card">
          <div className="miner-debug-header">
            <span className="miner-result-label">Debug Log</span>
            <button
              type="button"
              className="relay-settings-button relay-settings-button-secondary miner-copy-button"
              onClick={() => handleCopy("debug log", debugLogs.join("\n"))}
              disabled={debugLogs.length === 0}
            >
              コピー
            </button>
          </div>
          <pre className="miner-debug-log">
            {debugLogs.length > 0 ? debugLogs.join("\n") : "ログ待機中"}
          </pre>
        </section>
      ) : null}

      {result ? (
        <>
          <section className="miner-found-card">
            <span className="miner-found-label">鍵を発見しました！</span>
            <p className="miner-found-copy">
              一致した `npub` / `nsec` と hex を下に表示しています。
            </p>
          </section>
          <div className="miner-result-grid">
            <ResultField
              label="npub"
              value={result.npub}
              onCopy={() => handleCopy("npub", result.npub)}
            />
            <ResultField
              label="nsec"
              value={result.nsec}
              onCopy={() => handleCopy("nsec", result.nsec)}
            />
            <ResultField
              label="pubkey hex"
              value={result.pubkeyHex}
              onCopy={() => handleCopy("pubkey hex", result.pubkeyHex)}
            />
            <ResultField
              label="secret hex"
              value={result.secretHex}
              onCopy={() => handleCopy("secret hex", result.secretHex)}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

function ResultField(args: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="miner-result-card">
      <div className="miner-result-header">
        <span className="miner-result-label">{args.label}</span>
        <button
          type="button"
          className="relay-settings-button relay-settings-button-secondary miner-copy-button"
          onClick={args.onCopy}
        >
          コピー
        </button>
      </div>
      <code className="miner-result-value">{args.value}</code>
    </div>
  );
}

function formatCount(value: number) {
  return new Intl.NumberFormat("ja-JP").format(Math.max(0, Math.floor(value)));
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 keys/s";
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} Mkeys/s`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)} kkeys/s`;
  }

  return `${Math.round(value)} keys/s`;
}

function formatInitializationStatus(message: string, startedAt: number) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));

  if (elapsedSeconds <= 0) {
    return message;
  }

  return `${message} (${elapsedSeconds}秒経過)`;
}

function getInitializationMessage(entry: MiningDebugLog) {
  switch (entry.event) {
    case "engine.init.request_adapter":
    case "engine.init.request_adapter_variant":
    case "engine.init.request_adapter_retry":
    case "engine.init.request_adapter_selected":
    case "engine.init.request_device":
    case "engine.init.create_shader_module":
    case "engine.init.create_pipeline":
    case "engine.init.create_pipeline_done":
    case "engine.init.prepare_table":
    case "engine.init.create_bind_group":
    case "engine.init.self_test":
    case "engine.init.ready":
      return entry.message;
    case "engine.selected":
    case "engine.selected_background":
      return "WebGPU の初期化が完了しました。探索を開始しています";
    case "engine.cpu_only":
      return "この環境では WebGPU が使えないため、CPU で探索を開始しています";
    case "engine.defer_to_cpu":
      return "WebGPU 初期化を継続しつつ、先に CPU で探索しています";
    case "engine.init.failed_background":
    case "webgpu.batch_error":
    case "engine.fallback":
      return "CPU fallback に切り替えました。CPU で探索を開始しています";
    default:
      return null;
  }
}

function resolveWebGpuUiStatus(args: {
  snapshot: WebGpuRuntimeSnapshot;
  isMining: boolean;
  activeEngine: MiningProgress["engine"] | null;
}): WebGpuUiStatus {
  if (!args.snapshot.supported || args.snapshot.status === "unavailable") {
    return "unavailable";
  }

  if (args.activeEngine === "webgpu") {
    return "active";
  }

  if (args.snapshot.status === "failed") {
    return "failed";
  }

  if (
    args.isMining
    && (args.snapshot.status === "pending" || args.snapshot.status === "ready")
  ) {
    return "pending";
  }

  if (args.snapshot.status === "ready") {
    return "standby";
  }

  if (args.snapshot.status === "pending") {
    return "initializing";
  }

  return "checking";
}

function applyWebGpuStatusFromDebugLog(
  entry: MiningDebugLog,
  setWebGpuStatus: (status: WebGpuUiStatus) => void,
) {
  switch (entry.event) {
    case "engine.init.request_adapter":
    case "engine.init.request_adapter_variant":
    case "engine.init.request_adapter_retry":
    case "engine.init.request_adapter_selected":
    case "engine.init.request_device":
    case "engine.init.create_shader_module":
    case "engine.init.create_pipeline":
    case "engine.init.create_pipeline_done":
    case "engine.init.prepare_table":
    case "engine.init.create_bind_group":
    case "engine.init.self_test":
      setWebGpuStatus("initializing");
      return;
    case "engine.cpu_only":
      setWebGpuStatus("unavailable");
      return;
    case "engine.defer_to_cpu":
      setWebGpuStatus("pending");
      return;
    case "engine.selected":
    case "engine.selected_background":
      setWebGpuStatus("active");
      return;
    case "engine.init.ready":
      return;
    case "engine.init.failed_background":
    case "webgpu.batch_error":
    case "engine.fallback":
      setWebGpuStatus("failed");
      return;
    default:
      return;
  }
}

function buildWebGpuBadge(status: WebGpuUiStatus): {
  label: string;
  tone: Exclude<StatusChipTone, null>;
} {
  switch (status) {
    case "active":
      return { label: "WebGPU Active", tone: "live" };
    case "standby":
      return { label: "WebGPU Standby", tone: "live" };
    case "pending":
      return { label: "WebGPU Pending", tone: "pending" };
    case "initializing":
      return { label: "WebGPU Initializing", tone: "pending" };
    case "failed":
      return { label: "WebGPU Failed", tone: "closed" };
    case "unavailable":
      return { label: "WebGPU Unavailable", tone: "closed" };
    case "checking":
    default:
      return { label: "WebGPU Checking", tone: "pending" };
  }
}

function buildModeBadge(status: WebGpuUiStatus): {
  label: string;
  tone: StatusChipTone;
} {
  if (status === "standby" || status === "active") {
    return {
      label: "GPU Mode",
      tone: "live",
    };
  }

  return {
    label: "CPU Mode",
    tone:
      status === "failed" || status === "unavailable"
        ? "closed"
        : "pending",
  };
}

function buildStatusChipClass(tone: StatusChipTone) {
  return tone ? `status-chip status-chip-${tone}` : "status-chip";
}

function buildPrefixPreviewStyle(prefixSeed: string): CSSProperties {
  let background = "#000000";

  try {
    background = prefixToPreviewHex(prefixSeed);
  } catch {
    // ignore invalid intermediate input while editing
  }

  return {
    background,
  };
}

function formatDebugLog(entry: MiningDebugLog) {
  const time = DEBUG_TIME_FORMATTER.format(entry.timestampMs);
  const context = entry.context ? ` ${safeJson(entry.context)}` : "";

  return `[${time}] ${entry.level.toUpperCase()} ${entry.event} ${entry.message}${context}`;
}

function formatLocalDebugLog(
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  context?: Record<string, unknown>,
) {
  return formatDebugLog({
    timestampMs: Date.now(),
    level,
    event,
    message,
    context,
  });
}

function safeJson(value: Record<string, unknown>) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"error":"debug log serialization failed"}';
  }
}
