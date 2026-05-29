#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

DEFAULT_RELAYS = [
    "wss://yabu.me",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://r.kojira.io",
    "wss://srtrelay.c-stellar.net",
]
DEFAULT_TIMEOUT_SEC = 8.0
DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024
DEFAULT_OUTPUT_DIR = "tools/sampling/output/nevent-latest"
BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="指定 nevent / note / 64桁 hex の event を relay ごとに取得し、要約と raw JSON を出力する"
    )
    parser.add_argument(
        "--event",
        required=True,
        help="対象 event。nevent / note / 64桁 hex を指定",
    )
    parser.add_argument(
        "--relay",
        action="append",
        dest="relays",
        help="調査対象 relay。省略時は既定の 5 relay を使用。複数指定可",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SEC,
        help=f"各 relay の応答待ちタイムアウト秒 (default: {DEFAULT_TIMEOUT_SEC})",
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
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        help=f"出力先ディレクトリ (default: {DEFAULT_OUTPUT_DIR})",
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    event_id = parse_event_id(args.event)
    relay_urls = normalize_relay_urls(args.relays or DEFAULT_RELAYS)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    settled = await asyncio.gather(
        *[
            query_relay(
                relay_url=relay_url,
                event_id=event_id,
                timeout_sec=args.timeout,
                max_message_bytes=args.max_message_bytes,
            )
            for relay_url in relay_urls
        ],
        return_exceptions=True,
    )

    relay_results: dict[str, dict[str, Any]] = {}

    for relay_url, result in zip(relay_urls, settled, strict=True):
        if isinstance(result, Exception):
            relay_results[relay_url] = {
                "relay": relay_url,
                "status": "error",
                "error": str(result),
                "event": None,
            }
        else:
            relay_results[relay_url] = result

    latest_event = select_latest_event(relay_results)
    summary = {
        "requested_event": args.event,
        "event_id": event_id,
        "latest_event": summarize_event(latest_event),
        "relay_results": {
            relay: {
                "status": result["status"],
                "error": result["error"],
                "event": summarize_event(result["event"]),
            }
            for relay, result in relay_results.items()
        },
    }
    raw_payload = {
        "requested_event": args.event,
        "event_id": event_id,
        "relay_results": relay_results,
    }

    write_json(output_dir / "summary.json", summary)
    write_json(output_dir / "results.json", raw_payload)
    print_human_summary(summary)


async def query_relay(
    relay_url: str,
    event_id: str,
    timeout_sec: float,
    max_message_bytes: int,
) -> dict[str, Any]:
    subscription_id = f"yodaka-nevent-{uuid.uuid4().hex[:8]}"
    event: dict[str, Any] | None = None
    status = "timeout"
    error: str | None = None

    async with websockets.connect(
        relay_url,
        open_timeout=timeout_sec,
        max_size=None if max_message_bytes <= 0 else max_message_bytes,
    ) as websocket:
        await websocket.send(
            json.dumps(
                [
                    "REQ",
                    subscription_id,
                    {
                        "ids": [event_id],
                        "limit": 1,
                    },
                ],
                ensure_ascii=False,
            )
        )

        deadline = time.monotonic() + timeout_sec

        while True:
            remaining = deadline - time.monotonic()

            if remaining <= 0:
                break

            try:
                raw_message = await asyncio.wait_for(
                    websocket.recv(), timeout=remaining
                )
            except asyncio.TimeoutError:
                break
            except ConnectionClosed as exc:
                status = "closed"
                error = f"{exc.code}: {exc.reason}"
                break

            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                continue

            if not isinstance(message, list) or not message:
                continue

            message_type = message[0]

            if (
                message_type == "EVENT"
                and len(message) >= 3
                and message[1] == subscription_id
                and isinstance(message[2], dict)
            ):
                event = message[2]
                status = "found"
                continue

            if (
                message_type == "EOSE"
                and len(message) >= 2
                and message[1] == subscription_id
            ):
                status = "found" if event else "missing"
                break

            if (
                message_type == "CLOSED"
                and len(message) >= 2
                and message[1] == subscription_id
            ):
                status = "closed"
                error = message[2] if len(message) >= 3 else None
                break

        try:
            await websocket.send(
                json.dumps(["CLOSE", subscription_id], ensure_ascii=False)
            )
        except Exception:
            pass

    return {
        "relay": relay_url,
        "status": status,
        "error": error,
        "event": event,
    }


def parse_event_id(value: str) -> str:
    normalized = value.strip()

    if is_hex_event_id(normalized):
        return normalized.lower()

    human_readable, data = decode_bech32(normalized)

    if human_readable == "note":
        return data.hex()

    if human_readable != "nevent":
        raise ValueError("nevent / note / 64桁 hex のいずれかを指定してください")

    for tlv_type, payload in parse_tlv_stream(data):
        if tlv_type == 0 and len(payload) == 32:
            return payload.hex()

    raise ValueError("nevent から event id を取り出せませんでした")


def is_hex_event_id(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdefABCDEF" for char in value)


def decode_bech32(value: str) -> tuple[str, bytes]:
    if value.lower() != value and value.upper() != value:
        raise ValueError("mixed-case の bech32 は無効です")

    normalized = value.lower()
    separator_index = normalized.rfind("1")

    if separator_index <= 0 or separator_index + 7 > len(normalized):
        raise ValueError("bech32 の形式が不正です")

    human_readable = normalized[:separator_index]
    data_part = normalized[separator_index + 1 :]
    values = []

    for char in data_part:
        if char not in BECH32_CHARSET:
            raise ValueError("bech32 に無効な文字が含まれています")
        values.append(BECH32_CHARSET.index(char))

    if not verify_bech32_checksum(human_readable, values):
        raise ValueError("bech32 checksum が不正です")

    decoded = convert_bits(values[:-6], 5, 8, False)
    return human_readable, bytes(decoded)


def parse_tlv_stream(data: bytes) -> list[tuple[int, bytes]]:
    cursor = 0
    values: list[tuple[int, bytes]] = []

    while cursor + 2 <= len(data):
        tlv_type = data[cursor]
        tlv_length = data[cursor + 1]
        cursor += 2

        if cursor + tlv_length > len(data):
            raise ValueError("TLV length が不正です")

        values.append((tlv_type, data[cursor : cursor + tlv_length]))
        cursor += tlv_length

    if cursor != len(data):
        raise ValueError("TLV stream の終端が不正です")

    return values


def convert_bits(data: list[int], from_bits: int, to_bits: int, pad: bool) -> list[int]:
    accumulator = 0
    bits = 0
    result: list[int] = []
    max_value = (1 << to_bits) - 1
    max_accumulator = (1 << (from_bits + to_bits - 1)) - 1

    for value in data:
        if value < 0 or value >> from_bits:
            raise ValueError("convert_bits の入力値が不正です")

        accumulator = ((accumulator << from_bits) | value) & max_accumulator
        bits += from_bits

        while bits >= to_bits:
            bits -= to_bits
            result.append((accumulator >> bits) & max_value)

    if pad:
        if bits:
            result.append((accumulator << (to_bits - bits)) & max_value)
    elif bits >= from_bits or ((accumulator << (to_bits - bits)) & max_value):
        raise ValueError("convert_bits の終端処理が不正です")

    return result


def verify_bech32_checksum(human_readable: str, data: list[int]) -> bool:
    return bech32_polymod(bech32_hrp_expand(human_readable) + data) == 1


def bech32_hrp_expand(human_readable: str) -> list[int]:
    return (
        [ord(char) >> 5 for char in human_readable]
        + [0]
        + [ord(char) & 31 for char in human_readable]
    )


def bech32_polymod(values: list[int]) -> int:
    generator = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    checksum = 1

    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value

        for index, polynomial in enumerate(generator):
            if (top >> index) & 1:
                checksum ^= polynomial

    return checksum


def normalize_relay_urls(relay_urls: list[str]) -> list[str]:
    normalized = []
    seen = set()

    for relay_url in relay_urls:
        value = relay_url.strip()

        if not value or value in seen:
            continue

        normalized.append(value)
        seen.add(value)

    return normalized


def select_latest_event(
    relay_results: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    latest_event: dict[str, Any] | None = None

    for result in relay_results.values():
        event = result.get("event")

        if not isinstance(event, dict):
            continue

        if (
            not latest_event
            or int(event.get("created_at", 0)) > int(latest_event.get("created_at", 0))
            or (
                int(event.get("created_at", 0))
                == int(latest_event.get("created_at", 0))
                and str(event.get("id", "")) > str(latest_event.get("id", ""))
            )
        ):
            latest_event = event

    return latest_event


def summarize_event(event: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(event, dict):
        return None

    return {
        "id": event.get("id"),
        "pubkey": event.get("pubkey"),
        "created_at": event.get("created_at"),
        "kind": event.get("kind"),
        "tag_count": (
            len(event.get("tags", [])) if isinstance(event.get("tags"), list) else None
        ),
        "content_preview": str(event.get("content", ""))[:160],
    }


def write_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def print_human_summary(summary: dict[str, Any]) -> None:
    print(f"event id: {summary['event_id']}")
    latest = summary["latest_event"]
    if latest:
        print(
            "latest:",
            json.dumps(latest, ensure_ascii=False),
        )
    else:
        print("latest: not found")

    for relay_url, result in summary["relay_results"].items():
        print(
            f"- {relay_url}: {result['status']}",
            f"created_at={result['event']['created_at']}" if result["event"] else "",
            f"id={result['event']['id']}" if result["event"] else "",
            f"error={result['error']}" if result["error"] else "",
        )


if __name__ == "__main__":
    asyncio.run(main())
