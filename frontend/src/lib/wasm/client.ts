import init, {
  build_unsigned_event,
  has_local_signer,
  local_signer_pubkey,
  login_with_nsec,
  list_timeline,
  logout_local_signer,
  reset_timeline,
  sign_unsigned_event_with_local_signer,
  since_hint,
  verify_event,
  verify_and_insert,
} from "@wasm/nostr_wasm.js";

export type UnsignedEvent = {
  pubkey: string;
  createdAt: number;
  kind: number;
  tags: string[][];
  content: string;
};

export type SignedEvent = UnsignedEvent & {
  id: string;
  sig: string;
};

export type TimelineItem = {
  id: string;
  pubkey: string;
  createdAt: number;
  kind: number;
  content: string;
  isReply: boolean;
  replyTargetPubkey: string | null;
  replyTargetProfile: TimelineProfile | null;
  replyContextPubkeys: string[];
  likeCount: number;
  profile: TimelineProfile | null;
  notifyActorPubkey?: string | null;
  notifyActorProfile?: TimelineProfile | null;
  notifyReactionContent?: string | null;
  notifyTargetEventId?: string | null;
};

export type TimelineProfile = {
  name: string | null;
  displayName: string | null;
  picture: string | null;
};

export type SinceHint = {
  since: number | null;
  bufferSec: number;
};

let initializePromise: Promise<void> | null = null;

export async function initializeWasm() {
  if (!initializePromise) {
    initializePromise = init();
  }

  return initializePromise;
}

export async function buildUnsignedEvent(args: {
  pubkey: string;
  content: string;
  kind: number;
  tags: string[][];
}): Promise<UnsignedEvent> {
  await initializeWasm();
  const json = build_unsigned_event(
    args.pubkey,
    args.content,
    JSON.stringify(args.tags),
    args.kind,
  );

  return parseUnsignedEvent(json);
}

export async function loginWithNsec(nsec: string) {
  await initializeWasm();
  return login_with_nsec(nsec);
}

export async function hasLocalSigner() {
  await initializeWasm();
  return has_local_signer();
}

export async function localSignerPubkey(): Promise<string | null> {
  await initializeWasm();
  return local_signer_pubkey() ?? null;
}

export async function signUnsignedEventWithLocalSigner(unsignedEvent: UnsignedEvent) {
  await initializeWasm();
  const json = sign_unsigned_event_with_local_signer(
    JSON.stringify({
      pubkey: unsignedEvent.pubkey,
      created_at: unsignedEvent.createdAt,
      kind: unsignedEvent.kind,
      tags: unsignedEvent.tags,
      content: unsignedEvent.content,
    }),
  );

  return parseSignedEvent(json);
}

export async function signUnsignedEventWithLocalSignerRawJson(
  unsignedEventJson: string,
) {
  await initializeWasm();
  return sign_unsigned_event_with_local_signer(unsignedEventJson);
}

export async function logoutLocalSigner() {
  await initializeWasm();
  logout_local_signer();
}

export async function verifyAndInsert(event: SignedEvent) {
  return verifyAndInsertRawJson(
    JSON.stringify({
      pubkey: event.pubkey,
      created_at: event.createdAt,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      id: event.id,
      sig: event.sig,
    }),
  );
}

export async function verifyAndInsertRawJson(eventJson: string) {
  await initializeWasm();

  return verify_and_insert(eventJson);
}

export async function verifySignedEvent(event: SignedEvent) {
  await initializeWasm();

  return verify_event(
    JSON.stringify({
      pubkey: event.pubkey,
      created_at: event.createdAt,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      id: event.id,
      sig: event.sig,
    }),
  );
}

export async function listTimeline(limit: number, until: number | null) {
  await initializeWasm();
  const json = list_timeline(limit, until ?? undefined);
  const parsed = JSON.parse(json) as Array<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    content: string;
    is_reply: boolean;
    reply_target_pubkey?: string | null;
    reply_target_profile?: {
      name: string | null;
      display_name: string | null;
      picture: string | null;
    } | null;
    reply_context_pubkeys?: string[];
    like_count?: number;
    profile?: {
      name: string | null;
      display_name: string | null;
      picture: string | null;
    } | null;
  }>;

  return parsed.map((item) => ({
    id: item.id,
    pubkey: item.pubkey,
    createdAt: item.created_at,
    kind: item.kind,
    content: item.content,
    isReply: item.is_reply,
    replyTargetPubkey: item.reply_target_pubkey ?? null,
    replyTargetProfile: item.reply_target_profile
      ? {
          name: item.reply_target_profile.name,
          displayName: item.reply_target_profile.display_name,
          picture: item.reply_target_profile.picture,
        }
      : null,
    replyContextPubkeys: item.reply_context_pubkeys ?? [],
    likeCount: item.like_count ?? 0,
    profile: item.profile
      ? {
          name: item.profile.name,
          displayName: item.profile.display_name,
          picture: item.profile.picture,
        }
      : null,
  })) as TimelineItem[];
}

export async function sinceHint(): Promise<SinceHint> {
  await initializeWasm();
  const json = since_hint();
  const parsed = JSON.parse(json) as {
    since: number | null;
    buffer_sec: number;
  };

  return {
    since: parsed.since,
    bufferSec: parsed.buffer_sec,
  };
}

export function resetTimeline() {
  reset_timeline();
}

function parseUnsignedEvent(json: string): UnsignedEvent {
  const parsed = JSON.parse(json) as {
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
  };

  return {
    pubkey: parsed.pubkey,
    createdAt: parsed.created_at,
    kind: parsed.kind,
    tags: parsed.tags,
    content: parsed.content,
  };
}

function parseSignedEvent(json: string): SignedEvent {
  const parsed = JSON.parse(json) as {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  };

  return {
    id: parsed.id,
    pubkey: parsed.pubkey,
    createdAt: parsed.created_at,
    kind: parsed.kind,
    tags: parsed.tags,
    content: parsed.content,
    sig: parsed.sig,
  };
}
