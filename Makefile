SHELL := /bin/bash

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
FRONTEND_DIR := $(ROOT_DIR)/frontend
NOSTR_WASM_DIR := $(ROOT_DIR)/rust/crates/nostr_wasm
NOSTR_PHYSICS_WASM_DIR := $(ROOT_DIR)/rust/crates/nostr_physics_wasm
NOSTR_MINER_WASM_DIR := $(ROOT_DIR)/rust/crates/nostr_miner_wasm
NOSTR_WASM_OUT_DIR := $(FRONTEND_DIR)/src/wasm/pkg
NOSTR_PHYSICS_WASM_OUT_DIR := $(FRONTEND_DIR)/src/physics_wasm/pkg
NOSTR_MINER_WASM_OUT_DIR := $(FRONTEND_DIR)/src/miner_wasm/pkg

.PHONY: help install wasm dev preview dist check xss

help:
	@echo "Available targets:"
	@echo "  make install  - frontend 依存をインストール"
	@echo "  make wasm     - Rust/WASM パッケージを生成"
	@echo "  make dev      - Vite 開発サーバを起動"
	@echo "  make preview  - 本番ビルド後に確認用サーバを起動"
	@echo "  make dist     - frontend/dist/ を生成"
	@echo "  make check    - Rust テストと frontend build を実行"
	@echo "  make xss      - XSS 向け静的検査を実行"

install:
	cd "$(FRONTEND_DIR)" && npm install

wasm:
	cd "$(NOSTR_WASM_DIR)" && wasm-pack build --target web --release --out-dir "$(NOSTR_WASM_OUT_DIR)"
	cd "$(NOSTR_PHYSICS_WASM_DIR)" && wasm-pack build --target web --release --out-dir "$(NOSTR_PHYSICS_WASM_OUT_DIR)"
	cd "$(NOSTR_MINER_WASM_DIR)" && wasm-pack build --target web --release --out-dir "$(NOSTR_MINER_WASM_OUT_DIR)"

dev: wasm
	cd "$(FRONTEND_DIR)" && HOST="$${HOST:-0.0.0.0}" PORT="$${PORT:-5173}" npm run dev

preview: wasm
	cd "$(FRONTEND_DIR)" && BASE_PATH="$${BASE_PATH:-./}" npm run build
	cd "$(FRONTEND_DIR)" && npm run preview -- --host "$${HOST:-0.0.0.0}" --port "$${PORT:-4173}" --strictPort

dist: wasm
	cd "$(FRONTEND_DIR)" && BASE_PATH="$${BASE_PATH:-./}" npm run build

check:
	cargo test --manifest-path rust/Cargo.toml
	cd "$(FRONTEND_DIR)" && npm run lint:xss
	$(MAKE) wasm
	cd "$(FRONTEND_DIR)" && BASE_PATH="$${BASE_PATH:-./}" npm run build

xss:
	cd "$(FRONTEND_DIR)" && npm run lint:xss
	~/venv/bin/semgrep --config semgrep/xss.yml frontend/src/
