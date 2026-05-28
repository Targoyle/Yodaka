import { describe, expect, it } from "vitest";

import { shouldReplaceProfileSummaryVersion } from "./profilePresentation";

describe("shouldReplaceProfileSummaryVersion", () => {
  it("未記録なら新しい version を採用する", () => {
    expect(
      shouldReplaceProfileSummaryVersion(null, {
        createdAt: 100,
        eventId: "b",
      }),
    ).toBe(true);
  });

  it("createdAt が新しい version を優先する", () => {
    expect(
      shouldReplaceProfileSummaryVersion(
        {
          createdAt: 100,
          eventId: "z",
        },
        {
          createdAt: 101,
          eventId: "a",
        },
      ),
    ).toBe(true);
  });

  it("createdAt が古い version では上書きしない", () => {
    expect(
      shouldReplaceProfileSummaryVersion(
        {
          createdAt: 101,
          eventId: "a",
        },
        {
          createdAt: 100,
          eventId: "z",
        },
      ),
    ).toBe(false);
  });

  it("createdAt が同じなら event id で安定的に比較する", () => {
    expect(
      shouldReplaceProfileSummaryVersion(
        {
          createdAt: 100,
          eventId: "a",
        },
        {
          createdAt: 100,
          eventId: "b",
        },
      ),
    ).toBe(true);
    expect(
      shouldReplaceProfileSummaryVersion(
        {
          createdAt: 100,
          eventId: "b",
        },
        {
          createdAt: 100,
          eventId: "a",
        },
      ),
    ).toBe(false);
  });
});
