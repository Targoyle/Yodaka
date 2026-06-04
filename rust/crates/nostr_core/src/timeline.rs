use std::cmp::Reverse;
use std::collections::{BTreeSet, HashMap};
use std::net::IpAddr;
#[cfg(not(target_arch = "wasm32"))]
use std::time::{SystemTime, UNIX_EPOCH};

use nostr::secp256k1::Secp256k1;
use nostr::{Event, JsonUtil, Kind};
use serde::{Deserialize, Serialize};

use crate::CoreError;

pub const SINCE_BUFFER_SEC: u64 = 15;
pub const MAX_FUTURE_SKEW_SEC: u64 = 600;
pub const MAX_EVENT_JSON_BYTES: usize = 64 * 1024;
pub const MAX_CONTENT_BYTES: usize = 8 * 1024;
pub const MAX_PROFILE_EVENT_CONTENT_BYTES: usize = 64 * 1024;
pub const MAX_TAGS: usize = 64;
pub const MAX_TAG_FIELDS_PER_TAG: usize = 16;
pub const MAX_TAG_VALUE_BYTES: usize = 256;
pub const MAX_METADATA_TAG_VALUE_BYTES: usize = 2 * 1024;
pub const MAX_STORED_FEED_EVENTS: usize = 5_000;
pub const MAX_STORED_PROFILES: usize = 2_000;
pub const MAX_STORED_REACTION_EVENTS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnsignedEvent {
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ProfileSummary {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub picture: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VerifiedProfileEventSummary {
    pub pubkey: String,
    pub event_id: String,
    pub created_at: u64,
    pub profile: ProfileSummary,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReactionSummary {
    pub content: String,
    pub count: u32,
}

#[derive(Debug, Clone)]
struct StoredEvent {
    id: String,
    pubkey: String,
    created_at: u64,
    safe_created_at: u64,
    kind: u32,
    tags: Vec<Vec<String>>,
    content: String,
}

#[derive(Debug, Clone)]
struct StoredProfile {
    event: StoredEvent,
    summary: ProfileSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelineItem {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u32,
    pub content: String,
    pub is_reply: bool,
    pub reply_target_event_id: Option<String>,
    pub reply_target_pubkey: Option<String>,
    pub reply_target_relay_hints: Vec<String>,
    pub reply_context_pubkeys: Vec<String>,
    pub like_count: u32,
    pub kusa_count: u32,
    pub more_reaction_count: u32,
    pub other_reaction_summaries: Vec<ReactionSummary>,
    pub profile: Option<ProfileSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SinceHint {
    pub since: Option<u64>,
    pub buffer_sec: u64,
}

#[derive(Debug, Default)]
pub struct Timeline {
    events: HashMap<String, StoredEvent>,
    feed_index: BTreeSet<(Reverse<u64>, String)>,
    thread_index: HashMap<String, Vec<String>>,
    profiles: HashMap<String, StoredProfile>,
    reaction_events: HashMap<String, StoredEvent>,
    reactions_by_target: HashMap<String, Vec<String>>,
    max_safe_feed_created_at: Option<u64>,
}

impl Timeline {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn verify_and_insert(&mut self, event_json: &str) -> Result<bool, CoreError> {
        let Some(event) = verify_event_impl(event_json)? else {
            return Ok(false);
        };

        match event.kind {
            Kind::Metadata => Ok(self.upsert_profile(StoredProfile::from_event(&event))),
            Kind::TextNote => Ok(self.insert_feed_event(StoredEvent::from_event(&event))),
            Kind::Reaction => Ok(self.insert_reaction_event(StoredEvent::from_event(&event))),
            _ => Ok(false),
        }
    }

    pub fn list_timeline(&self, limit: u32, until: Option<u64>) -> Vec<TimelineItem> {
        let mut items = Vec::new();
        let upper_bound = until.unwrap_or(u64::MAX);

        for (safe_created_at, event_id) in &self.feed_index {
            let safe_created_at = safe_created_at.0;

            if safe_created_at >= upper_bound {
                continue;
            }

            if let Some(event) = self.events.get(event_id) {
                let reply_context_pubkeys = self.reply_context_pubkeys_for_event(event);
                let reply_target_event_id = self.reply_target_event_id_for_event(event);
                let reply_target_pubkey =
                    self.reply_target_pubkey_for_event(event, &reply_context_pubkeys);
                let reply_target_relay_hints = self.reply_target_relay_hints_for_event(event);
                items.push(TimelineItem {
                    id: event.id.clone(),
                    pubkey: event.pubkey.clone(),
                    created_at: event.created_at,
                    kind: event.kind,
                    content: event.content.clone(),
                    is_reply: has_reply_context(event),
                    reply_target_event_id,
                    reply_target_pubkey,
                    reply_target_relay_hints,
                    reply_context_pubkeys,
                    like_count: self.like_count_for_event(&event.id),
                    kusa_count: self.kusa_count_for_event(&event.id),
                    more_reaction_count: self.more_reaction_count_for_event(&event.id),
                    other_reaction_summaries: self.other_reaction_summaries_for_event(&event.id),
                    profile: self.profile_for_pubkey(&event.pubkey),
                });
            }

            if items.len() >= limit as usize {
                break;
            }
        }

        items
    }

    pub fn since_hint(&self) -> SinceHint {
        let now = current_unix_timestamp();

        SinceHint {
            since: self
                .max_safe_feed_created_at
                .map(|value| value.min(now).saturating_sub(SINCE_BUFFER_SEC)),
            buffer_sec: SINCE_BUFFER_SEC,
        }
    }

    fn insert_feed_event(&mut self, event: StoredEvent) -> bool {
        if self.events.contains_key(&event.id) {
            return false;
        }

        let event_id = event.id.clone();

        if is_reply_event(&event) {
            if let Some(root_id) = find_root_id(&event) {
                self.thread_index
                    .entry(root_id)
                    .or_default()
                    .push(event_id.clone());
            }
        } else {
            self.feed_index
                .insert((Reverse(event.safe_created_at), event_id.clone()));
            self.max_safe_feed_created_at = Some(
                self.max_safe_feed_created_at
                    .map_or(event.safe_created_at, |current| {
                        current.max(event.safe_created_at)
                    }),
            );
        }

        self.events.insert(event_id, event);
        self.enforce_feed_event_limit();
        true
    }

    fn upsert_profile(&mut self, profile: StoredProfile) -> bool {
        let should_replace = match self.profiles.get(&profile.event.pubkey) {
            Some(existing) if existing.event.id == profile.event.id => return false,
            Some(existing) => existing.event.created_at < profile.event.created_at,
            None => true,
        };

        if !should_replace {
            return false;
        }

        self.profiles.insert(profile.event.pubkey.clone(), profile);
        self.enforce_profile_limit();
        true
    }

    fn insert_reaction_event(&mut self, event: StoredEvent) -> bool {
        if self.events.contains_key(&event.id) || self.reaction_events.contains_key(&event.id) {
            return false;
        }

        let Some(target_id) = find_reaction_target_id(&event) else {
            return false;
        };

        let event_id = event.id.clone();
        self.reaction_events.insert(event_id.clone(), event);
        self.reactions_by_target
            .entry(target_id)
            .or_default()
            .push(event_id);
        self.enforce_reaction_event_limit();
        true
    }

    fn enforce_feed_event_limit(&mut self) {
        while self.events.len() > MAX_STORED_FEED_EVENTS {
            let Some(event_id) = self.oldest_feed_event_id() else {
                break;
            };

            self.remove_feed_event(&event_id);
        }

        self.recompute_max_safe_feed_created_at();
    }

    fn enforce_profile_limit(&mut self) {
        while self.profiles.len() > MAX_STORED_PROFILES {
            let Some(pubkey) = self.oldest_profile_pubkey() else {
                break;
            };

            self.profiles.remove(&pubkey);
        }
    }

    fn enforce_reaction_event_limit(&mut self) {
        while self.reaction_events.len() > MAX_STORED_REACTION_EVENTS {
            let Some(event_id) = self.oldest_reaction_event_id() else {
                break;
            };

            self.remove_reaction_event(&event_id);
        }
    }

    fn oldest_feed_event_id(&self) -> Option<String> {
        self.events
            .values()
            .min_by_key(|event| (event.safe_created_at, event.id.as_str()))
            .map(|event| event.id.clone())
    }

    fn oldest_profile_pubkey(&self) -> Option<String> {
        self.profiles
            .values()
            .min_by_key(|profile| (profile.event.safe_created_at, profile.event.pubkey.as_str()))
            .map(|profile| profile.event.pubkey.clone())
    }

    fn oldest_reaction_event_id(&self) -> Option<String> {
        self.reaction_events
            .values()
            .min_by_key(|event| (event.safe_created_at, event.id.as_str()))
            .map(|event| event.id.clone())
    }

    fn remove_feed_event(&mut self, event_id: &str) {
        let Some(event) = self.events.remove(event_id) else {
            return;
        };

        self.feed_index
            .remove(&(Reverse(event.safe_created_at), event.id.clone()));
        let mut removed_target_ids = vec![event.id.clone()];

        if let Some(reply_ids) = self.thread_index.remove(event_id) {
            for reply_id in reply_ids {
                if self.events.remove(&reply_id).is_some() {
                    removed_target_ids.push(reply_id);
                }
            }
        }

        self.thread_index.retain(|_, reply_ids| {
            reply_ids.retain(|reply_id| reply_id != event_id && self.events.contains_key(reply_id));
            !reply_ids.is_empty()
        });

        for target_id in removed_target_ids {
            self.remove_reactions_for_target(&target_id);
        }
    }

    fn recompute_max_safe_feed_created_at(&mut self) {
        self.max_safe_feed_created_at = self
            .feed_index
            .iter()
            .next()
            .map(|(safe_created_at, _)| safe_created_at.0);
    }

    fn profile_for_pubkey(&self, pubkey: &str) -> Option<ProfileSummary> {
        self.profiles.get(pubkey).and_then(|profile| {
            if profile.summary.is_empty() {
                None
            } else {
                Some(profile.summary.clone())
            }
        })
    }

    fn like_count_for_event(&self, event_id: &str) -> u32 {
        self.reactions_by_target
            .get(event_id)
            .map(|reaction_ids| {
                reaction_ids
                    .iter()
                    .filter_map(|reaction_id| self.reaction_events.get(reaction_id))
                    .filter(|reaction| is_like_reaction_event(reaction))
                    .count() as u32
            })
            .unwrap_or(0)
    }

    fn kusa_count_for_event(&self, event_id: &str) -> u32 {
        self.reactions_by_target
            .get(event_id)
            .map(|reaction_ids| {
                reaction_ids
                    .iter()
                    .filter_map(|reaction_id| self.reaction_events.get(reaction_id))
                    .filter(|reaction| is_kusa_reaction_event(reaction))
                    .count() as u32
            })
            .unwrap_or(0)
    }

    fn more_reaction_count_for_event(&self, event_id: &str) -> u32 {
        self.reactions_by_target
            .get(event_id)
            .map(|reaction_ids| {
                reaction_ids
                    .iter()
                    .filter_map(|reaction_id| self.reaction_events.get(reaction_id))
                    .filter(|reaction| {
                        !is_like_reaction_event(reaction) && !is_kusa_reaction_event(reaction)
                    })
                    .count() as u32
            })
            .unwrap_or(0)
    }

    fn other_reaction_summaries_for_event(&self, event_id: &str) -> Vec<ReactionSummary> {
        let mut counts = self
            .reactions_by_target
            .get(event_id)
            .map(|reaction_ids| {
                reaction_ids
                    .iter()
                    .filter_map(|reaction_id| self.reaction_events.get(reaction_id))
                    .filter(|reaction| {
                        !is_like_reaction_event(reaction) && !is_kusa_reaction_event(reaction)
                    })
                    .fold(HashMap::<String, u32>::new(), |mut acc, reaction| {
                        *acc.entry(reaction.content.clone()).or_insert(0) += 1;
                        acc
                    })
            })
            .unwrap_or_default()
            .into_iter()
            .map(|(content, count)| ReactionSummary { content, count })
            .collect::<Vec<_>>();

        counts.sort_by(|left, right| {
            right
                .count
                .cmp(&left.count)
                .then_with(|| left.content.cmp(&right.content))
        });

        counts
    }

    fn reply_context_pubkeys_for_event(&self, event: &StoredEvent) -> Vec<String> {
        let mut candidates = Vec::new();

        for tag in &event.tags {
            if !tag.first().is_some_and(|value| value == "e") {
                continue;
            }

            push_reply_context_pubkey(
                &mut candidates,
                normalize_tagged_pubkey(tag.get(4).map(String::as_str)),
            );

            if let Some(referenced_event) =
                tag.get(1).and_then(|event_id| self.events.get(event_id))
            {
                push_reply_context_pubkey(&mut candidates, Some(referenced_event.pubkey.clone()));
            }
        }

        for tag in &event.tags {
            if !tag.first().is_some_and(|value| value == "p") {
                continue;
            }

            push_reply_context_pubkey(
                &mut candidates,
                normalize_tagged_pubkey(tag.get(1).map(String::as_str)),
            );
        }

        sort_reply_context_pubkeys(candidates, &event.pubkey)
    }

    fn reply_target_pubkey_for_event(
        &self,
        event: &StoredEvent,
        reply_context_pubkeys: &[String],
    ) -> Option<String> {
        let preferred_reply_p_target_pubkey = find_preferred_reply_p_target_pubkey(event);

        if let Some(reply_target_tag) = find_reply_target_event_tag(event) {
            if let Some(reply_target_pubkey) =
                normalize_tagged_pubkey(reply_target_tag.get(4).map(String::as_str))
            {
                if reply_target_pubkey != event.pubkey {
                    return Some(reply_target_pubkey);
                }
            }

            if let Some(referenced_event) = reply_target_tag
                .get(1)
                .and_then(|event_id| self.events.get(event_id))
            {
                if referenced_event.pubkey != event.pubkey {
                    return Some(referenced_event.pubkey.clone());
                }
            }

            if let Some(reply_target_pubkey) = preferred_reply_p_target_pubkey.clone() {
                return Some(reply_target_pubkey);
            }

            if let Some(reply_target_pubkey) =
                normalize_tagged_pubkey(reply_target_tag.get(4).map(String::as_str))
            {
                return Some(reply_target_pubkey);
            }

            if let Some(referenced_event) = reply_target_tag
                .get(1)
                .and_then(|event_id| self.events.get(event_id))
            {
                return Some(referenced_event.pubkey.clone());
            }
        }

        if let Some(reply_target_pubkey) = event
            .tags
            .iter()
            .find(|tag| {
                tag.first().is_some_and(|value| value == "p")
                    && tag.get(3).is_some_and(|marker| marker == "reply")
            })
            .and_then(|tag| normalize_tagged_pubkey(tag.get(1).map(String::as_str)))
        {
            return Some(reply_target_pubkey);
        }

        if let Some(reply_target_pubkey) = preferred_reply_p_target_pubkey {
            return Some(reply_target_pubkey);
        }

        prefer_non_self_reply_context_pubkey(reply_context_pubkeys, &event.pubkey)
    }

    fn reply_target_event_id_for_event(&self, event: &StoredEvent) -> Option<String> {
        find_reply_target_event_tag(event).and_then(|tag| tag.get(1).cloned())
    }

    fn reply_target_relay_hints_for_event(&self, event: &StoredEvent) -> Vec<String> {
        let mut relay_hints = Vec::new();

        let reply_target_tag = find_reply_target_event_tag(event);
        let root_tag = find_root_event_tag(event);

        if let Some(reply_target_tag) = reply_target_tag {
            push_reply_relay_hint(
                &mut relay_hints,
                reply_target_tag.get(2).map(String::as_str),
            );
        }

        if let Some(root_tag) = root_tag {
            if Some(root_tag) != reply_target_tag {
                push_reply_relay_hint(&mut relay_hints, root_tag.get(2).map(String::as_str));
            }
        }

        for tag in list_event_reference_tags(event) {
            push_reply_relay_hint(&mut relay_hints, tag.get(2).map(String::as_str));
        }

        relay_hints
    }

    fn remove_reaction_event(&mut self, event_id: &str) {
        let Some(event) = self.reaction_events.remove(event_id) else {
            return;
        };

        let Some(target_id) = find_reaction_target_id(&event) else {
            return;
        };

        let mut should_remove_target = false;

        if let Some(reaction_ids) = self.reactions_by_target.get_mut(&target_id) {
            reaction_ids.retain(|reaction_id| reaction_id != event_id);
            should_remove_target = reaction_ids.is_empty();
        }

        if should_remove_target {
            self.reactions_by_target.remove(&target_id);
        }
    }

    fn remove_reactions_for_target(&mut self, target_id: &str) {
        let Some(reaction_ids) = self.reactions_by_target.remove(target_id) else {
            return;
        };

        for reaction_id in reaction_ids {
            self.reaction_events.remove(&reaction_id);
        }
    }
}

pub fn verify_event(event_json: &str) -> Result<bool, CoreError> {
    Ok(verify_event_impl(event_json)?.is_some())
}

pub fn verify_profile_summary_event(
    event_json: &str,
) -> Result<Option<VerifiedProfileEventSummary>, CoreError> {
    let Some(event) = verify_profile_event_impl(event_json)? else {
        return Ok(None);
    };

    Ok(Some(VerifiedProfileEventSummary {
        pubkey: event.pubkey.to_hex(),
        event_id: event.id.to_hex(),
        created_at: event.created_at.as_u64(),
        profile: ProfileSummary::from_content(&event.content),
    }))
}

impl StoredEvent {
    fn from_event(event: &Event) -> Self {
        let raw_created_at = event.created_at.as_u64();

        Self {
            id: event.id.to_hex(),
            pubkey: event.pubkey.to_hex(),
            created_at: raw_created_at,
            safe_created_at: safe_created_at(raw_created_at),
            kind: event.kind.as_u16() as u32,
            tags: event
                .tags
                .iter()
                .map(|tag| tag.as_slice().to_vec())
                .collect(),
            content: event.content.clone(),
        }
    }
}

impl StoredProfile {
    fn from_event(event: &Event) -> Self {
        Self {
            event: StoredEvent::from_event(event),
            summary: ProfileSummary::from_content(&event.content),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct RawProfileSummary {
    name: Option<String>,
    display_name: Option<String>,
    picture: Option<String>,
}

impl ProfileSummary {
    fn from_content(content: &str) -> Self {
        serde_json::from_str::<RawProfileSummary>(content)
            .map(Self::from_raw)
            .unwrap_or_default()
    }

    fn from_raw(raw: RawProfileSummary) -> Self {
        Self {
            name: normalize_optional_string(raw.name),
            display_name: normalize_optional_string(raw.display_name),
            picture: sanitize_profile_picture_url(raw.picture),
        }
    }

    fn is_empty(&self) -> bool {
        self.name.is_none() && self.display_name.is_none() && self.picture.is_none()
    }
}

pub fn build_unsigned_event(
    pubkey: &str,
    content: &str,
    tags_json: &str,
    kind: u32,
) -> Result<String, CoreError> {
    if pubkey.is_empty() {
        return Err(CoreError::MissingPubkey);
    }

    if content.is_empty() && !kind_allows_empty_content(kind) {
        return Err(CoreError::MissingContent);
    }

    validate_content_limit(content)?;

    let tags: Vec<Vec<String>> =
        serde_json::from_str(tags_json).map_err(CoreError::InvalidTagsJson)?;

    validate_tag_matrix(&tags)?;

    let event = UnsignedEvent {
        pubkey: pubkey.to_owned(),
        created_at: current_unix_timestamp(),
        kind,
        tags,
        content: content.to_owned(),
    };

    serde_json::to_string(&event).map_err(CoreError::InvalidEventJson)
}

fn validate_verified_event_limits(event: &Event) -> Result<(), CoreError> {
    validate_content_limit(&event.content)?;

    if event.tags.len() > MAX_TAGS {
        return Err(CoreError::TooManyTags);
    }

    let max_tag_value_bytes = if event.kind == Kind::Metadata {
        MAX_METADATA_TAG_VALUE_BYTES
    } else {
        MAX_TAG_VALUE_BYTES
    };

    for tag in event.tags.iter() {
        if tag.len() > MAX_TAG_FIELDS_PER_TAG {
            return Err(CoreError::TooManyTagFields);
        }

        for value in tag.as_slice() {
            if value.as_bytes().len() > max_tag_value_bytes {
                return Err(CoreError::TagValueTooLarge);
            }
        }
    }

    Ok(())
}

fn validate_verified_profile_event_limits(event: &Event) -> Result<(), CoreError> {
    if event.content.as_bytes().len() > MAX_PROFILE_EVENT_CONTENT_BYTES {
        return Err(CoreError::ContentTooLarge);
    }

    if event.tags.len() > MAX_TAGS {
        return Err(CoreError::TooManyTags);
    }

    for tag in event.tags.iter() {
        if tag.len() > MAX_TAG_FIELDS_PER_TAG {
            return Err(CoreError::TooManyTagFields);
        }

        for value in tag.as_slice() {
            if value.as_bytes().len() > MAX_METADATA_TAG_VALUE_BYTES {
                return Err(CoreError::TagValueTooLarge);
            }
        }
    }

    Ok(())
}

pub(crate) fn validate_content_limit(content: &str) -> Result<(), CoreError> {
    if content.as_bytes().len() > MAX_CONTENT_BYTES {
        return Err(CoreError::ContentTooLarge);
    }

    Ok(())
}

pub(crate) fn validate_tag_matrix(tags: &[Vec<String>]) -> Result<(), CoreError> {
    if tags.len() > MAX_TAGS {
        return Err(CoreError::TooManyTags);
    }

    for tag in tags {
        if tag.len() > MAX_TAG_FIELDS_PER_TAG {
            return Err(CoreError::TooManyTagFields);
        }

        for value in tag {
            if value.as_bytes().len() > MAX_TAG_VALUE_BYTES {
                return Err(CoreError::TagValueTooLarge);
            }
        }
    }

    Ok(())
}

fn verify_event_impl(event_json: &str) -> Result<Option<Event>, CoreError> {
    if event_json.as_bytes().len() > MAX_EVENT_JSON_BYTES {
        return Ok(None);
    }

    let event = match Event::from_json(event_json) {
        Ok(event) => event,
        Err(_) => return Ok(None),
    };

    if !accepts_kind(event.kind.as_u16() as u32) {
        return Ok(None);
    }

    let secp = Secp256k1::verification_only();

    if event.verify_with_ctx(&secp).is_err() {
        return Ok(None);
    }

    if validate_verified_event_limits(&event).is_err() {
        return Ok(None);
    }

    Ok(Some(event))
}

fn verify_profile_event_impl(event_json: &str) -> Result<Option<Event>, CoreError> {
    if event_json.as_bytes().len() > MAX_EVENT_JSON_BYTES {
        return Ok(None);
    }

    let event = match Event::from_json(event_json) {
        Ok(event) => event,
        Err(_) => return Ok(None),
    };

    if event.kind != Kind::Metadata {
        return Ok(None);
    }

    let secp = Secp256k1::verification_only();

    if event.verify_with_ctx(&secp).is_err() {
        return Ok(None);
    }

    if validate_verified_profile_event_limits(&event).is_err() {
        return Ok(None);
    }

    Ok(Some(event))
}

fn accepts_kind(kind: u32) -> bool {
    matches!(kind, 0 | 1 | 7)
}

fn kind_allows_empty_content(kind: u32) -> bool {
    matches!(kind, 7)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();

        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn sanitize_profile_picture_url(value: Option<String>) -> Option<String> {
    let value = normalize_optional_string(value)?;
    let host = extract_https_host(&value)?;

    if is_disallowed_picture_host(host) {
        return None;
    }

    Some(value)
}

fn extract_https_host(value: &str) -> Option<&str> {
    let rest = value.strip_prefix("https://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest.get(..authority_end)?;

    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return None;
    }

    if authority.starts_with('[') {
        let closing = authority.find(']')?;
        let host = authority.get(1..closing)?;
        let suffix = authority.get(closing + 1..)?;

        if host.is_empty() {
            return None;
        }

        if !suffix.is_empty() && !suffix.starts_with(':') {
            return None;
        }

        return Some(host);
    }

    let host = authority.split(':').next()?;

    if host.is_empty() {
        return None;
    }

    Some(host)
}

fn is_disallowed_picture_host(host: &str) -> bool {
    let normalized = host.to_ascii_lowercase();

    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
    {
        return true;
    }

    normalized
        .parse::<IpAddr>()
        .is_ok_and(is_private_ip_address)
}

fn is_private_ip_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();

            octets[0] == 0
                || octets[0] == 10
                || octets[0] == 127
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
        }
        IpAddr::V6(address) => {
            address.is_unspecified()
                || address.is_loopback()
                || address.is_unique_local()
                || address.is_unicast_link_local()
        }
    }
}

fn safe_created_at(raw_created_at: u64) -> u64 {
    let now = current_unix_timestamp();
    let max_allowed = now.saturating_add(MAX_FUTURE_SKEW_SEC);
    raw_created_at.min(max_allowed)
}

fn current_unix_timestamp() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        return (js_sys::Date::now() / 1000.0).floor() as u64;
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs())
    }
}

fn is_reply_event(event: &StoredEvent) -> bool {
    event.tags.iter().any(|tag| {
        tag.first().is_some_and(|value| value == "e")
            && tag
                .get(3)
                .is_some_and(|marker| matches!(marker.as_str(), "reply" | "mention"))
    })
}

fn has_reply_context(event: &StoredEvent) -> bool {
    event.tags.iter().any(|tag| {
        tag.first()
            .is_some_and(|value| matches!(value.as_str(), "e" | "a"))
    })
}

fn find_reply_event_tag(event: &StoredEvent) -> Option<&Vec<String>> {
    event.tags.iter().find(|tag| {
        tag.first().is_some_and(|value| value == "e")
            && tag.get(3).is_some_and(|marker| marker == "reply")
    })
}

fn list_event_reference_tags(event: &StoredEvent) -> Vec<&Vec<String>> {
    event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|value| value == "e") && tag.get(1).is_some())
        .collect()
}

fn find_positional_reply_event_tag(event: &StoredEvent) -> Option<&Vec<String>> {
    let e_tags = list_event_reference_tags(event);

    match e_tags.len() {
        0 => None,
        1 => Some(e_tags[0]),
        2 => Some(e_tags[1]),
        _ => e_tags.last().copied(),
    }
}

fn find_reply_target_event_tag(event: &StoredEvent) -> Option<&Vec<String>> {
    find_reply_event_tag(event)
        .or_else(|| find_root_event_tag(event))
        .or_else(|| find_positional_reply_event_tag(event))
}

fn normalize_tagged_pubkey(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();

    if normalized.len() == 64
        && normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        Some(normalized)
    } else {
        None
    }
}

