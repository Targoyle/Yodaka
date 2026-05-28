const AVATAR_FALLBACK_LABEL = "#";
const ASCII_LETTER_RE = /^[a-z]$/i;

export function formatAvatarFallbackLabel(source: string) {
  const trimmed = source.trim();

  if (!trimmed) {
    return AVATAR_FALLBACK_LABEL;
  }

  const firstGrapheme = getFirstGrapheme(trimmed);

  if (!firstGrapheme) {
    return AVATAR_FALLBACK_LABEL;
  }

  if (ASCII_LETTER_RE.test(firstGrapheme)) {
    return firstGrapheme.toUpperCase();
  }

  return firstGrapheme;
}

function getFirstGrapheme(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("ja-JP", {
      granularity: "grapheme",
    });
    const iterator = segmenter.segment(value)[Symbol.iterator]();
    const first = iterator.next().value;

    if (first?.segment) {
      return first.segment;
    }
  }

  return Array.from(value)[0] ?? null;
}
