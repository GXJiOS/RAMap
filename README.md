# RAMap

红警 2 / 尤里的复仇地图预览与编辑器，macOS 原生应用（Electron）。

## 能做什么

- **批量预览**：拖入或选择 `.yrm` `.mpr` `.map` `.yro`，解出缩略图、尺寸、地形、出生点数量，支持文件名与地图名筛选
- **矿石与宝石**：按原版规则绘制，1×1 / 3×3 / 5×5 画笔，自动避开水面、坡面、建筑占地、树木与出生点预留区
- **断桥**：沿桥身断开整条 3 格宽桥面，两端自动补上断口图块，木桥与混凝土桥、两个走向都支持
- **中立建筑**：放置油井、科技机场、市民医院、矿石树，占地按原版 `art.ini` 校验；删除对象可移除地图上任意建筑与树木
- **导出**：另存为新文件，只重写改动过的 section，其余字节原样保留；缩略图同步更新

撤销与重做（⌘Z / ⇧⌘Z）覆盖全部编辑操作。

## 开发

```bash
npm install
npm run dev        # Electron + Vite 热更新
npm run dev:web    # 只跑网页版
npm run check      # 测试 + 类型检查 + 构建
```

## 构建与安装

```bash
make build     # 安装依赖、跑测试、构建页面
make bundle    # 打包并签名为 build/RAMap.app
make install   # 同上，安装到 /Applications/RAMap.app 并启动
make stop      # 退出正在运行的 RAMap
make clean     # 清除 build/ 与 dist/
```

签名优先级：命令行 `SIGN_ID` → `local.mk` → 钥匙串里的 Apple Development 证书 → ad-hoc。安装先复制到暂存目录并做启动自检，再替换 `/Applications/RAMap.app`；检查失败会恢复原有版本。

## 规则数据

`src/data/yrm-stock-data.json` 与 `ra2-stock-data.json` 是从原版 `rules.ini` 与 `art.ini` 提取的地形、建筑占地、覆盖物与资源编号表，文件内记录了来源文件的 SHA-256。地图格式的处理规则（低桥断口编号、中立建筑行格式、矿石树坐标编码等）来自对原版数据和大量真实地图的比对，未使用任何现有编辑器的代码。

含自定义规则的地图（改写了 `[OverlayTypes]`、`[BuildingTypes]`、占地等）会被标记为只读，只提供预览。
