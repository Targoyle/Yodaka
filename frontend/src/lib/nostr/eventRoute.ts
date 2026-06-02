import { decodeNevent } from "./nip19";

type LocationLike = {
  pathname: string;
  search: string;
  hash?: string;
};

export type FocusedEventRoute = {
  nevent: string;
  eventId: string;
  relayUrls: string[];
  authorPubkey: string | null;
};

export function resolveFocusedEventRouteFromLocation(
  locationLike: LocationLike | URL | null | undefined = getCurrentLocation(),
) {
  if (!locationLike) {
    return null;
  }

  const pathname =
    locationLike instanceof URL ? locationLike.pathname : locationLike.pathname;
  const lastSegment = getLastPathSegment(pathname);

  if (!lastSegment) {
    return null;
  }

  const decoded = decodeNevent(lastSegment);

  if (!decoded) {
    return null;
  }

  return {
    nevent: lastSegment,
    eventId: decoded.eventId,
    relayUrls: decoded.relayUrls,
    authorPubkey: decoded.authorPubkey,
  } satisfies FocusedEventRoute;
}

export function stripFocusedEventFromLocation(
  locationLike: LocationLike | URL | null | undefined = getCurrentLocation(),
) {
  if (!locationLike) {
    return null;
  }

  const pathname =
    locationLike instanceof URL ? locationLike.pathname : locationLike.pathname;
  const search =
    locationLike instanceof URL ? locationLike.search : locationLike.search;
  const hash = locationLike instanceof URL ? locationLike.hash : locationLike.hash ?? "";
  const rawSegments = pathname
    .split("/")
    .filter(Boolean)
    .filter((segment) => decodePathSegment(segment).toLowerCase() !== "index.html");
  const lastSegment = rawSegments.at(-1);

  if (!lastSegment || !decodeNevent(lastSegment)) {
    return `${pathname}${search}${hash}`;
  }

  rawSegments.pop();
  const nextPathname = rawSegments.length > 0 ? `/${rawSegments.join("/")}/` : "/";

  return `${nextPathname}${search}${hash}`;
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

function getLastPathSegment(pathname: string) {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map(decodePathSegment)
    .filter((segment) => segment.toLowerCase() !== "index.html");

  return segments.at(-1) ?? null;
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
