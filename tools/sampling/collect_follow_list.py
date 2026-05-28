#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import re
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
DEFAULT_OUTPUT_DIR = "tools/sampling/output/follow-list-latest"
BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
HEX_PUBKEY_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "指定 pubkey の kind 3 follow list と kind 10002 relay list を relay ごとに取得し、"
            "要約と raw JSON を出力する"
        )
    )
    parser.add_argument(
        "--pubkey",
        required=True,
        help="対象 pubkey。64 桁 hex または npub を指定",
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
        "--discover-from-10002",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "初回に取得した kind 10002 の relay list をもとに "
            "追加 relay でも kind 3 を探索する (default: true)"
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
    pubkey_hex = parse_pubkey(args.pubkey)
    initial_relays = normalize_relay_urls(args.relays or DEFAULT_RELAYS)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    initial_results = await collect_results(
        relay_urls=initial_relays,
        pubkey_hex=pubkey_hex,
        timeout_sec=args.timeout,
        max_message_bytes=args.max_message_bytes,
    )

    discovered_relays = extract_discovered_relays(initial_results)
    additional_relays = []

    if args.discover_from_10002:
        additional_relays = [
            relay for relay in discovered_relays if relay not in set(initial_relays)
        ]

    discovered_results: dict[str, dict[str, Any]] = {}

    if additional_relays:
        discovered_results = await collect_results(
            relay_urls=additional_relays,
            pubkey_hex=pubkey_hex,
            timeout_sec=args.timeout,
            max_message_bytes=args.max_message_bytes,
            collect_kinds=(3,),
        )

    merged_results = merge_results(initial_results, discovered_results)
    latest_kind3 = select_latest_event(merged_results, 3)
    latest_kind10002 = select_latest_event(merged_results, 10002)

    follow_entries = (
        extract_follow_entries(latest_kind3["event"]["tags"]) if latest_kind3 else []
    )
    relay_list = (
        extract_kind10002_relays(latest_kind10002["event"]["tags"])
        if latest_kind10002
        else {"all": [], "read": [], "write": []}
    )

    summary = {
        "pubkey_hex": pubkey_hex,
        "requested_pubkey": args.pubkey,
        "initial_relays": initial_relays,
        "discovered_relays_from_10002": discovered_relays,
        "additional_relays_queried": additional_relays,
        "latest_kind3": summarize_selected_event(latest_kind3),
        "latest_kind3_follow_count": len(follow_entries),
        "latest_kind3_follow_examples": follow_entries[:20],
        "latest_kind10002": summarize_selected_event(latest_kind10002),
        "latest_kind10002_relays": relay_list,
        "relay_results": build_relay_summary(merged_results),
    }

    raw_payload = {
        "pubkey_hex": pubkey_hex,
        "requested_pubkey": args.pubkey,
        "results": merged_results,
    }

    write_json(output_dir / "summary.json", summary)
    write_json(output_dir / "results.json", raw_payload)
    print_human_summary(summary)


async def collect_results(
    relay_urls: list[str],
    pubkey_hex: str,
    timeout_sec: float,
    max_message_bytes: int,
    collect_kinds: tuple[int, ...] = (3, 10002),
) -> dict[str, dict[str, Any]]:
    settled = await asyncio.gather(
        *[
            query_relay(
                relay_url=relay_url,
                pubkey_hex=pubkey_hex,
                timeout_sec=timeout_sec,
                max_message_bytes=max_message_bytes,
                kinds=collect_kinds,
            )
            for relay_url in relay_urls
        ],
        return_exceptions=True,
    )

    results: dict[str, dict[str, Any]] = {}

    for relay_url, result in zip(relay_urls, settled, strict=True):
        if isinstance(result, Exception):
            results[relay_url] = {
                "relay": relay_url,
                "kind3": {
                    "status": "error",
                    "error": str(result),
                    "event": None,
                },
                "kind10002": {
                    "status": "error",
                    "error": str(result),
                    "event": None,
                },
            }
            continue

        results[relay_url] = result

    return results


async def query_relay(
    relay_url: str,
    pubkey_hex: str,
    timeout_sec: float,
    max_message_bytes: int,
    kinds: tuple[int, ...],
) -> dict[str, Any]:
    results = {
        "relay": relay_url,
        "kind3": {"status": "skipped", "error": None, "event": None},
        "kind10002": {"status": "skipped", "error": None, "event": None},
    }

    if 3 in kinds:
        results["kind3"] = await request_latest_replaceable_event(
            relay_url=relay_url,
            pubkey_hex=pubkey_hex,
            kind=3,
            timeout_sec=timeout_sec,
            max_message_bytes=max_message_bytes,
        )

    if 10002 in kinds:
        results["kind10002"] = await request_latest_replaceable_event(
            relay_url=relay_url,
            pubkey_hex=pubkey_hex,
            kind=10002,
            timeout_sec=timeout_sec,
            max_message_bytes=max_message_bytes,
        )

    return results


async def request_latest_replaceable_event(
    relay_url: str,
    pubkey_hex: str,
    kind: int,
    timeout_sec: float,
    max_message_bytes: int,
) -> dict[str, Any]:
    subscription_id = create_subscription_id()
    ws_max_size = None if max_message_bytes <= 0 else max_message_bytes
    latest_event: dict[str, Any] | None = None

    try:
        async with websockets.connect(relay_url, max_size=ws_max_size) as websocket:
            req = [
                "REQ",
                subscription_id,
                {"kinds": [kind], "authors": [pubkey_hex], "limit": 1},
            ]
            await websocket.send(json.dumps(req, ensure_ascii=False))

            while True:
                try:
                    raw_message = await asyncio.wait_for(
                        websocket.recv(),
                        timeout=timeout_sec,
                    )
                except asyncio.TimeoutError:
                    return {
                        "status": "timeout",
                        "error": f"kind {kind} の応答がタイムアウトしました",
                        "event": latest_event,
                    }

                if not isinstance(raw_message, str):
                    continue

                try:
                    message = json.loads(raw_message)
                except json.JSONDecodeError:
                    continue

                if not isinstance(message, list) or len(message) < 2:
                    continue

                message_type = message[0]

                if message_type == "EVENT" and len(message) >= 3:
                    incoming_subscription_id = message[1]
                    event = message[2]

                    if incoming_subscription_id != subscription_id:
                        continue

                    if not is_matching_replaceable_event(event, pubkey_hex, kind):
                        continue

                    if (
                        latest_event is None
                        or event["created_at"] >= latest_event["created_at"]
                    ):
                        latest_event = event
                    continue

                if message_type in {"EOSE", "CLOSED"} and message[1] == subscription_id:
                    await websocket.send(json.dumps(["CLOSE", subscription_id]))
                    return {
                        "status": "found" if latest_event is not None else "missing",
                        "error": None,
                        "event": latest_event,
                    }

                if message_type == "NOTICE" and len(message) >= 2:
                    continue

    except ConnectionClosed as error:
        return {
            "status": "closed",
            "error": f"kind {kind} 取得中に relay から切断されました: {error}",
            "event": latest_event,
        }
    except OSError as error:
        return {
            "status": "error",
            "error": f"kind {kind} の接続に失敗しました: {error}",
            "event": latest_event,
        }

    return {
        "status": "found" if latest_event is not None else "missing",
        "error": None,
        "event": latest_event,
    }


def is_matching_replaceable_event(
    event: Any,
    pubkey_hex: str,
    kind: int,
) -> bool:
    if not isinstance(event, dict):
        return False

    if event.get("kind") != kind:
        return False

    if event.get("pubkey") != pubkey_hex:
        return False

    return isinstance(event.get("created_at"), int)


def select_latest_event(
    relay_results: dict[str, dict[str, Any]],
    kind: int,
) -> dict[str, Any] | None:
    key = "kind3" if kind == 3 else "kind10002"
    selected: dict[str, Any] | None = None

    for relay_url, result in relay_results.items():
        event = result[key].get("event")

        if not isinstance(event, dict):
            continue

        candidate = {"relay": relay_url, "event": event}

        if selected is None or event["created_at"] > selected["event"]["created_at"]:
            selected = candidate

    return selected


def extract_follow_entries(tags: Any) -> list[dict[str, Any]]:
    if not isinstance(tags, list):
        return []

    follows: list[dict[str, Any]] = []

    for tag in tags:
        if not isinstance(tag, list) or len(tag) < 2 or tag[0] != "p":
            continue

        pubkey = str(tag[1]).strip()
        relay_hint = normalize_relay_url(tag[2] if len(tag) >= 3 else "")
        petname = str(tag[3]).strip() if len(tag) >= 4 else ""

        if not pubkey:
            continue

        follows.append(
            {
                "pubkey": pubkey,
                "relay_hint": relay_hint,
                "petname": petname or None,
            }
        )

    return follows


def extract_kind10002_relays(tags: Any) -> dict[str, list[str]]:
    all_relays: set[str] = set()
    read_relays: set[str] = set()
    write_relays: set[str] = set()

    if not isinstance(tags, list):
        return {"all": [], "read": [], "write": []}

    for tag in tags:
        if not isinstance(tag, list) or len(tag) < 2 or tag[0] != "r":
            continue

        relay_url = normalize_relay_url(tag[1])

        if not relay_url:
            continue

        mode = str(tag[2]).strip().lower() if len(tag) >= 3 else ""
        all_relays.add(relay_url)

        if mode == "read":
            read_relays.add(relay_url)
        elif mode == "write":
            write_relays.add(relay_url)
        else:
            read_relays.add(relay_url)
            write_relays.add(relay_url)

    return {
        "all": sorted(all_relays),
        "read": sorted(read_relays),
        "write": sorted(write_relays),
    }


def extract_discovered_relays(
    relay_results: dict[str, dict[str, Any]],
) -> list[str]:
    latest_kind10002 = select_latest_event(relay_results, 10002)

    if latest_kind10002 is None:
        return []

    return extract_kind10002_relays(latest_kind10002["event"]["tags"])["all"]


def build_relay_summary(
    relay_results: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []

    for relay_url, result in relay_results.items():
        summary.append(
            {
                "relay": relay_url,
                "kind3": summarize_relay_result(result["kind3"]),
                "kind10002": summarize_relay_result(result["kind10002"]),
            }
        )

    return summary


def summarize_relay_result(result: dict[str, Any]) -> dict[str, Any]:
    event = result.get("event")
    payload = {
        "status": result.get("status"),
        "error": result.get("error"),
        "created_at": event.get("created_at") if isinstance(event, dict) else None,
        "created_at_utc": (
            to_iso8601_utc(event.get("created_at")) if isinstance(event, dict) else None
        ),
    }

    if isinstance(event, dict) and event.get("kind") == 3:
        payload["follow_count"] = len(extract_follow_entries(event.get("tags")))

    if isinstance(event, dict) and event.get("kind") == 10002:
        payload["relay_count"] = len(extract_kind10002_relays(event.get("tags"))["all"])

    return payload


def summarize_selected_event(selected: dict[str, Any] | None) -> dict[str, Any] | None:
    if selected is None:
        return None

    event = selected["event"]

    return {
        "relay": selected["relay"],
        "created_at": event.get("created_at"),
        "created_at_utc": to_iso8601_utc(event.get("created_at")),
        "id": event.get("id"),
    }


def merge_results(
    initial_results: dict[str, dict[str, Any]],
    discovered_results: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    merged = dict(initial_results)
    merged.update(discovered_results)
    return merged


def normalize_relay_urls(relay_urls: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()

    for relay_url in relay_urls:
        normalized_relay = normalize_relay_url(relay_url)

        if not normalized_relay or normalized_relay in seen:
            continue

        seen.add(normalized_relay)
        normalized.append(normalized_relay)

    return normalized


def normalize_relay_url(relay_url: str | None) -> str | None:
    if relay_url is None:
        return None

    trimmed = str(relay_url).strip()

    if not trimmed:
        return None

    if not trimmed.startswith(("ws://", "wss://")):
        return None

    if "://" not in trimmed:
        return None

    scheme, rest = trimmed.split("://", 1)
    rest = rest.rstrip("/")

    if not rest:
        return None

    return f"{scheme}://{rest}/"


def parse_pubkey(value: str) -> str:
    trimmed = value.strip()

    if HEX_PUBKEY_RE.fullmatch(trimmed):
        return trimmed.lower()

    if trimmed.lower().startswith("npub1"):
        return decode_npub(trimmed.lower())

    raise ValueError("pubkey は 64 桁 hex または npub を指定してください")


def decode_npub(npub: str) -> str:
    hrp, data = bech32_decode(npub)

    if hrp != "npub":
        raise ValueError("npub を指定してください")

    decoded = convert_bits(data, from_bits=5, to_bits=8, pad=False)

    if len(decoded) != 32:
        raise ValueError("npub の長さが不正です")

    return bytes(decoded).hex()


def bech32_decode(bech: str) -> tuple[str, list[int]]:
    if not bech or bech.lower() != bech and bech.upper() != bech:
        raise ValueError("bech32 の大文字小文字が不正です")

    normalized = bech.lower()
    separator_index = normalized.rfind("1")

    if separator_index < 1 or separator_index + 7 > len(normalized):
        raise ValueError("bech32 の形式が不正です")

    hrp = normalized[:separator_index]
    data_part = normalized[separator_index + 1 :]

    try:
        data = [BECH32_CHARSET.index(char) for char in data_part]
    except ValueError as error:
        raise ValueError("bech32 に不正な文字が含まれています") from error

    if not verify_bech32_checksum(hrp, data):
        raise ValueError("bech32 checksum が不正です")

    return hrp, data[:-6]


def verify_bech32_checksum(hrp: str, data: list[int]) -> bool:
    return bech32_polymod(bech32_hrp_expand(hrp) + data) == 1


def bech32_hrp_expand(hrp: str) -> list[int]:
    return [ord(char) >> 5 for char in hrp] + [0] + [ord(char) & 31 for char in hrp]


def bech32_polymod(values: list[int]) -> int:
    generators = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1

    for value in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ value

        for index, generator in enumerate(generators):
            if (top >> index) & 1:
                chk ^= generator

    return chk


def convert_bits(
    data: list[int],
    from_bits: int,
    to_bits: int,
    pad: bool,
) -> list[int]:
    accumulator = 0
    bits = 0
    ret: list[int] = []
    maxv = (1 << to_bits) - 1

    for value in data:
        if value < 0 or value >> from_bits:
            raise ValueError("bech32 data が不正です")

        accumulator = (accumulator << from_bits) | value
        bits += from_bits

        while bits >= to_bits:
            bits -= to_bits
            ret.append((accumulator >> bits) & maxv)

    if pad:
        if bits:
            ret.append((accumulator << (to_bits - bits)) & maxv)
    elif bits >= from_bits or ((accumulator << (to_bits - bits)) & maxv):
        raise ValueError("bech32 data の padding が不正です")

    return ret


def create_subscription_id() -> str:
    return f"follow-sample-{uuid.uuid4()}"


def to_iso8601_utc(timestamp: Any) -> str | None:
    if not isinstance(timestamp, int):
        return None

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def print_human_summary(summary: dict[str, Any]) -> None:
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
