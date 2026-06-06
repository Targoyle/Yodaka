import type { RelayOneShotTransport } from "./contacts";
import { RelayClient } from "./relay";
import type { RelayCoordinator } from "./relayCoordinator";

type RelayCoordinatorGetter = () => RelayCoordinator | null;

export function createTemporaryRelayTransport(
  getRelayCoordinator: RelayCoordinatorGetter,
): RelayOneShotTransport {
  const fallbackRelayClients = new Map<string, RelayClient>();

  function getOrCreateFallbackRelayClient(relayUrl: string) {
    const existing = fallbackRelayClients.get(relayUrl);

    if (existing) {
      return existing;
    }

    const client = new RelayClient({
      relayUrl,
      buildFeedFilters: async () => [],
      onEvent: async () => {},
    });

    fallbackRelayClients.set(relayUrl, client);
    client.connect();

    return client;
  }

  function releaseFallbackRelayClient(relayUrl: string) {
    const client = fallbackRelayClients.get(relayUrl);

    if (!client) {
      return;
    }

    client.close();
    fallbackRelayClients.delete(relayUrl);
  }

  return {
    requestTemporaryEvents: async (relayUrl, filters, timeoutMs) => {
      const coordinator = getRelayCoordinator();

      if (!coordinator) {
        return [];
      }

      if (!coordinator.hasRelayClient(relayUrl)) {
        try {
          return await getOrCreateFallbackRelayClient(relayUrl)
            .requestTemporaryEvents(filters, timeoutMs);
        } catch (error) {
          if (isTemporaryRelayTransportUnavailableError(error)) {
            return [];
          }

          throw error;
        }
      }

      releaseFallbackRelayClient(relayUrl);

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

      if (!coordinator.hasRelayClient(relayUrl)) {
        try {
          return await getOrCreateFallbackRelayClient(relayUrl)
            .requestTemporaryLatestEvent(filters, timeoutMs);
        } catch (error) {
          if (isTemporaryRelayTransportUnavailableError(error)) {
            return null;
          }

          throw error;
        }
      }

      releaseFallbackRelayClient(relayUrl);

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