fn push_reply_context_pubkey(target: &mut Vec<String>, pubkey: Option<String>) {
    let Some(pubkey) = pubkey else {
        return;
    };

    if !target.contains(&pubkey) {
        target.push(pubkey);
    }
}

fn push_reply_relay_hint(target: &mut Vec<String>, relay_hint: Option<&str>) {
    let Some(relay_hint) = relay_hint else {
        return;
    };

    let trimmed = relay_hint.trim();

    if trimmed.is_empty() {
        return;
    }

    let relay_hint = trimmed.to_owned();

    if !target.contains(&relay_hint) {
        target.push(relay_hint);
    }
}

fn exclude_self_reply_context_pubkeys(pubkeys: Vec<String>, self_pubkey: &str) -> Vec<String> {
    let non_self_pubkeys: Vec<String> = pubkeys
        .iter()
        .filter(|pubkey| pubkey.as_str() != self_pubkey)
        .cloned()
        .collect();
    let self_pubkeys: Vec<String> = pubkeys
        .iter()
        .filter(|pubkey| pubkey.as_str() == self_pubkey)
        .cloned()
        .collect();

    [non_self_pubkeys, self_pubkeys].concat()
}

fn sort_reply_context_pubkeys(pubkeys: Vec<String>, self_pubkey: &str) -> Vec<String> {
    exclude_self_reply_context_pubkeys(pubkeys, self_pubkey)
}

