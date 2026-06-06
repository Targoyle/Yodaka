import { describe, expect, it } from "vitest";
import { pickComposerWelcomeMessage } from "./composerMessages";

describe("pickComposerWelcomeMessage", () => {
  it("returns the default welcome message within the 0.9 range", () => {
    expect(pickComposerWelcomeMessage(() => 0)).toBe("Sabotenism :)");
    expect(pickComposerWelcomeMessage(() => 0.899999)).toBe("Sabotenism :)");
  });

  it("returns the alternate welcome message within the 0.1 range", () => {
    expect(pickComposerWelcomeMessage(() => 0.9)).toBe("Are You Sabotenic Yet?");
    expect(pickComposerWelcomeMessage(() => 0.999999)).toBe("Are You Sabotenic Yet?");
  });

  it("clamps out-of-range random values", () => {
    expect(pickComposerWelcomeMessage(() => -1)).toBe("Sabotenism :)");
    expect(pickComposerWelcomeMessage(() => 2)).toBe("Are You Sabotenic Yet?");
  });
});
