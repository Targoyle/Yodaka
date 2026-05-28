const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const NPUB_PUBLIC_KEY_BYTE_LENGTH = 32;
const BECH32_WORD_BITS = 5;
const BECH32_CHECKSUM_LENGTH = 6;
const UINT64_MASK = (1n << 64n) - 1n;

export const MAX_MINING_AFFIX_LENGTH =
  Math.ceil((NPUB_PUBLIC_KEY_BYTE_LENGTH * 8) / BECH32_WORD_BITS)
  + BECH32_CHECKSUM_LENGTH;
export const MAX_GPU_PREFIX_AFFIX_LENGTH = 6;
export const MAX_GPU_SUFFIX_AFFIX_LENGTH = 12;
export const MAX_GPU_TOTAL_AFFIX_WINDOW =
  MAX_GPU_PREFIX_AFFIX_LENGTH + MAX_GPU_SUFFIX_AFFIX_LENGTH;

export type NormalizedMiningRequest = {
  prefix: string;
  suffix: string;
};

export type MiningPatternConfig = {
  prefixEnabled: boolean;
  prefixPattern32: number;
  prefixMask32: number;
  suffixEnabled: boolean;
  suffixPatternHi: number;
  suffixPatternLo: number;
  suffixMaskHi: number;
  suffixMaskLo: number;
};

export function normalizeMiningRequest(args: {
  prefix: string;
  suffix: string;
}): NormalizedMiningRequest {
  const prefix = args.prefix.trim();
  const suffix = args.suffix.trim();

  if (prefix === "" && suffix === "") {
    throw new Error("prefix または suffix を入力してください");
  }

  validateAffix(prefix, "prefix");
  validateAffix(suffix, "suffix");

  return {
    prefix,
    suffix,
  };
}

export function buildMiningPatternConfig(
  request: NormalizedMiningRequest,
): MiningPatternConfig {
  // WebGPU の prefix/suffix 事前判定は固定長ビット窓だけで見る。
  // 完全一致は候補検証時に startsWith/endsWith で最終確認する。
  const gpuPrefix = request.prefix.slice(0, MAX_GPU_PREFIX_AFFIX_LENGTH);
  const gpuSuffix = request.suffix.slice(-MAX_GPU_SUFFIX_AFFIX_LENGTH);
  const prefixBits = gpuPrefix === "" ? null : prefixToBits(gpuPrefix);
  const suffixBits = gpuSuffix === "" ? null : suffixToBits(gpuSuffix);
  const suffixPattern = splitU64(suffixBits?.pattern ?? 0n);
  const suffixMask = splitU64(suffixBits?.mask ?? 0n);

  return {
    prefixEnabled: prefixBits !== null,
    prefixPattern32: prefixBits === null ? 0 : splitU64(prefixBits.pattern).hi,
    prefixMask32: prefixBits === null ? 0 : splitU64(prefixBits.mask).hi,
    suffixEnabled: suffixBits !== null,
    suffixPatternHi: suffixPattern.hi,
    suffixPatternLo: suffixPattern.lo,
    suffixMaskHi: suffixMask.hi,
    suffixMaskLo: suffixMask.lo,
  };
}

export function matchesNpubAffixes(
  npub: string,
  request: NormalizedMiningRequest,
) {
  const body = npub.startsWith("npub1") ? npub.slice(5) : npub;

  return (
    (request.prefix === "" || body.startsWith(request.prefix))
    && (request.suffix === "" || body.endsWith(request.suffix))
  );
}

export function prefixToBits(prefix: string) {
  let pattern = 0n;
  let bitPosition = 64n;

  for (const character of prefix) {
    const value = BigInt(indexOfBech32(character));
    bitPosition -= 5n;
    pattern |= value << bitPosition;
  }

  const bitLength = BigInt(prefix.length * 5);
  const mask =
    bitLength === 0n
      ? 0n
      : bitLength >= 64n
        ? UINT64_MASK
        : (UINT64_MASK << (64n - bitLength)) & UINT64_MASK;

  return {
    pattern,
    mask,
    bitLength: Number(bitLength),
  };
}

export function prefixToPreviewHex(prefix: string) {
  const normalized = prefix.trim().slice(0, 5);

  if (normalized === "") {
    return "#000000";
  }

  const prefixBits = prefixToBits(normalized);
  const previewValue = Number((prefixBits.pattern >> 40n) & 0xff_ff_ffn);

  return `#${previewValue.toString(16).padStart(6, "0")}`;
}

export function getAffixValidationError(
  fragment: string,
  label: "prefix" | "suffix",
) {
  try {
    validateAffix(fragment.trim(), label);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function describeMiningAffixLengthNote(affixLength: number) {
  const normalizedLength = Math.max(0, Math.floor(affixLength));

  if (normalizedLength > MAX_MINING_AFFIX_LENGTH) {
    return "npub 文字数を超えています。";
  }

  if (normalizedLength === MAX_MINING_AFFIX_LENGTH) {
    return "npub マイニング最大長です。";
  }

  if (normalizedLength > MAX_GPU_TOTAL_AFFIX_WINDOW) {
    return "計算非対応です。";
  }

  return null;
}

export function suffixToBits(suffix: string) {
  let pattern = 0n;

  for (const character of suffix) {
    const value = BigInt(indexOfBech32(character));
    pattern = (pattern << 5n) | value;
  }

  const bitLength = BigInt(suffix.length * 5);
  const mask =
    bitLength === 0n
      ? 0n
      : bitLength >= 64n
        ? UINT64_MASK
        : (1n << bitLength) - 1n;

  return {
    pattern,
    mask,
    bitLength: Number(bitLength),
  };
}

function validateAffix(fragment: string, label: "prefix" | "suffix") {
  if (fragment === "") {
    return;
  }

  if (fragment.length > MAX_MINING_AFFIX_LENGTH) {
    throw new Error(
      `${label} は ${MAX_MINING_AFFIX_LENGTH} 文字以内で指定してください`,
    );
  }

  for (const character of fragment) {
    if (character >= "A" && character <= "Z") {
      throw new Error(
        `${label} は bech32 の小文字のみ使えます。大文字の '${character}' は使えません`,
      );
    }

    if (!BECH32_CHARSET.includes(character)) {
      throw new Error(
        `${label} に '${character}' は使えません。${describeInvalidCharacter(character)}`,
      );
    }
  }
}

function indexOfBech32(character: string) {
  const index = BECH32_CHARSET.indexOf(character);

  if (index < 0) {
    throw new Error(`bech32 では '${character}' を使えません`);
  }

  return index;
}

function describeInvalidCharacter(character: string) {
  switch (character) {
    case "1":
      return "区切り文字のため予約されています";

    case "b":
    case "i":
    case "o":
      return "似た文字との混同を避けるため bech32 から除外されています";

    default:
      return `使える文字は ${BECH32_CHARSET} です`;
  }
}

function splitU64(value: bigint) {
  return {
    hi: Number((value >> 32n) & 0xffff_ffffn) >>> 0,
    lo: Number(value & 0xffff_ffffn) >>> 0,
  };
}