fn prefer_non_self_reply_context_pubkey(pubkeys: &[String], self_pubkey: &str) -> Option<String> {
    pubkeys
        .iter()
        .find(|pubkey| pubkey.as_str() != self_pubkey)
        .cloned()
        .or_else(|| pubkeys.first().cloned())
}

fn find_preferred_reply_p_target_pubkey(event: &StoredEvent) -> Option<String> {
    let p_tags: Vec<String> = event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|value| value == "p"))
        .filter_map(|tag| normalize_tagged_pubkey(tag.get(1).map(String::as_str)))
        .collect();

    p_tags
        .iter()
        .find(|pubkey| pubkey.as_str() != event.pubkey)
        .cloned()
        .or_else(|| p_tags.first().cloned())
}

fn find_root_id(event: &StoredEvent) -> Option<String> {
    if let Some(root_tag) = find_root_event_tag(event) {
        return root_tag.get(1).cloned();
    }

    let e_tags = list_event_reference_tags(event);

    e_tags.first().and_then(|tag| tag.get(1).cloned())
}

fn find_root_event_tag(event: &StoredEvent) -> Option<&Vec<String>> {
    event.tags.iter().find(|tag| {
        tag.first().is_some_and(|value| value == "e")
            && tag.get(3).is_some_and(|marker| marker == "root")
    })
}

