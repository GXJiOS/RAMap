# RAMap — Electron 本地构建与安装
.DEFAULT_GOAL := build
.NOTPARALLEL:

# 优先级：命令行 SIGN_ID → 本机 local.mk → 钥匙串开发者证书 → ad-hoc。
-include local.mk
export SIGN_ID

.PHONY: build bundle run stop install clean

build:
	@./install.sh --build

bundle: build
	@./install.sh --bundle

run: bundle
	@./install.sh --run

install: bundle
	@./install.sh --install

stop:
	@./install.sh --stop

clean:
	@./install.sh --clean
