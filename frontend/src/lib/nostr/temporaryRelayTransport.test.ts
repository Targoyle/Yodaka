import { describe, expect, it, vi } from "vitest";
import { createTemporaryRelayTransport } from "./temporaryRelayTransport";

describe("createTemporaryRelayTransport", () => {
  it("coordinator 不在時は events を空配列で返す", async () => {
    const transport = createTemporaryRelayTransport(() => null);

    await expect(
      transport.requestTemporaryEvents?.("wss://yabu.me", [{ kinds: [1] }], 8_000),
    ).resolves.toEqual([]);
  });

  it("coordinator 不在時は latest event を null で返す", async () => {
    const transport = createTemporaryRelayTransport(() => null);

    await expect(
      transport.requestTemporaryLatestEvent?.("wss://yabu.me", [{ kinds: [3] }], 8_000),
    ).resolves.toBeNull();
  });

  it("未接続 relay のエラーは吸収する", async () => {
    const coordinator = {
      requestTemporaryEvents: vi.fn(async () => {
        throw new Error("relay is not connected");
      }),
      requestTemporaryLatestEvent: vi.fn(async () => {
        throw new Error("relay client が初期化されていません");
      }),
    };
    const transport = createTemporaryRelayTransport(
      () => coordinator as never,
    );

    await expect(
      transport.requestTemporaryEvents?.("wss://yabu.me", [{ kinds: [1] }], 8_000),
    ).resolves.toEqual([]);
    await expect(
      transport.requestTemporaryLatestEvent?.("wss://yabu.me", [{ kinds: [3] }], 8_000),
    ).resolves.toBeNull();
  });

  it("それ以外のエラーは再送出する", async () => {
    const coordinator = {
      requestTemporaryEvents: vi.fn(async () => {
        throw new Error("unexpected");
      }),
      requestTemporaryLatestEvent: vi.fn(async () => {
        throw new Error("unexpected");
      }),
    };
    const transport = createTemporaryRelayTransport(
      () => coordinator as never,
    );

    await expect(
      transport.requestTemporaryEvents?.("wss://yabu.me", [{ kinds: [1] }], 8_000),
    ).rejects.toThrow("unexpected");
    await expect(
      transport.requestTemporaryLatestEvent?.("wss://yabu.me", [{ kinds: [3] }], 8_000),
    ).rejects.toThrow("unexpected");
  });
});