fn find_reaction_target_id(event: &StoredEvent) -> Option<String> {
    event
        .tags
        .iter()
        .rev()
        .find(|tag| tag.first().is_some_and(|value| value == "e"))
        .and_then(|tag| tag.get(1).cloned())
}

fn is_like_reaction_event(event: &StoredEvent) -> bool {
    matches!(event.content.as_str(), "" | "+")
}

fn is_kusa_reaction_event(event: &StoredEvent) -> bool {
    event.content == ":kusa:"
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, JsonUtil, Keys, Metadata, SecretKey, Tag, Timestamp, Url};

    use super::{
        MAX_CONTENT_BYTES, MAX_TAG_VALUE_BYTES, ReactionSummary, SINCE_BUFFER_SEC, Timeline,
        build_unsigned_event, current_unix_timestamp, sanitize_profile_picture_url, verify_event,
    };

    #[test]
    fn newer_profile_replaces_older_one() {
        let mut timeline = Timeline::new();
        let keys = test_keys("1111111111111111111111111111111111111111111111111111111111111111");

        let feed = EventBuilder::text_note("note")
            .custom_created_at(Timestamp::from_secs(100))
            .sign_with_keys(&keys)
            .expect("feed event should sign");
        let older = EventBuilder::metadata(&Metadata::new().name("old"))
            .custom_created_at(Timestamp::from_secs(10))
            .sign_with_keys(&keys)
            .expect("older profile should sign");
        let newer = EventBuilder::metadata(
            &Metadata::new()
                .name("new")
                .display_name("Newest Name")
                .picture(Url::parse("https://example.com/avatar.png").expect("url should parse")),
        )
        .custom_created_at(Timestamp::from_secs(200))
        .sign_with_keys(&keys)
        .expect("newer profile should sign");

        assert!(
            timeline
                .verify_and_insert(&feed.as_json())
                .expect("feed event should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&older.as_json())
                .expect("older profile should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&newer.as_json())
                .expect("newer profile should verify")
        );

        let hint = timeline.since_hint();
        assert_eq!(hint.since, Some(100_u64.saturating_sub(SINCE_BUFFER_SEC)));

        let items = timeline.list_timeline(10, None);
        assert_eq!(items.len(), 1);
        let profile = items[0].profile.clone().expect("profile should be joined");
        assert_eq!(profile.name.as_deref(), Some("new"));
        assert_eq!(profile.display_name.as_deref(), Some("Newest Name"));
        assert_eq!(
            profile.picture.as_deref(),
            Some("https://example.com/avatar.png")
        );
    }

    #[test]
    fn list_timeline_uses_descending_cursor() {
        let mut timeline = Timeline::new();
        let alice = test_keys("1111111111111111111111111111111111111111111111111111111111111111");
        let bob = test_keys("2222222222222222222222222222222222222222222222222222222222222222");

        let first = EventBuilder::text_note("first")
            .custom_created_at(Timestamp::from_secs(100))
            .sign_with_keys(&alice)
            .expect("first event should sign");
        let second = EventBuilder::text_note("second")
            .custom_created_at(Timestamp::from_secs(120))
            .sign_with_keys(&bob)
            .expect("second event should sign");

        assert!(
            timeline
                .verify_and_insert(&first.as_json())
                .expect("first event should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&second.as_json())
                .expect("second event should verify")
        );

        let all = timeline.list_timeline(10, None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, second.id.to_hex());
        assert!(all[0].profile.is_none());

        let paged = timeline.list_timeline(10, Some(120));
        assert_eq!(paged.len(), 1);
        assert_eq!(paged[0].id, first.id.to_hex());
    }

    #[test]
    fn invalid_signature_or_id_is_rejected() {
        let mut timeline = Timeline::new();
        let keys = test_keys("1111111111111111111111111111111111111111111111111111111111111111");
        let valid = EventBuilder::text_note("hello")
            .sign_with_keys(&keys)
            .expect("event should sign");
        let valid_json = valid.as_json();

        let mut invalid_id: serde_json::Value =
            serde_json::from_str(&valid_json).expect("valid json");
        invalid_id["content"] = serde_json::Value::String(String::from("tampered"));
        assert!(
            !timeline
                .verify_and_insert(&invalid_id.to_string())
                .expect("tampered id should not throw")
        );

        let mut invalid_sig: serde_json::Value =
            serde_json::from_str(&valid_json).expect("valid json");
        let signature = invalid_sig["sig"]
            .as_str()
            .expect("signature should be string");
        let replacement = if signature.ends_with('0') { '1' } else { '0' };
        let mut mutated = signature[..signature.len() - 1].to_owned();
        mutated.push(replacement);
        invalid_sig["sig"] = serde_json::Value::String(mutated);
        assert!(
            !timeline
                .verify_and_insert(&invalid_sig.to_string())
                .expect("tampered sig should not throw")
        );
        assert!(!verify_event(&invalid_sig.to_string()).expect("tampered sig should not verify"));
    }

    #[test]
    fn future_timestamp_does_not_push_since_hint_into_future() {
        let mut timeline = Timeline::new();
        let keys = test_keys("3333333333333333333333333333333333333333333333333333333333333333");
        let future_created_at = current_unix_timestamp().saturating_add(3_600);
        let event = EventBuilder::text_note("future")
            .custom_created_at(Timestamp::from_secs(future_created_at))
            .sign_with_keys(&keys)
            .expect("future event should sign");

        assert!(
            timeline
                .verify_and_insert(&event.as_json())
                .expect("future event should verify")
        );

        let now = current_unix_timestamp();
        let hint = timeline.since_hint();
        let since = hint.since.expect("since hint should exist");
        assert!(since <= now);
        assert!(since >= now.saturating_sub(SINCE_BUFFER_SEC + 1));
    }

    #[test]
    fn oversized_content_is_rejected() {
        let mut timeline = Timeline::new();
        let keys = test_keys("4444444444444444444444444444444444444444444444444444444444444444");
        let content = "x".repeat(MAX_CONTENT_BYTES + 1);
        let event = EventBuilder::text_note(content)
            .sign_with_keys(&keys)
            .expect("oversized event should sign");

        let result = timeline.verify_and_insert(&event.as_json());
        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn metadata_allows_larger_tag_values_than_feed_events() {
        let mut timeline = Timeline::new();
        let keys = test_keys("4545454545454545454545454545454545454545454545454545454545454545");
        let oversized_tag_value = "x".repeat(MAX_TAG_VALUE_BYTES + 1);

        let metadata = EventBuilder::metadata(&Metadata::new().name("large-meta"))
            .tag(Tag::parse(["i", oversized_tag_value.as_str()]).expect("tag should parse"))
            .sign_with_keys(&keys)
            .expect("metadata should sign");
        let feed = EventBuilder::text_note("hello")
            .sign_with_keys(&keys)
            .expect("feed should sign");
        let oversized_feed = EventBuilder::text_note("hello")
            .tag(Tag::parse(["i", oversized_tag_value.as_str()]).expect("tag should parse"))
            .sign_with_keys(&keys)
            .expect("oversized feed should sign");

        assert!(
            timeline
                .verify_and_insert(&metadata.as_json())
                .expect("metadata should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&feed.as_json())
                .expect("feed should verify")
        );
        assert_eq!(
            timeline.list_timeline(10, None)[0]
                .profile
                .clone()
                .expect("profile should be attached")
                .name
                .as_deref(),
            Some("large-meta")
        );

        let result = timeline.verify_and_insert(&oversized_feed.as_json());
        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn build_unsigned_event_serializes_tags() {
        let json = build_unsigned_event("alice", "hello", r#"[["e","root-id"]]"#, 1)
            .expect("unsigned event should serialize");

        assert!(json.contains(r#""pubkey":"alice""#));
        assert!(json.contains(r#""kind":1"#));
    }

    #[test]
    fn build_unsigned_event_allows_empty_reaction_content() {
        let json = build_unsigned_event("alice", "", r#"[["e","root-id"]]"#, 7)
            .expect("reaction event should allow empty content");

        assert!(json.contains(r#""kind":7"#));
        assert!(json.contains(r#""content":"""#));
    }

    #[test]
    fn reply_event_is_not_listed_in_feed() {
        let mut timeline = Timeline::new();
        let root_keys =
            test_keys("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let reply_keys =
            test_keys("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

        let root = EventBuilder::text_note("root")
            .custom_created_at(Timestamp::from_secs(100))
            .sign_with_keys(&root_keys)
            .expect("root should sign");
        let reply = EventBuilder::text_note_reply("reply", &root, None, None)
            .tag(Tag::parse(["e", &root.id.to_hex(), "", "reply"]).expect("tag should parse"))
            .custom_created_at(Timestamp::from_secs(110))
            .sign_with_keys(&reply_keys)
            .expect("reply should sign");

        assert!(
            timeline
                .verify_and_insert(&root.as_json())
                .expect("root should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&reply.as_json())
                .expect("reply should verify")
        );

        let items = timeline.list_timeline(10, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, root.id.to_hex());
    }

    #[test]
    fn root_only_reference_keeps_reply_context_in_snapshot() {
        let mut timeline = Timeline::new();
        let root_keys =
            test_keys("abababababababababababababababababababababababababababababababab");
        let reply_keys =
            test_keys("cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd");

        let root = EventBuilder::text_note("root")
            .custom_created_at(Timestamp::from_secs(100))
            .sign_with_keys(&root_keys)
            .expect("root should sign");
        let root_author = root.pubkey.to_hex();
        let reply = EventBuilder::text_note("reply")
            .tag(
                Tag::parse(["e", &root.id.to_hex(), "", "root", &root_author])
                    .expect("root tag should parse"),
            )
            .tag(Tag::parse(["p", &root_author]).expect("p tag should parse"))
            .custom_created_at(Timestamp::from_secs(110))
            .sign_with_keys(&reply_keys)
            .expect("reply should sign");

        assert!(
            timeline
                .verify_and_insert(&root.as_json())
                .expect("root should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&reply.as_json())
                .expect("reply should verify")
        );

        let items = timeline.list_timeline(10, None);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, reply.id.to_hex());
        assert!(items[0].is_reply);
        assert_eq!(
            items[0].reply_target_event_id.as_deref(),
            Some(root.id.to_hex().as_str())
        );
        assert_eq!(
            items[0].reply_target_pubkey.as_deref(),
            Some(root_author.as_str())
        );
        assert_eq!(items[0].reply_context_pubkeys, vec![root_author]);
    }

    #[test]
    fn single_positional_e_tag_is_treated_as_reply_target() {
        let mut timeline = Timeline::new();
        let reply_keys =
            test_keys("adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad");
        let reply_target_keys =
            test_keys("bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc");
        let reply_target_author = reply_target_keys.public_key().to_hex();
        let reply = EventBuilder::text_note("reply")
            .tag(
                Tag::parse([
                    "e",
                    "target-id",
                    "wss://relay.example/",
                    "",
                    &reply_target_author,
                ])
                .expect("reply tag should parse"),
            )
            .tag(Tag::parse(["p", &reply_target_author]).expect("p tag should parse"))
            .custom_created_at(Timestamp::from_secs(110))
            .sign_with_keys(&reply_keys)
            .expect("reply should sign");

        assert!(
            timeline
                .verify_and_insert(&reply.as_json())
                .expect("reply should verify")
        );

        let items = timeline.list_timeline(10, None);
        assert_eq!(items[0].reply_target_event_id.as_deref(), Some("target-id"));
        assert_eq!(
            items[0].reply_target_pubkey.as_deref(),
            Some(reply_target_author.as_str())
        );
        assert_eq!(
            items[0].reply_target_relay_hints,
            vec!["wss://relay.example/".to_owned()]
        );
    }

    #[test]
    fn second_positional_e_tag_is_treated_as_direct_reply_target() {
        let mut timeline = Timeline::new();
        let reply_keys =
            test_keys("cdadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad");
        let root_keys =
            test_keys("efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef");
        let reply_target_keys =
            test_keys("0101010101010101010101010101010101010101010101010101010101010101");
        let root_author = root_keys.public_key().to_hex();
        let reply_target_author = reply_target_keys.public_key().to_hex();
        let reply = EventBuilder::text_note("reply")
            .tag(
                Tag::parse(["e", "root-id", "wss://root.example/", "", &root_author])
                    .expect("root tag should parse"),
            )
            .tag(
                Tag::parse([
                    "e",
                    "reply-id-2",
                    "wss://reply.example/",
                    "",
                    &reply_target_author,
                ])
                .expect("reply tag should parse"),
            )
            .tag(Tag::parse(["p", &root_author]).expect("root p tag should parse"))
            .tag(Tag::parse(["p", &reply_target_author]).expect("reply p tag should parse"))
            .custom_created_at(Timestamp::from_secs(110))
            .sign_with_keys(&reply_keys)
            .expect("reply should sign");

        assert!(
            timeline
                .verify_and_insert(&reply.as_json())
                .expect("reply should verify")
        );

        let items = timeline.list_timeline(10, None);
        assert_eq!(
            items[0].reply_target_event_id.as_deref(),
            Some("reply-id-2")
        );
        assert_eq!(
            items[0].reply_target_pubkey.as_deref(),
            Some(reply_target_author.as_str())
        );
        assert_eq!(
            items[0].reply_target_relay_hints,
            vec![
                "wss://reply.example/".to_owned(),
                "wss://root.example/".to_owned(),
            ]
        );
    }

    #[test]
    fn last_positional_e_tag_is_treated_as_direct_reply_target_when_three_or_more_exist() {
        let mut timeline = Timeline::new();
        let reply_keys =
            test_keys("0202020202020202020202020202020202020202020202020202020202020202");
        let root_keys =
            test_keys("0303030303030303030303030303030303030303030303030303030303030303");
        let mention_keys =
            test_keys("0404040404040404040404040404040404040404040404040404040404040404");
        let reply_target_keys =
            test_keys("0505050505050505050505050505050505050505050505050505050505050505");
        let root_author = root_keys.public_key().to_hex();
        let mention_author = mention_keys.public_key().to_hex();
        let reply_target_author = reply_target_keys.public_key().to_hex();
        let reply = EventBuilder::text_note("reply")
            .tag(
                Tag::parse(["e", "root-id", "wss://root.example/", "", &root_author])
                    .expect("root tag should parse"),
            )
            .tag(
                Tag::parse([
                    "e",
                    "mention-id",
                    "wss://mention.example/",
                    "",
                    &mention_author,
                ])
                .expect("mention tag should parse"),
            )
            .tag(
                Tag::parse([
                    "e",
                    "reply-id-3",
                    "wss://reply.example/",
                    "",
                    &reply_target_author,
                ])
                .expect("reply tag should parse"),
            )
            .tag(Tag::parse(["p", &root_author]).expect("root p tag should parse"))
            .tag(Tag::parse(["p", &mention_author]).expect("mention p tag should parse"))
            .tag(Tag::parse(["p", &reply_target_author]).expect("reply p tag should parse"))
            .custom_created_at(Timestamp::from_secs(110))
            .sign_with_keys(&reply_keys)
            .expect("reply should sign");

        assert!(
            timeline
                .verify_and_insert(&reply.as_json())
                .expect("reply should verify")
        );

        let items = timeline.list_timeline(10, None);
        assert_eq!(
            items[0].reply_target_event_id.as_deref(),
            Some("reply-id-3")
        );
        assert_eq!(
            items[0].reply_target_pubkey.as_deref(),
            Some(reply_target_author.as_str())
        );
        assert_eq!(
            items[0].reply_target_relay_hints,
            vec![
                "wss://reply.example/".to_owned(),
                "wss://root.example/".to_owned(),
                "wss://mention.example/".to_owned(),
            ]
        );
    }

    #[test]
    fn reply_target_prefers_non_self_context_but_keeps_self_band() {
        let mut timeline = Timeline::new();
        let self_keys =
            test_keys("9090909090909090909090909090909090909090909090909090909090909090");
        let other_keys =
            test_keys("8181818181818181818181818181818181818181818181818181818181818181");

        let root = EventBuilder::text_note("root")
            .custom_created_at(Timestamp::from_secs(100))
            .sign_with_keys(&self_keys)
            .expect("root should sign");
        let self_author = root.pubkey.to_hex();
        let other_author = other_keys.public_key().to_hex();
        let reply = EventBuilder::text_note("reply")
            .tag(
                Tag::parse(["e", &root.id.to_hex(), "", "root", &self_author])
                    .expect("root tag should parse"),
            )
            .tag(Tag::parse(["p", &self_author]).expect("self p tag should parse"))
            .tag(Tag::parse(["p", &other_author]).expect("other p tag should parse"))
            .custom_created_at(Timestamp::from_secs(110))
            .sign_with_keys(&self_keys)
            .expect("reply should sign");

        assert!(
            timeline
                .verify_and_insert(&root.as_json())
                .expect("root should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&reply.as_json())
                .expect("reply should verify")
        );

        let items = timeline.list_timeline(10, None);
        assert_eq!(
            items[0].reply_target_event_id.as_deref(),
            Some(root.id.to_hex().as_str())
        );
        assert_eq!(
            items[0].reply_target_pubkey.as_deref(),
            Some(other_author.as_str())
        );
        assert_eq!(
            items[0].reply_context_pubkeys,
            vec![other_author, self_author]
        );
    }

    #[test]
    fn reactions_are_split_into_like_kusa_and_more_counts() {
        let mut timeline = Timeline::new();
        let note_keys =
            test_keys("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        let alice = test_keys("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
        let bob = test_keys("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
        let carol = test_keys("1212121212121212121212121212121212121212121212121212121212121212");
        let dave = test_keys("3434343434343434343434343434343434343434343434343434343434343434");
        let erin = test_keys("5656565656565656565656565656565656565656565656565656565656565656");
        let frank = test_keys("7878787878787878787878787878787878787878787878787878787878787878");

        let note = EventBuilder::text_note("root")
            .custom_created_at(Timestamp::from_secs(100))
            .sign_with_keys(&note_keys)
            .expect("note should sign");
        let empty_reaction = EventBuilder::reaction(&note, "")
            .custom_created_at(Timestamp::from_secs(110))
            .sign_with_keys(&alice)
            .expect("empty reaction should sign");
        let plus_reaction = EventBuilder::reaction(&note, "+")
            .custom_created_at(Timestamp::from_secs(120))
            .sign_with_keys(&bob)
            .expect("plus reaction should sign");
        let emoji_reaction = EventBuilder::reaction(&note, "🔥")
            .custom_created_at(Timestamp::from_secs(130))
            .sign_with_keys(&carol)
            .expect("emoji reaction should sign");
        let kusa_reaction = EventBuilder::reaction(&note, ":kusa:")
            .custom_created_at(Timestamp::from_secs(140))
            .sign_with_keys(&dave)
            .expect("kusa reaction should sign");
        let second_emoji_reaction = EventBuilder::reaction(&note, "🔥")
            .custom_created_at(Timestamp::from_secs(150))
            .sign_with_keys(&erin)
            .expect("second emoji reaction should sign");
        let rocket_reaction = EventBuilder::reaction(&note, "🚀")
            .custom_created_at(Timestamp::from_secs(160))
            .sign_with_keys(&frank)
            .expect("rocket reaction should sign");

        assert!(
            timeline
                .verify_and_insert(&note.as_json())
                .expect("note should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&empty_reaction.as_json())
                .expect("empty reaction should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&plus_reaction.as_json())
                .expect("plus reaction should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&emoji_reaction.as_json())
                .expect("emoji reaction should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&kusa_reaction.as_json())
                .expect("kusa reaction should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&second_emoji_reaction.as_json())
                .expect("second emoji reaction should verify")
        );
        assert!(
            timeline
                .verify_and_insert(&rocket_reaction.as_json())
                .expect("rocket reaction should verify")
        );

        let items = timeline.list_timeline(10, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].like_count, 2);
        assert_eq!(items[0].kusa_count, 1);
        assert_eq!(items[0].more_reaction_count, 3);
        assert_eq!(
            items[0].other_reaction_summaries,
            vec![
                ReactionSummary {
                    content: "🔥".to_owned(),
                    count: 2,
                },
                ReactionSummary {
                    content: "🚀".to_owned(),
                    count: 1,
                },
            ]
        );
    }

    #[test]
    fn unsafe_profile_picture_urls_are_filtered() {
        assert_eq!(
            sanitize_profile_picture_url(Some(String::from("https://cdn.example.com/a.png"))),
            Some(String::from("https://cdn.example.com/a.png"))
        );
        assert_eq!(
            sanitize_profile_picture_url(Some(String::from("/relative.png"))),
            None
        );
        assert_eq!(
            sanitize_profile_picture_url(Some(String::from("http://cdn.example.com/a.png"))),
            None
        );
        assert_eq!(
            sanitize_profile_picture_url(Some(String::from("https://127.0.0.1/a.png"))),
            None
        );
        assert_eq!(
            sanitize_profile_picture_url(Some(String::from("https://localhost/a.png"))),
            None
        );
    }

    fn test_keys(secret_key_hex: &str) -> Keys {
        let secret_key = SecretKey::from_hex(secret_key_hex).expect("secret key should parse");
        Keys::new(secret_key)
    }
}
