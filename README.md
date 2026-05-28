# Yodaka

Rust/WASM + React/Vite で構築している Web Nostr クライアントです。

## 前提

- `cargo`
- `rustup`
- `wasm-pack`
- `clang`
- `node`
- `npm`
- `make`

初回セットアップでは `wasm32-unknown-unknown` ターゲットが必要です。

```bash
rustup target add wasm32-unknown-unknown
```

## Ubuntu 初回セットアップ

Ubuntu 上で clone 直後に `make dev` まで通す場合は、最低限次を入れてください。

`node` / `npm` は導入済みである前提です。

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl pkg-config libssl-dev ca-certificates clang
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
cd frontend && npm ci
```

`secp256k1-sys` の都合で、WASM build には `clang` が必要です。未導入だと `make wasm` / `make dev` が `failed to find tool "clang"` で停止します。

## Python 補助ツールの依存

`tools/` 配下の Python スクリプトは PyPI 依存を [requirements.txt](requirements.txt) で管理しています。

```bash
~/venv/bin/pip install -r requirements.txt
```

現時点では sampling 用に `websockets`、XSS 静的解析用に `semgrep` を使います。

## 使い方

### 1. 依存のインストール

```bash
make install
```

`frontend/package.json` の依存をインストールします。

clone 直後に lockfile どおりでそろえたい場合は、代わりに次でも構いません。

```bash
cd frontend && npm ci
```

### 2. WASM パッケージの生成

```bash
make wasm
```

2 つの WASM パッケージを生成し、`frontend/src/wasm/` と `frontend/src/miner_wasm/` 配下へ出力します。

現在は次の 2 つの wasm を生成します。

- `frontend/src/wasm/pkg`: タイムライン検証など既存の Nostr 用 wasm
- `frontend/src/miner_wasm/pkg`: WebGPU 鍵マイニング補助用 wasm

### 3. 開発サーバの起動

```bash
make dev
```

起動前に WASM を再生成してから、Vite 開発サーバを `0.0.0.0:5173` で起動します。

ポートや bind アドレスを変えたい場合は環境変数を使います。

```bash
PORT=3000 make dev
HOST=127.0.0.1 PORT=3000 make dev
```

起動後は画面上部の `Key Miner` パネルから、`npub1` を除いた bech32 断片の `prefix` / `suffix` を指定して秘密鍵探索を開始できます。
この機能は `WebGPU` と `Web Crypto` が有効なブラウザを前提にし、見つかった `nsec` / `npub` は localStorage に保存しません。

### 4. 本番相当の確認サーバの起動

```bash
make preview
```

WASM 生成と `vite build` のあと、`0.0.0.0:4173` で preview サーバを起動します。
`BASE_PATH` を指定したい場合は同じように上書きできます。

```bash
PORT=8080 make preview
BASE_PATH=/yodaka/ make preview
```

### 5. 静的ファイルの生成

```bash
make dist
```

`frontend/dist/` に本番用の静的ファイルを書き出します。

この repo の既定値では **相対パス基準 (`./`)** で build します。  
静的ファイルを任意のサブパスへ配置しやすい設定です。

特定の公開パスへ固定したい場合だけ `BASE_PATH` を指定します。

```bash
BASE_PATH=/yodaka/ make dist
```

ドメイン直下へ配置したい場合は `/` を指定してください。

```bash
BASE_PATH=/ make dist
```

生成した `frontend/dist/` は任意の Web サーバへそのまま配置できます。
たとえば `rsync` を使うなら次のように同期できます。

```bash
rsync -av --delete frontend/dist/ user@example:/var/www/yodaka/
```

### 6. 動作確認用の一括チェック

```bash
make check
```

次を順番に実行します。

- Rust テスト
- WASM 生成
- frontend 本番ビルド

### 7. XSS 向け静的検査

```bash
make xss
```

次を順番に実行します。

- `eslint-plugin-no-unsanitized` による危険な DOM 操作検査
- repo 同梱の `semgrep/xss.yml` による HTML sink 検査

フロントエンド単体で lint だけ実行したい場合は次でも構いません。

```bash
cd frontend && npm run lint:xss
```

現在の本文レンダリングは React のテキストノードとして扱っているため、Nostr の `event.content` は `dangerouslySetInnerHTML` へ渡していません。プロフィール画像 URL も `https` 絶対 URL かつ非ローカル host に制限しています。

## ターゲット一覧

- `make help`: ターゲット一覧を表示
- `make install`: frontend 依存をインストール
- `make wasm`: Rust/WASM パッケージを生成
- `make dev`: 開発サーバを起動
- `make preview`: 本番相当の確認サーバを起動
- `make dist`: `frontend/dist/` に静的ファイルを生成
- `make check`: テストとビルドをまとめて実行
- `make xss`: XSS 向け静的検査を実行

## WSL での確認

`make dev` は `0.0.0.0:5173`、`make preview` は `0.0.0.0:4173` で待ち受けます。
WSL から起動した場合でも、通常は Windows 側ブラウザから `http://localhost:5173` または `http://localhost:4173` で確認できます。

## nginx 配置メモ

- 既定の `make dist` は `./` を base path にした build を出力します。
- サブパスへ固定したいときだけ `BASE_PATH=/yodaka/ make dist` のように上書きしてください。
- ドメイン直下へ固定したいときは `BASE_PATH=/ make dist` を使ってください。
- 初期 bootstrap は外部 script 化しているため、通常の更新で CSP の `script-src` hash を毎回差し替える必要はありません。
- SPA なので `try_files` による `index.html` fallback が必要です。
- `.wasm` は拡張子ベースで配信されるため、標準的な nginx 構成ならそのまま動くことが多いですが、環境依存で MIME type を追加したい場合は nginx 側で `application/wasm wasm;` を有効にしてください。
- サブパス配置時は、`BASE_PATH` と nginx 側の `location` / `try_files` を同じパスにそろえてください。
