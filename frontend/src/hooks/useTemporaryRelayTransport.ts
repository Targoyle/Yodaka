import {
  useMemo,
  type MutableRefObject,
} from "react";
import type { RelayCoordinator } from "../lib/nostr/relayCoordinator";
import { createTemporaryRelayTransport } from "../lib/nostr/temporaryRelayTransport";

type UseTemporaryRelayTransportArgs = {
  active: boolean;
  relayBootstrapDeferred: boolean;
  relayCoordinatorRef: MutableRefObject<RelayCoordinator | null>;
  readyReadRelayCount: number;
};

export function useTemporaryRelayTransport(args: UseTemporaryRelayTransportArgs) {
  const relayTransport = useMemo(
    () => createTemporaryRelayTransport(() => args.relayCoordinatorRef.current),
    [args.relayCoordinatorRef],
  );

  const waitingForReadyRelay =
    args.active
    && !args.relayBootstrapDeferred
    && args.readyReadRelayCount === 0;
  const ready = !waitingForReadyRelay && args.active && !args.relayBootstrapDeferred;

  return {
    ready,
    relayTransport,
    waitingForReadyRelay,
  };
}
