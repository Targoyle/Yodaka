import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAuxiliaryTimeline } from "./timelinePresentation";
import type { TimelineItem } from "../wasm/client";
import type { NostrEvent } from "./relay";

// NIP-10 reply 解決の共有コーパス。frontend (timelinePresentation.ts) と
// rust (nostr_core/timeline.rs) の双方が同一の入出力に従うことを pin する。
// 期待値を変える場合は fixtures/reply_resolution.json を直し、両言語のテストを再実行すること。
type CorpusCase = {
  name: string;
  context: { id: string; pubkey: string }[];
  subject: {
    id: string;
    pubkey: string;
    kind: number;
    tags: string[][];
    content: string;
  };
  expected: {
    isReply: boolean;
    replyTargetEventId: string | null;
    replyTargetPubkey: string | null;
    replyTargetRelayHints: string[];
    replyContextPubkeys: string[];
  };
};

const corpusPath = fileURLToPath(
  new URL("../../../../fixtures/reply_resolution.json", import.meta.url),
);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  cases: CorpusCase[];
};

function referenceItem(id: string, pubkey: string): TimelineItem {
  return {
    id,
    pubkey,
    createdAt: 1,
    kind: 1,
    content: "",
    isReply: false,
    replyTargetPubkey: null,
    replyTargetProfile: null,
    replyContextPubkeys: [],
    likeCount: 0,
    profile: null,
  };
}

describe("reply resolution corpus (shared with rust nostr_core)", () => {
  it("has cases to verify", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of corpus.cases) {
    it(testCase.name, () => {
      const event: NostrEvent = {
        id: testCase.subject.id,
        pubkey: testCase.subject.pubkey,
        created_at: 0,
        kind: testCase.subject.kind,
        tags: testCase.subject.tags,
        content: testCase.subject.content,
        sig: "sig",
      };

      const [item] = buildAuxiliaryTimeline({
        events: [event],
        profileSummaries: new Map(),
        referenceItems: testCase.context.map((entry) =>
          referenceItem(entry.id, entry.pubkey),
        ),
        timelineLimit: 50,
      });

      expect(item).toBeDefined();
      expect(item?.isReply).toBe(testCase.expected.isReply);
      expect(item?.replyTargetEventId ?? null).toBe(
        testCase.expected.replyTargetEventId,
      );
      expect(item?.replyTargetPubkey ?? null).toBe(
        testCase.expected.replyTargetPubkey,
      );
      expect(item?.replyTargetRelayHints ?? []).toEqual(
        testCase.expected.replyTargetRelayHints,
      );
      expect(item?.replyContextPubkeys ?? []).toEqual(
        testCase.expected.replyContextPubkeys,
      );
    });
  }
});
