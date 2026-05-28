import { describe, expect, it } from "vitest";
import { pickComposerWelcomeMessage } from "./composerMessages";

describe("pickComposerWelcomeMessage", () => {
  it("returns the configured welcome message", () => {
    expect(pickComposerWelcomeMessage(() => 0)).toBe("Sabotenism :)");
  });

  it("clamps out-of-range random values", () => {
    expect(pickComposerWelcomeMessage(() => -1)).toBe("Sabotenism :)");
    expect(pickComposerWelcomeMessage(() => 2)).toBe("Sabotenism :)");
  });
});
