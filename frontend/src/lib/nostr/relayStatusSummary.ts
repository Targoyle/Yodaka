import type {
  RelayCoordinatorStatus,
} from "./relayCoordinator";
import type { RelayStatus } from "./relay";

type BuildRoleAwareRelayStatusArgs = {
  readRelayUrls: string[];
  status: RelayCoordinatorStatus;
  writeRelayUrls: string[];
};

export function buildRoleAwareRelayStatus(args: BuildRoleAwareRelayStatusArgs) {
  const readRelayUrlSet = new Set(args.readRelayUrls);
  const writeRelayUrlSet = new Set(args.writeRelayUrls);
  const readRelayStatuses = args.status.relayStatuses.filter((relayStatus) =>
    readRelayUrlSet.has(relayStatus.relayUrl)
  );
  const writeRelayStatuses = args.status.relayStatuses.filter((relayStatus) =>
    writeRelayUrlSet.has(relayStatus.relayUrl)
  );

  if (args.status.phase === "paused" || readRelayStatuses.length === 0) {
    return {
      ...args.status,
      detail: buildRoleAwareDetail({
        rawDetail: args.status.detail,
        readRelayStatuses,
        writeRelayStatuses,
      }),
    };
  }

  const readLiveRelayCount = countRelayPhases(readRelayStatuses, "live");
  const readConnectingCount = countRelayPhases(readRelayStatuses, "connecting");
  const readSubscribingCount = countRelayPhases(readRelayStatuses, "subscribing");
  const readReconnectingCount = countRelayPhases(readRelayStatuses, "reconnecting");
  const readClosedCount = countRelayPhases(readRelayStatuses, "closed");

  let phase: RelayCoordinatorStatus["phase"] = "idle";

  if (readLiveRelayCount === readRelayStatuses.length) {
    phase = "live";
  } else if (readLiveRelayCount > 0) {
    phase = readReconnectingCount > 0 || readClosedCount > 0
      ? "degraded"
      : "partial";
  } else if (readSubscribingCount > 0) {
    phase = "subscribing";
  } else if (readConnectingCount > 0) {
    phase = "connecting";
  } else if (readReconnectingCount > 0) {
    phase = "offline";
  } else if (readClosedCount === readRelayStatuses.length) {
    phase = "closed";
  }

  return {
    ...args.status,
    detail: buildRoleAwareDetail({
      rawDetail: args.status.detail,
      readRelayStatuses,
      writeRelayStatuses,
    }),
    liveRelayCount: readLiveRelayCount,
    phase,
    readyRelayCount: readLiveRelayCount,
  };
}

function buildRoleAwareDetail(args: {
  rawDetail?: string;
  readRelayStatuses: RelayStatus[];
  writeRelayStatuses: RelayStatus[];
}) {
  const readPart = formatRolePart("read", args.readRelayStatuses);
  const writePart = formatRolePart("write", args.writeRelayStatuses);

  if (readPart && writePart) {
    return `${readPart} / ${writePart}`;
  }

  return readPart ?? writePart ?? args.rawDetail;
}

function formatRolePart(label: string, relayStatuses: RelayStatus[]) {
  if (relayStatuses.length === 0) {
    return null;
  }

  const liveRelayCount = countRelayPhases(relayStatuses, "live");

  return `${label} ${liveRelayCount}/${relayStatuses.length} live`;
}

function countRelayPhases(
  relayStatuses: RelayStatus[],
  phase: RelayStatus["phase"],
) {
  return relayStatuses.filter((status) => status.phase === phase).length;
}
