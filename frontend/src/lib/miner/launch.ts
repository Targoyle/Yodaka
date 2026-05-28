export type KeyMinerLaunchConfig = {
  open: boolean;
  prefix: string;
  suffix: string;
};

type LocationLike = {
  pathname: string;
  search: string;
  hash?: string;
};

const KEY_MINER_PATH_MARKERS = new Set(["miner", "key-miner", "keyminer"]);
const OPEN_QUERY_PARAM_NAMES = ["miner", "keyMiner", "key-miner"];
const FALSE_QUERY_VALUES = new Set(["0", "false", "off", "no"]);

export function resolveKeyMinerLaunchFromLocation(
  locationLike: LocationLike | URL | null | undefined = getCurrentLocation(),
): KeyMinerLaunchConfig {
  if (!locationLike) {
    return {
      open: false,
      prefix: "",
      suffix: "",
    };
  }

  const pathname =
    locationLike instanceof URL ? locationLike.pathname : locationLike.pathname;
  const search =
    locationLike instanceof URL ? locationLike.search : locationLike.search;
  const pathConfig = parseKeyMinerPath(pathname);
  const searchParams = new URLSearchParams(search);
  const queryPrefix = normalizeLaunchValue(searchParams.get("prefix"));
  const querySuffix = normalizeLaunchValue(searchParams.get("suffix"));
  const openFromQuery =
    queryPrefix !== ""
    || querySuffix !== ""
    || OPEN_QUERY_PARAM_NAMES.some((name) => hasTruthyQueryParam(searchParams, name));

  return {
    open: pathConfig.open || openFromQuery,
    prefix: queryPrefix || pathConfig.prefix,
    suffix: querySuffix || pathConfig.suffix,
  };
}

export function stripKeyMinerLaunchFromLocation(
  locationLike: LocationLike | URL | null | undefined = getCurrentLocation(),
) {
  if (!locationLike) {
    return null;
  }

  const normalized = normalizeLaunchLocation(locationLike);

  return `${normalized.basePathname}${
    normalized.preservedSearch === ""
      ? ""
      : `?${normalized.preservedSearch}`
  }${normalized.hash}`;
}

export function buildKeyMinerOpenLocation(
  locationLike: LocationLike | URL | null | undefined = getCurrentLocation(),
) {
  if (!locationLike) {
    return null;
  }

  const normalized = normalizeLaunchLocation(locationLike);
  const nextPathname = normalized.basePathname === "/"
    ? "/miner"
    : `${normalized.basePathname}miner`;

  return `${nextPathname}${
    normalized.preservedSearch === ""
      ? ""
      : `?${normalized.preservedSearch}`
  }${normalized.hash}`;
}

function parseKeyMinerPath(pathname: string): KeyMinerLaunchConfig {
  const decodedSegments = pathname
    .split("/")
    .filter(Boolean)
    .map(decodePathSegment)
    .filter((segment) => segment.toLowerCase() !== "index.html");
  const markerIndex = findKeyMinerMarkerIndex(decodedSegments);

  if (markerIndex < 0) {
    return {
      open: false,
      prefix: "",
      suffix: "",
    };
  }

  const tailSegments = decodedSegments.slice(markerIndex + 1);
  let prefix = "";
  let suffix = "";

  for (let index = 0; index < tailSegments.length; index += 1) {
    const segment = tailSegments[index];
    const normalizedSegment = segment.toLowerCase();

    if (normalizedSegment === "prefix" && tailSegments[index + 1]) {
      prefix ||= tailSegments[index + 1];
      index += 1;
      continue;
    }

    if (normalizedSegment === "suffix" && tailSegments[index + 1]) {
      suffix ||= tailSegments[index + 1];
      index += 1;
      continue;
    }

    if (!prefix) {
      prefix = segment;
      continue;
    }

    if (!suffix) {
      suffix = segment;
      break;
    }
  }

  return {
    open: true,
    prefix,
    suffix,
  };
}

function getCurrentLocation(): LocationLike | null {
  if (typeof window === "undefined" || !window.location) {
    return null;
  }

  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeLaunchValue(value: string | null) {
  return value?.trim() ?? "";
}

function hasTruthyQueryParam(searchParams: URLSearchParams, name: string) {
  if (!searchParams.has(name)) {
    return false;
  }

  const value = normalizeLaunchValue(searchParams.get(name)).toLowerCase();
  return !FALSE_QUERY_VALUES.has(value);
}

function findKeyMinerMarkerIndex(pathSegments: string[]) {
  for (let index = pathSegments.length - 1; index >= 0; index -= 1) {
    if (KEY_MINER_PATH_MARKERS.has(decodePathSegment(pathSegments[index]).toLowerCase())) {
      return index;
    }
  }

  return -1;
}

function normalizeLaunchLocation(locationLike: LocationLike | URL) {
  const pathname =
    locationLike instanceof URL ? locationLike.pathname : locationLike.pathname;
  const search =
    locationLike instanceof URL ? locationLike.search : locationLike.search;
  const hash = locationLike instanceof URL ? locationLike.hash : locationLike.hash ?? "";
  const rawSegments = pathname
    .split("/")
    .filter(Boolean)
    .filter((segment) => decodePathSegment(segment).toLowerCase() !== "index.html");
  const markerIndex = findKeyMinerMarkerIndex(rawSegments);
  const preservedSegments = markerIndex < 0 ? rawSegments : rawSegments.slice(0, markerIndex);
  const basePathname = preservedSegments.length > 0
    ? `/${preservedSegments.join("/")}/`
    : "/";
  const searchParams = new URLSearchParams(search);

  searchParams.delete("prefix");
  searchParams.delete("suffix");

  for (const name of OPEN_QUERY_PARAM_NAMES) {
    searchParams.delete(name);
  }

  return {
    basePathname,
    preservedSearch: searchParams.toString(),
    hash,
  };
}
