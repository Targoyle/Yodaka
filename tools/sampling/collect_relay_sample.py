#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

DEFAULT_RELAY = "wss://yabu.me"
DEFAULT_KIND = 1
DEFAULT_LIMIT = 200
DEFAULT_TIMEOUT_SEC = 15.0
DEFAULT_FUTURE_SKEW_SEC = 600
DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024
DEFAULT_OUTPUT_DIR = "tools/sampling/output/latest"
DEFAULT_MAX_EXAMPLES = 10


@dataclass
class SampleStats:
    future_skew_sec: int
    max_examples: int
    seen_ids: set[str] = field(default_factory=set)
    message_counts: Counter[str] = field(default_factory=Counter)
    kind_counts: Counter[int] = field(default_factory=Counter)
    author_counts: Counter[str] = field(default_factory=Counter)
    notice_messages: list[str] = field(default_factory=list)
    total_events: int = 0
    duplicate_ids: int = 0
    future_events: int = 0
    max_event_json_bytes: int = 0
    max_content_bytes: int = 0
    max_tags: int = 0
    max_tag_fields_per_tag: int = 0
    oldest_created_at: int | None = None
    newest_created_at: int | None = None
    future_examples: list[dict[str, Any]] = field(default_factory=list)
    largest_content_examples: list[dict[str, Any]] = field(default_factory=list)
    largest_tag_examples: list[dict[str, Any]] = field(default_factory=list)

    def record_notice(self, message: str) -> None:
        if len(self.notice_messages) < self.max_examples:
            self.notice_messages.append(message)

    def record_event(self, event: dict[str, Any], event_json: str) -> None:
        self.total_events += 1
        self.max_event_json_bytes = max(
            self.max_event_json_bytes, len(event_json.encode("utf-8"))
        )

        event_id = str(event.get("id", "")).strip()
        if event_id:
            if event_id in self.seen_ids:
                self.duplicate_ids += 1
            else:
                self.seen_ids.add(event_id)

        pubkey = str(event.get("pubkey", "")).strip()
        if pubkey:
            self.author_counts[pubkey] += 1

        kind = event.get("kind")
        if isinstance(kind, int):
            self.kind_counts[kind] += 1

        created_at = event.get("created_at")
        if isinstance(created_at, int):
            self.oldest_created_at = (
                created_at
                if self.oldest_created_at is None
                else min(self.oldest_created_at, created_at)
            )
            self.newest_created_at = (
                created_at
                if self.newest_created_at is None
                else max(self.newest_created_at, created_at)
            )
            now = current_unix_ts()
            delta = created_at - now
            if delta > self.future_skew_sec:
                self.future_events += 1
                self._append_example(
                    self.future_examples,
                    {
                        "id": event_id,
                        "pubkey": shorten(pubkey),
                        "created_at": created_at,
                        "created_at_utc": to_iso8601_utc(created_at),
                        "future_delta_sec": delta,
                    },
                )

        content = event.get("content", "")
        if isinstance(content, str):
            content_bytes = len(content.encode("utf-8"))
            if content_bytes >= self.max_content_bytes:
                self.max_content_bytes = content_bytes
                self._append_example(
                    self.largest_content_examples,
                    {
                        "id": event_id,
                        "pubkey": shorten(pubkey),
                        "content_bytes": content_bytes,
                        "created_at": (
                            created_at if isinstance(created_at, int) else None
                        ),
                    },
                )

        tags = event.get("tags")
        if isinstance(tags, list):
            tag_count = len(tags)
            max_fields = max(
                (len(tag) for tag in tags if isinstance(tag, list)), default=0
            )
            if tag_count >= self.max_tags or max_fields >= self.max_tag_fields_per_tag:
                self.max_tags = max(self.max_tags, tag_count)
                self.max_tag_fields_per_tag = max(
                    self.max_tag_fields_per_tag, max_fields
                )
                self._append_example(
                    self.largest_tag_examples,
                    {
                        "id": event_id,
                        "pubkey": shorten(pubkey),
                        "tag_count": tag_count,
                        "max_fields_per_tag": max_fields,
                        "created_at": (
                            created_at if isinstance(created_at, int) else None
                        ),
                    },
                )

    def summary(self) -> dict[str, Any]:
        return {
            "total_events": self.total_events,
            "unique_event_ids": len(self.seen_ids),
            "duplicate_ids": self.duplicate_ids,
            "message_counts": dict(self.message_counts),
            "kind_counts": {
                str(kind): count for kind, count in self.kind_counts.items()
            },
            "unique_authors": len(self.author_counts),
            "top_authors": [
                {"pubkey": pubkey, "count": count}
                for pubkey, count in self.author_counts.most_common(10)
            ],
            "oldest_created_at": self.oldest_created_at,
            "oldest_created_at_utc": to_iso8601_utc(self.oldest_created_at),
            "newest_created_at": self.newest_created_at,
            "newest_created_at_utc": to_iso8601_utc(self.newest_created_at),
            "future_skew_sec": self.future_skew_sec,
            "future_events": self.future_events,
            "max_event_json_bytes": self.max_event_json_bytes,
            "max_content_bytes": self.max_content_bytes,
            "max_tags": self.max_tags,
            "max_tag_fields_per_tag": self.max_tag_fields_per_tag,
            "future_examples": self.future_examples,
            "largest_content_examples": self.largest_content_examples,
            "largest_tag_examples": self.largest_tag_examples,
            "notice_messages": self.notice_messages,
        }

    def _append_example(
        self, examples: list[dict[str, Any]], payload: dict[str, Any]
    ) -> None:
        if len(examples) < self.max_examples:
            examples.append(payload)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Nostr relay から raw event を収集して JSONL と要約 JSON を出力する"
    )
    parser.add_argument(
        "--relay",
        default=DEFAULT_RELAY,
        help=f"接続先 relay URL (default: {DEFAULT_RELAY})",
    )
    parser.add_argument(
        "--kind",
        dest="kinds",
        action="append",
        type=int,
        help=f"取得対象 kind。複数指定可 (default: {DEFAULT_KIND})",
    )
    parser.add_argument(
        "--author",
        dest="authors",
        action="append",
        help="取得対象 author pubkey hex。複数指定可",
    )
    parser.add_argument(
        "--since",
        type=int,
        default=None,
        help="REQ filter の since (UNIX 秒)",
    )
    parser.add_argument(
        "--until",
        type=int,
        default=None,
        help="REQ filter の until (UNIX 秒)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"REQ filter の limit (default: {DEFAULT_LIMIT})",
    )
    parser.add_argument(
        "--live-seconds",
        type=float,
        default=0.0,
        help="EOSE 後に live 受信を継続する秒数。0 なら EOSE で終了",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SEC,
        help=f"受信待ちタイムアウト秒 (default: {DEFAULT_TIMEOUT_SEC})",
    )
    parser.add_argument(
        "--future-skew-sec",
        type=int,
        default=DEFAULT_FUTURE_SKEW_SEC,
        help=f"future skew 判定に使う秒数 (default: {DEFAULT_FUTURE_SKEW_SEC})",
    )
    parser.add_argument(
        "--max-message-bytes",
        type=int,
        default=DEFAULT_MAX_MESSAGE_BYTES,
        help=(
            "websocket 受信フレーム上限。0 で無制限 "
            f"(default: {DEFAULT_MAX_MESSAGE_BYTES})"
        ),
    )
    parser.add_argument(
        "--max-examples",
        type=int,
        default=DEFAULT_MAX_EXAMPLES,
        help=f"summary に残す代表例の最大件数 (default: {DEFAULT_MAX_EXAMPLES})",
    )
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        help=f"出力先ディレクトリ (default: {DEFAULT_OUTPUT_DIR})",
    )
    return parser.parse_args()


