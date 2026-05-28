const BECH32_SEARCH_SPACE_PER_CHARACTER = 32;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;
const INTEGER_FORMATTER = new Intl.NumberFormat("ja-JP");
const JAPANESE_LARGE_NUMBER_UNITS = [
  { label: "無量大数", value: 1e88 },
  { label: "不可思議", value: 1e80 },
  { label: "那由他", value: 1e72 },
  { label: "阿僧祇", value: 1e64 },
  { label: "恒河沙", value: 1e56 },
  { label: "極", value: 1e48 },
  { label: "載", value: 1e44 },
  { label: "正", value: 1e40 },
  { label: "澗", value: 1e36 },
  { label: "溝", value: 1e32 },
  { label: "穣", value: 1e28 },
  { label: "垓", value: 1e20 },
  { label: "京", value: 1e16 },
  { label: "兆", value: 1e12 },
  { label: "億", value: 1e8 },
  { label: "万", value: 1e4 },
  { label: "千", value: 1e3 },
];

export function getMiningAffixLength(args: {
  prefix: string;
  suffix: string;
}) {
  return args.prefix.trim().length + args.suffix.trim().length;
}

export function estimateExpectedAttemptsForAffixLength(affixLength: number) {
  const normalizedLength = normalizeAffixLength(affixLength);

  if (normalizedLength <= 0) {
    return 1;
  }

  return BECH32_SEARCH_SPACE_PER_CHARACTER ** normalizedLength;
}

export function estimateExpectedMiningSeconds(args: {
  affixLength: number;
  keysPerSecond: number;
}) {
  const normalizedLength = normalizeAffixLength(args.affixLength);

  if (normalizedLength <= 0) {
    return null;
  }

  if (!Number.isFinite(args.keysPerSecond) || args.keysPerSecond <= 0) {
    return null;
  }

  return estimateExpectedAttemptsForAffixLength(normalizedLength) / args.keysPerSecond;
}

export function formatElapsedMiningTime(elapsedMs: number) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "00:00:00";
  }

  return formatDurationSeconds(elapsedMs / 1_000);
}

export function formatEstimatedMiningTime(seconds: number | null) {
  if (seconds === null) {
    return "開始後に推定";
  }

  if (!Number.isFinite(seconds) || seconds < 0) {
    return "不明";
  }

  return formatDurationSeconds(seconds);
}

function formatDurationSeconds(seconds: number) {
  const roundedSeconds = Math.max(0, Math.round(seconds));

  if (roundedSeconds < SECONDS_PER_DAY) {
    return formatClockDuration(roundedSeconds);
  }

  if (roundedSeconds < SECONDS_PER_MONTH) {
    const days = Math.floor(roundedSeconds / SECONDS_PER_DAY);
    const remainderSeconds = roundedSeconds % SECONDS_PER_DAY;

    return `${INTEGER_FORMATTER.format(days)}日 ${formatClockDuration(remainderSeconds)}`;
  }

  if (roundedSeconds < SECONDS_PER_YEAR) {
    const months = Math.floor(roundedSeconds / SECONDS_PER_MONTH);
    const remainderDays = Math.floor(
      (roundedSeconds % SECONDS_PER_MONTH) / SECONDS_PER_DAY,
    );

    return remainderDays > 0
      ? `${INTEGER_FORMATTER.format(months)}か月 ${INTEGER_FORMATTER.format(remainderDays)}日`
      : `${INTEGER_FORMATTER.format(months)}か月`;
  }

  const years = roundedSeconds / SECONDS_PER_YEAR;

  if (years < 1_000) {
    const wholeYears = Math.floor(years);
    const remainderMonths = Math.floor(
      (roundedSeconds % SECONDS_PER_YEAR) / SECONDS_PER_MONTH,
    );

    return remainderMonths > 0
      ? `${INTEGER_FORMATTER.format(wholeYears)}年 ${INTEGER_FORMATTER.format(remainderMonths)}か月`
      : `${INTEGER_FORMATTER.format(wholeYears)}年`;
  }

  return formatJapaneseLargeYearCount(years);
}

function formatClockDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");
}

function formatJapaneseLargeYearCount(years: number) {
  for (const unit of JAPANESE_LARGE_NUMBER_UNITS) {
    if (years < unit.value) {
      continue;
    }

    const scaled = years / unit.value;

    return `${formatScaledLargeNumber(scaled)}${unit.label}年`;
  }

  return `${INTEGER_FORMATTER.format(Math.round(years))}年`;
}

function formatScaledLargeNumber(value: number) {
  if (!Number.isFinite(value)) {
    return value.toExponential(2);
  }

  if (value >= 100) {
    return INTEGER_FORMATTER.format(Math.round(value));
  }

  if (value >= 10) {
    return stripTrailingZeros(value.toFixed(1));
  }

  return stripTrailingZeros(value.toFixed(2));
}

function stripTrailingZeros(value: string) {
  return value.replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

function normalizeAffixLength(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
