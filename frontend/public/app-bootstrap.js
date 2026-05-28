(function bootstrapYodakaPathing() {
  if (window.__yodakaAppBootstrapLoaded) {
    return;
  }

  window.__yodakaAppBootstrapLoaded = true;

  const markers = new Set(["miner", "key-miner", "keyminer"]);
  const pathname = window.location.pathname;
  const rawSegments = pathname.split("/").filter(Boolean);
  let markerIndex = -1;

  for (let index = rawSegments.length - 1; index >= 0; index -= 1) {
    const segment = decodePathSegment(rawSegments[index]).toLowerCase();

    if (segment === "index.html") {
      continue;
    }

    if (markers.has(segment)) {
      markerIndex = index;
      break;
    }
  }

  if (markerIndex >= 0) {
    const isBareMinerPath = markerIndex === rawSegments.length - 1;

    if (isBareMinerPath && pathname.endsWith("/")) {
      const canonicalPath = `/${rawSegments.join("/")}`;
      window.location.replace(
        `${canonicalPath}${window.location.search}${window.location.hash}`,
      );
      return;
    }
  }

  const basePath = resolveBasePath(pathname, rawSegments, markerIndex);
  const faviconPath =
    basePath === "/" ? "/favicon.ico" : `${basePath}favicon.ico`;
  let faviconElement = document.head.querySelector("#app-favicon");

  if (!faviconElement) {
    faviconElement = document.createElement("link");
    faviconElement.setAttribute("id", "app-favicon");
    faviconElement.setAttribute("rel", "icon");
    faviconElement.setAttribute("type", "image/x-icon");
    document.head.prepend(faviconElement);
  }

  faviconElement.setAttribute("href", faviconPath);

  if (markerIndex < 0) {
    return;
  }

  let baseElement = document.head.querySelector("base");

  if (!baseElement) {
    baseElement = document.createElement("base");
    document.head.prepend(baseElement);
  }

  baseElement.setAttribute("href", basePath);

  function resolveBasePath(currentPathname, segments, currentMarkerIndex) {
    if (currentMarkerIndex >= 0) {
      const prefix = segments.slice(0, currentMarkerIndex).join("/");
      return prefix === "" ? "/" : `/${prefix}/`;
    }

    if (currentPathname.endsWith("/")) {
      return currentPathname;
    }

    if (segments.length === 0) {
      return "/";
    }

    if (segments.length === 1) {
      return `/${segments[0]}/`;
    }

    return `/${segments.slice(0, -1).join("/")}/`;
  }

  function decodePathSegment(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
})();
