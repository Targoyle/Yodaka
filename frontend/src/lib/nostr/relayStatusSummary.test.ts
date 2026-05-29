import { describe, expect, it } from "vitest";
import { buildRoleAwareRelayStatus } from "./relayStatusSummary";
import type { RelayCoordinatorStatus } from "./relayCoordinator";

describe("buildRoleAwareRelayStatus", () => {
  it("read relay が未接続なら write relay が live でも live 扱いにしない", () => {
    const status: RelayCoordinatorStatus = {
      phase: "partial",
      relayCount: 2,
      readyRelayCount: 1,
      liveRelayCount: 1,
      relayStatuses: [
        {
          relayUrl: "wss://read.example/",
          phase: "reconnecting",
          attempt: 2,
        },
        {
          relayUrl: "wss://write.example/",
          phase: "live",
          attempt: 1,
        },
      ],
      detail: "1/2 relays live, others reconnecting",
    };

    expect(
      buildRoleAwareRelayStatus({
        readRelayUrls: ["wss://read.example/"],
        status,
        writeRelayUrls: ["wss://write.example/"],
      }),
    ).toMatchObject({
      phase: "offline",
      readyRelayCount: 0,
      liveRelayCount: 0,
      detail: "read 0/1 live / write 1/1 live",
    });
  });

  it("read relay が一部 live なら partial/degraded を read 基準で決める", () => {
    const status: RelayCoordinatorStatus = {
      phase: "partial",
      relayCount: 3,
      readyRelayCount: 2,
      liveRelayCount: 2,
      relayStatuses: [
        {
          relayUrl: "wss://read-a.example/",
          phase: "live",
          attempt: 1,
        },
        {
          relayUrl: "wss://read-b.example/",
          phase: "subscribing",
          attempt: 1,
        },
        {
          relayUrl: "wss://write.example/",
          phase: "live",
          attempt: 1,
        },
      ],
      detail: "2/3 relays live, others syncing",
    };

    expect(
      buildRoleAwareRelayStatus({
        readRelayUrls: ["wss://read-a.example/", "wss://read-b.example/"],
        status,
        writeRelayUrls: ["wss://write.example/"],
      }),
    ).toMatchObject({
      phase: "partial",
      readyRelayCount: 1,
      liveRelayCount: 1,
      detail: "read 1/2 live / write 1/1 live",
    });
  });
});