def current_unix_ts() -> int:
    return int(time.time())


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_iso8601_utc(unix_ts: int | None) -> str | None:
    if unix_ts is None:
        return None
    return datetime.fromtimestamp(unix_ts, tz=timezone.utc).isoformat()


def shorten(value: str, head: int = 12) -> str:
    if len(value) <= head:
        return value
    return f"{value[:head]}..."


def ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def build_filter(args: argparse.Namespace) -> dict[str, Any]:
    filter_payload: dict[str, Any] = {
        "kinds": args.kinds or [DEFAULT_KIND],
        "limit": args.limit,
    }
    if args.authors:
        filter_payload["authors"] = [
            author.strip() for author in args.authors if author
        ]
    if args.since is not None:
        filter_payload["since"] = args.since
    if args.until is not None:
        filter_payload["until"] = args.until
    return filter_payload


async def collect_sample(args: argparse.Namespace) -> int:
    if args.limit <= 0:
        print("ERROR: --limit は 1 以上を指定してください。")
        return 1
    if args.timeout <= 0:
        print("ERROR: --timeout は 0 より大きい値を指定してください。")
        return 1
    if args.live_seconds < 0:
        print("ERROR: --live-seconds は 0 以上を指定してください。")
        return 1
    if args.future_skew_sec < 0:
        print("ERROR: --future-skew-sec は 0 以上を指定してください。")
        return 1

    output_dir = Path(args.output_dir)
    ensure_directory(output_dir)
    events_path = output_dir / "events.jsonl"
    summary_path = output_dir / "summary.json"

    filter_payload = build_filter(args)
    stats = SampleStats(
        future_skew_sec=args.future_skew_sec, max_examples=args.max_examples
    )
    subscription_id = f"sample-{uuid.uuid4().hex[:8]}"
    request_payload = ["REQ", subscription_id, filter_payload]
    started_at = utc_now_iso()
    finished_reason = "unknown"
    eose_received = False
    live_deadline: float | None = None

    max_size = None if args.max_message_bytes == 0 else args.max_message_bytes

    with events_path.open("w", encoding="utf-8") as events_file:
        try:
            async with websockets.connect(
                args.relay,
                open_timeout=args.timeout,
                close_timeout=args.timeout,
                max_size=max_size,
            ) as ws:
                await ws.send(json.dumps(request_payload, ensure_ascii=False))

                while True:
                    timeout = args.timeout
                    if live_deadline is not None:
                        remaining = live_deadline - time.monotonic()
                        if remaining <= 0:
                            finished_reason = "live_window_elapsed"
                            break
                        timeout = min(timeout, remaining)

                    try:
                        raw_message = await asyncio.wait_for(ws.recv(), timeout=timeout)
                    except asyncio.TimeoutError:
                        finished_reason = "timeout"
                        break

                    if not isinstance(raw_message, str):
                        stats.message_counts["BINARY"] += 1
                        continue

                    try:
                        message = json.loads(raw_message)
                    except json.JSONDecodeError:
                        stats.message_counts["INVALID_JSON"] += 1
                        continue

                    if not isinstance(message, list) or len(message) < 2:
                        stats.message_counts["INVALID_ENVELOPE"] += 1
                        continue

                    message_type = message[0]
                    stats.message_counts[str(message_type)] += 1

                    if (
                        message_type == "EVENT"
                        and len(message) >= 3
                        and message[1] == subscription_id
                        and isinstance(message[2], dict)
                    ):
                        event = message[2]
                        event_json = json.dumps(
                            event, ensure_ascii=False, separators=(",", ":")
                        )
                        stats.record_event(event, event_json)
                        events_file.write(event_json)
                        events_file.write("\n")
                        continue

                    if message_type == "NOTICE" and isinstance(message[1], str):
                        stats.record_notice(message[1])
                        continue

                    if message_type == "EOSE" and message[1] == subscription_id:
                        eose_received = True
                        if args.live_seconds <= 0:
                            finished_reason = "eose"
                            break
                        if live_deadline is None:
                            live_deadline = time.monotonic() + args.live_seconds
                        continue

                    if message_type == "CLOSED" and message[1] == subscription_id:
                        finished_reason = "closed"
                        if len(message) >= 3 and isinstance(message[2], str):
                            stats.record_notice(f"CLOSED: {message[2]}")
                        break

                try:
                    await ws.send(
                        json.dumps(["CLOSE", subscription_id], ensure_ascii=False)
                    )
                except ConnectionClosed:
                    pass
        except ConnectionClosed as error:
            finished_reason = f"connection_closed:{error.code}"
        except Exception as error:  # noqa: BLE001
            finished_reason = f"error:{type(error).__name__}"
            stats.record_notice(str(error))

    summary = {
        "relay": args.relay,
        "request_filter": filter_payload,
        "subscription_id": subscription_id,
        "started_at_utc": started_at,
        "finished_at_utc": utc_now_iso(),
        "finished_reason": finished_reason,
        "eose_received": eose_received,
        "live_seconds": args.live_seconds,
        "timeout_sec": args.timeout,
        "max_message_bytes": args.max_message_bytes,
        "output_files": {
            "events_jsonl": str(events_path),
            "summary_json": str(summary_path),
        },
        "stats": stats.summary(),
    }
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(f"relay: {args.relay}")
    print(f"output: {events_path}")
    print(f"summary: {summary_path}")
    print(
        "events:"
        f" total={summary['stats']['total_events']}"
        f" unique={summary['stats']['unique_event_ids']}"
        f" dup={summary['stats']['duplicate_ids']}"
        f" future={summary['stats']['future_events']}"
    )
    print(
        "max:"
        f" event_json={summary['stats']['max_event_json_bytes']}"
        f" content={summary['stats']['max_content_bytes']}"
        f" tags={summary['stats']['max_tags']}"
        f" tag_fields={summary['stats']['max_tag_fields_per_tag']}"
    )
    print(f"finished: {finished_reason}")
    return 0


def main() -> int:
    args = parse_args()
    return asyncio.run(collect_sample(args))


if __name__ == "__main__":
    raise SystemExit(main())
