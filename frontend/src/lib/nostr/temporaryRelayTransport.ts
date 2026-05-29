import type { RelayOneShotTransport } from "./contacts";
import type { RelayCoordinator } from "./relayCoordinator";

type RelayCoordinatorGetter = () => RelayCoordinator | null;

export function createTemporaryRelayTransport(
  getRelayCoordinator: RelayCoordinatorGetter,
): RelayOneShotTransport {
  return {
    requestTemporaryEvents: async (relayUrl, filters, timeoutMs) => {
      const coordinator = getRelayCoordinator();

      if (!coordinator) {
        return [];
      }

      try {
        return await coordinator.requestTemporaryEvents(relayUrl, filters, timeoutMs);
      } catch (error) {
        if (isTemporaryRelayTransportUnavailableError(error)) {
          return [];
        }

        throw error;
      }
    },
    requestTemporaryLatestEvent: async (relayUrl, filters, timeoutMs) => {
      const coordinator = getRelayCoordinator();

      if (!coordinator) {
        return null;
      }

      try {
        return await coordinator.requestTemporaryLatestEvent(relayUrl, filters, timeoutMs);
      } catch (error) {
        if (isTemporaryRelayTransportUnavailableError(error)) {
          return null;
        }

        throw error;
      }
    },
  };
}

export function isTemporaryRelayTransportUnavailableError(error: unknown) {
  return error instanceof Error && (
    error.message === "relay is not connected"
    || error.message === "relay client が初期化されていません"
  );
}
