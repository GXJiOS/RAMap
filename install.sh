#!/bin/bash
# RAMap：在目标 Mac 构建、签名、自检并安装 Electron 应用。
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="RAMap"
APP="build/${APP_NAME}.app"
CANDIDATE="build/mac-arm64/${APP_NAME}.app"
INSTALLED="/Applications/${APP_NAME}.app"

fail() { echo "✗ $*" >&2; exit 1; }

check_environment() {
  [ "$(uname -s)" = Darwin ] || fail "请在 macOS 上构建。"
  [ "$(uname -m)" = arm64 ] || fail "本应用仅支持 Apple Silicon。"
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || fail "需要 macOS 13 或更高版本。"
  xcode-select -p >/dev/null 2>&1 || fail "请先安装 Xcode 命令行工具：xcode-select --install"
  local tool
  for tool in node npm make codesign security ditto; do
    command -v "$tool" >/dev/null 2>&1 || fail "缺少构建工具：$tool"
  done
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' \
    || fail "Electron 打包依赖需要 Node.js 22.12 或更高版本。"
}

build_app() {
  echo "▸ 检查构建环境"
  check_environment
  local fingerprint
  fingerprint="$(shasum -a 256 package.json package-lock.json)"
  if [ ! -x node_modules/.bin/electron-builder ] \
    || [ ! -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ] \
    || [ "$fingerprint" != "$(cat node_modules/.ramap-dependencies.sha256 2>/dev/null || true)" ]; then
    echo "▸ 按锁文件安装依赖"
    npm ci --include=dev --no-audit --no-fund
    printf '%s\n' "$fingerprint" > node_modules/.ramap-dependencies.sha256
  fi
  echo "▸ 测试并构建页面"
  npm run check
}

verify_app() {
  local target="$1"
  codesign --verify --deep --strict "$target" || return 1
  # 外层超时覆盖 Electron 进入 JavaScript 之前的启动失败。
  node --input-type=commonjs - "$target/Contents/MacOS/$APP_NAME" <<'NODE'
const { spawnSync } = require('node:child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.RAMAP_VITE_DEV_SERVER_URL;
const result = spawnSync(process.argv[2], ['--install-check'], {
  env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
});
if (result.status !== 0 || !result.stdout?.split(/\r?\n/).includes('RAMAP_INSTALL_CHECK_OK')) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  console.error('启动自检失败：', result.error?.message || result.signal || `退出码 ${result.status}`);
  process.exit(1);
}
console.log('  页面与桌面桥接自检通过');
NODE
}

pack_and_check() {
  local identity="$1" log="$2"
  echo "▸ 打包并签名：$identity"
  # 签名回调保留解析出的 SHA-1，准确选择钥匙串中的同名证书。
  if ! CSC_IDENTITY_AUTO_DISCOVERY=true node --input-type=commonjs - "$identity" > "$log" 2>&1 <<'NODE'
const { build, Platform, Arch } = require('electron-builder');
const { signAsync } = require('@electron/osx-sign');
let signed = false;
build({
  targets: Platform.MAC.createTarget('dir', Arch.arm64),
  publish: 'never',
  config: {
    mac: {
      identity: process.argv[2],
      sign: async (options) => {
        await signAsync(options);
        signed = true;
      },
    },
  },
}).then(() => {
  if (!signed) throw new Error('未找到指定的签名身份');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
  then
    tail -40 "$log" >&2
    return 1
  fi
  verify_app "$CANDIDATE"
}

bundle_app() {
  check_environment
  [ -f dist/index.html ] || fail "请先运行 make build。"
  mkdir -p build
  local identity="${SIGN_ID:-}"
  if [ -z "$identity" ]; then
    identity="$(security find-identity -v -p codesigning 2>/dev/null \
      | awk '/Apple Development/ && !/CSSMERR/ && !found { print $2; found=1 }' || true)"
  fi
  identity="${identity:--}"
  if [ "$identity" = - ]; then
    pack_and_check - build/sign-adhoc.log || fail "ad-hoc 打包或启动自检失败。"
    echo "  使用 ad-hoc 本地签名"
  elif pack_and_check "$identity" build/sign-developer.log; then
    echo "  使用开发者证书签名"
  else
    echo "▸ 开发者签名构建未通过检查，尝试 ad-hoc 签名"
    pack_and_check - build/sign-adhoc.log || fail "打包或启动自检失败，详见 build/sign-*.log。"
    echo "  使用 ad-hoc 本地签名"
  fi
  rm -rf "$APP"
  mv "$CANDIDATE" "$APP"
  echo "✓ 已生成：$APP"
}

stop_app() {
  if pgrep -x "$APP_NAME" >/dev/null; then
    pkill -x "$APP_NAME"
    local attempt
    for attempt in 1 2 3 4 5; do
      pgrep -x "$APP_NAME" >/dev/null || return 0
      sleep 1
    done
    fail "RAMap 尚未退出，请退出应用后重试。"
  fi
}

install_app() (
  check_environment
  [ -d "$APP" ] || fail "请先运行 make bundle。"
  local staging installed_new=false committed=false
  staging="$(mktemp -d /Applications/.ramap-install.XXXXXX)" \
    || fail "无法写入 /Applications，请检查该目录权限。"

  cleanup_install() {
    local status=$?
    trap - EXIT
    if [ "$committed" = false ]; then
      if [ "$installed_new" = true ]; then
        pkill -x "$APP_NAME" 2>/dev/null || true
        rm -rf "$INSTALLED"
      fi
      if [ -d "$staging/Previous.app" ]; then
        if ! mv "$staging/Previous.app" "$INSTALLED"; then
          echo "✗ 旧版本保存在 $staging/Previous.app，请手动恢复。" >&2
          exit 1
        fi
      fi
    fi
    rm -rf "$staging"
    exit "$status"
  }
  trap cleanup_install EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  echo "▸ 安装到 $INSTALLED"
  ditto "$APP" "$staging/$APP_NAME.app"
  verify_app "$staging/$APP_NAME.app"
  stop_app
  if [ -e "$INSTALLED" ]; then
    mv "$INSTALLED" "$staging/Previous.app"
  fi
  mv "$staging/$APP_NAME.app" "$INSTALLED"
  installed_new=true
  verify_app "$INSTALLED"
  /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$INSTALLED"
  open "$INSTALLED"
  committed=true
  echo "✓ 已安装并启动：$INSTALLED"
)

[ "$#" -le 1 ] || fail "用法：./install.sh，或 make build / bundle / run / stop / install / clean"
case "${1:-}" in
  '') exec make install ;;
  --build) build_app ;;
  --bundle) bundle_app ;;
  --run) verify_app "$APP"; stop_app; open "$APP" ;;
  --install) install_app ;;
  --stop) stop_app ;;
  --clean) rm -rf build dist ;;
  *) fail "未知参数：$1" ;;
esac
