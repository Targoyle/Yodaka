# Sampling Tools

relay から raw event を抜いて、別環境で挙動確認や制限値調整に使うための補助ツールです。

現時点では次の 2 本を入れています。

- `collect_relay_sample.py`
- `collect_follow_list.py`

## 依存

- Python 3.11+
- `websockets`

例:

```bash
python tools/sampling/collect_relay_sample.py --help
python -m pip install -r requirements.txt
```

## 使い方

kind `1` のスナップショットを `wss://yabu.me` から取る:

```bash
python tools/sampling/collect_relay_sample.py \
  --relay wss://yabu.me \
  --kind 1 \
  --limit 200 \
  --output-dir tools/sampling/output/yabu-kind1
```

kind `0` を特定 author で取る:

```bash
python tools/sampling/collect_relay_sample.py \
  --relay wss://yabu.me \
  --kind 0 \
  --author <pubkey-hex> \
  --limit 100 \
  --output-dir tools/sampling/output/yabu-profile
```

EOSE 後も 30 秒だけ live を観測する:

```bash
python tools/sampling/collect_relay_sample.py \
  --relay wss://yabu.me \
  --kind 1 \
  --since 1710000000 \
  --live-seconds 30 \
  --output-dir tools/sampling/output/yabu-live
```

## 出力

- `events.jsonl`
  - relay から受信した event 本体を受信順で 1 行 1 JSON で保存します。
- `summary.json`
  - `created_at` の範囲
  - future skew 件数
  - 最大本文サイズ
  - 最大 tag 数
  - duplicate id 件数
  - 上位 author
  - NOTICE の代表例
  をまとめます。

## 補足

- `future skew` 判定は既定で `600秒` です。
- `--max-message-bytes` は websocket フレーム上限で、既定は `4 MiB` です。
- このツールは relay の真正性検証をしません。raw sample 取得専用です。

## follow 一覧の診断

指定 pubkey の kind `3` follow list と kind `10002` relay list を調べる:

```bash
python tools/sampling/collect_follow_list.py \
  --pubkey <pubkey-hex-or-npub> \
  --output-dir tools/sampling/output/follow-check
```

relay を明示して確認する:

```bash
python tools/sampling/collect_follow_list.py \
  --pubkey <pubkey-hex-or-npub> \
  --relay wss://yabu.me \
  --relay wss://relay.damus.io \
  --relay wss://nos.lol \
  --relay wss://r.kojira.io \
  --relay wss://srtrelay.c-stellar.net \
  --output-dir tools/sampling/output/follow-check
```

出力:

- `summary.json`
  - relay ごとの `kind 3` / `kind 10002` の有無
  - 最新 `kind 3` の relay と follow 件数
  - 最新 `kind 10002` から見えた relay 一覧
- `results.json`
  - relay ごとの raw event とエラー内容

補足:

- `--discover-from-10002` は既定で有効です。
- 初回 relay 群で `kind 10002` が見つかった場合、その relay list に含まれる追加 relay でも `kind 3` を探索します。
