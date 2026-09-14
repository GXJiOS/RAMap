import { useEffect, useMemo, useRef, useState } from 'react';
import { FileImage, Upload } from 'lucide-react';
import { Action, Panel, Select, ToolWorkspace } from '../components/ToolWorkspace';
import { byteSize, errorMessage, saveBytes } from '../lib/tool-actions';
import { MAP_EXTENSIONS, MAP_GAME_NAMES, mapExtension, mapOutputName, MAX_YRM_BYTES, readYrmPreview, suggestedMapGame, type MapGame, type YrmMap, type YrmPreview } from '../lib/yrm-preview';
import './YRMPreviewTool.css';
import { YrmEditSession } from '../lib/yrm-editor';
import { GameArt, theaterSupported } from '../lib/game-art';
import type { AssetStatus } from '../lib/desktop';
import { collectArtNames, renderFullMap } from '../lib/map-render';
import { YRMEditor } from './YRMEditor';

type MapEntry = {
  id: string;
  filename: string;
  bytes: number;
  map?: Omit<YrmMap, 'preview'>;
  image?: { url: string; blob: Blob; width: number; height: number };
  error?: string;
  source?: Uint8Array;
  game?: MapGame;
};
// 工具切换期间，当前地图草稿保留在本次应用会话的内存中。
let retainedEditor: { session: YrmEditSession; filename: string } | null = null;
const theaters: Record<string, string> = {
  TEMPERATE: '温带', SNOW: '雪地', URBAN: '城市', NEWURBAN: '新城市', DESERT: '沙漠', LUNAR: '月球',
};
const MAX_FILES = 200;
const MAX_BATCH_BYTES = 128 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const ART_PREFERENCE = 'ramap.real-art';
const MAX_BATCH_PIXELS = 16 * 1024 * 1024;

async function previewPng(preview: YrmPreview): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = preview.width;
  canvas.height = preview.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境无法生成预览图。');
    const pixels = context.createImageData(preview.width, preview.height);
    for (let source = 0, target = 0; source < preview.rgb.length; source += 3, target += 4) {
      pixels.data[target] = preview.rgb[source];
      pixels.data[target + 1] = preview.rgb[source + 1];
      pixels.data[target + 2] = preview.rgb[source + 2];
      pixels.data[target + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败，请重新载入地图。')), 'image/png');
    });
  } finally { canvas.width = 0; canvas.height = 0; }
}

function playerLabel(map?: MapEntry['map']): string {
  if (!map) return '地图无法读取';
  if (map.multiplayer === false) return '非多人地图标记';
  if (map.maxPlayers) return map.minPlayers && map.minPlayers !== map.maxPlayers
    ? `${map.minPlayers}–${map.maxPlayers} 人` : `最多 ${map.maxPlayers} 人`;
  return '人数未标注';
}

export function YRMPreviewTool() {
  const [editor, setEditor] = useState(retainedEditor);
  const [openingEditor, setOpeningEditor] = useState(false);
  const [entries, setEntries] = useState<MapEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState('fit');
  const [rendered, setRendered] = useState<Record<string, { url: string; width: number; height: number }>>({});
  const [artPending, setArtPending] = useState(false);
  const [assets, setAssets] = useState<AssetStatus | null>(null);
  const [preferArt, setPreferArt] = useState(() => { try { return localStorage.getItem(ART_PREFERENCE) === '1'; } catch { return false; } });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const urls = useRef(new Set<string>());
  const dragDepth = useRef(0);

  const revokeUrls = () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  };
  useEffect(() => () => { generation.current += 1; revokeUrls(); }, []);

  const reset = () => {
    generation.current += 1;
    revokeUrls();
    setEntries([]); setSelectedId(''); setQuery(''); setZoom('fit'); setError(''); setProgress(null);
    dragDepth.current = 0; setDragging(false);
  };
  const loadFiles = async (files: File[]) => {
    if (!files.length) return;
    if (files.length > MAX_FILES) { setError('每批最多载入 200 个文件，请分批选择。'); return; }
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES) {
      setError('本批文件总大小超过 128 MB，请分批选择。'); return;
    }
    reset();
    const revision = generation.current;
    let pngBytes = 0;
    let previewPixels = 0;
    setProgress({ done: 0, total: files.length });
    for (let index = 0; index < files.length; index += 1) {
      // 每个文件之间让出主线程，清空或更换文件时当前批次立即失效。
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (revision !== generation.current) return;
      const file = files[index];
      const entry: MapEntry = { id: `${revision}-${index}`, filename: file.name, bytes: file.size };
      try {
        if (!mapExtension(file.name)) throw new Error('请选择 YRM、MPR、MAP 或 YRO 地图文件。');
        if (file.size > MAX_YRM_BYTES) throw new Error('单张地图大小上限为 8 MB。');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (revision !== generation.current) return;
        const { preview, ...metadata } = readYrmPreview(bytes);
        entry.source = bytes;
        entry.map = metadata;
        entry.game = suggestedMapGame(file.name, metadata);
        if (preview) {
          const pixels = preview.width * preview.height;
          if (previewPixels + pixels > MAX_BATCH_PIXELS) throw new Error('本批预览图的像素总量达到上限，请分批载入。');
          const blob = await previewPng(preview);
          if (revision !== generation.current) return;
          if (pngBytes + blob.size > MAX_PNG_BYTES) throw new Error('本批预览图总大小超过 32 MB，请分批载入。');
          pngBytes += blob.size;
          previewPixels += pixels;
          const url = URL.createObjectURL(blob);
          urls.current.add(url);
          entry.image = { url, blob, width: preview.width, height: preview.height };
        } else entry.error = metadata.previewError;
      } catch (cause) { entry.error = errorMessage(cause); }
      if (revision !== generation.current) return;
      setEntries((current) => [...current, entry]);
      setSelectedId((current) => current || entry.id);
      setProgress({ done: index + 1, total: files.length });
    }
    if (revision === generation.current) setProgress(null);
  };

  useEffect(() => { void window.mapDesktop?.assetStatus().then(setAssets).catch(() => { /* 没配过资源目录时保持未设置。 */ }); }, []);
  // 换资源目录后旧的渲染结果作废，重新按新素材画。
  const chooseAssets = async () => {
    const bridge = window.mapDesktop;
    if (!bridge) throw new Error('网页版无法读取游戏资源，请在桌面应用中使用。');
    const folder = await bridge.chooseFolder();
    if (!folder) return;
    const status = await bridge.openAssets(folder);
    setAssets(status);
    setRendered((current) => { for (const item of Object.values(current)) URL.revokeObjectURL(item.url); return {}; });
  };
  const selected = entries.find((entry) => entry.id === selectedId);
  const shown = selected && (rendered[selected.id] ?? selected.image);
  // 用游戏原始贴图重画整张地图，取代地图自带的低清缩略图。
  const renderReal = async (silent = false) => {
    const entry = selected;
    if (!entry?.source) return;
    const bridge = window.mapDesktop;
    if (!bridge) { if (silent) return; throw new Error('网页版无法读取游戏资源，请在桌面应用中使用。'); }
    setArtPending(true);
    try {
      let status = await bridge.assetStatus();
      if (!status) {
        if (silent) return;
        const folder = await bridge.chooseFolder();
        if (!folder) return;
        status = await bridge.openAssets(folder);
      }
      const session = new YrmEditSession(entry.source, entry.game ?? 'yr');
      if (!theaterSupported(session.info.theater)) throw new Error(`暂不支持 ${session.info.theater} 地形的真实贴图。`);
      const art = new GameArt(session.info.theater);
      if (!await art.prepare()) throw new Error('没能读出该地形的图块表，请确认选的是完整的游戏资源目录。');
      await art.load(collectArtNames(session, art, session.overlayNames));
      const canvas = renderFullMap(session, art, 2400);
      const width = canvas.width; const height = canvas.height;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = 0; canvas.height = 0;
      if (!blob) throw new Error('渲染结果转换失败，请重试。');
      setRendered((current) => {
        const previous = current[entry.id];
        if (previous) URL.revokeObjectURL(previous.url);
        return { ...current, [entry.id]: { url: URL.createObjectURL(blob), width, height } };
      });
      setPreferArt(true);
      try { localStorage.setItem(ART_PREFERENCE, '1'); } catch { /* 存不下就只在本次会话生效。 */ }
    } finally { setArtPending(false); }
  };
  const visible = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => `${entry.filename}\n${entry.map?.name ?? ''}`.toLocaleLowerCase().includes(text));
  }, [entries, query]);
  const ready = entries.filter((entry) => entry.image).length;
  const status = progress ? `正在载入 ${progress.done} / ${progress.total}`
    : entries.length ? `${entries.length} 个文件 · ${ready} 张可预览 · ${entries.length - ready} 个需检查` : '文件在本机处理';
  useEffect(() => {
    if (!preferArt || artPending || !selected?.source || rendered[selected.id]) return;
    void renderReal(true).catch(() => { /* 自动重绘失败时保留内嵌缩略图。 */ });
  }, [selectedId, preferArt, entries.length]);

  const information = selected && [
    ['文件名', selected.filename], ['地图名称', selected.map?.name || '未标注'],
    ['人数', playerLabel(selected.map)],
    ['地形', selected.map ? theaters[selected.map.theater] ?? (selected.map.theater || '未标注') : '—'],
    ['地图尺寸', selected.map ? `${selected.map.width} × ${selected.map.height}` : '—'],
    ['预览尺寸', selected.image ? `${selected.image.width} × ${selected.image.height} px` : '—'],
    ['文件大小', byteSize(selected.bytes)],
    ['文件格式', mapExtension(selected.filename)?.slice(1).toUpperCase() ?? '—'],
    ['文字编码', selected.map?.encoding ?? '—'],
    ['编辑规则', selected.game ? MAP_GAME_NAMES[selected.game] : '请选择游戏版本'],
  ];

  if (editor) return <YRMEditor session={editor.session} filename={editor.filename} onClose={() => { retainedEditor = null; setEditor(null); }} />;

  return <ToolWorkspace title="红警地图预览" description="载入红警地图，用游戏素材预览或编辑地形资源与建筑。" error={error} status={status}
    actions={<Action onAction={chooseAssets}>{assets ? `游戏资源 · ${assets.files} 个文件` : '设置游戏资源'}</Action>}>
    <div className={`yrm-tool${dragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth.current += 1; setDragging(true); }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void loadFiles(Array.from(event.dataTransfer.files)); }}>
      <input ref={input} type="file" accept={MAP_EXTENSIONS.join(',')} multiple hidden aria-label="载入红警地图" onChange={(event) => {
        const files = Array.from(event.target.files ?? []); event.target.value = ''; void loadFiles(files);
      }} />
      <div className="yrm-controls">
        <button className="work-button is-primary" type="button" onClick={() => input.current?.click()}><Upload size={15} aria-hidden="true" />载入地图</button>
        <button className="work-button" type="button" disabled={!entries.length && !progress} onClick={reset}>{progress ? '取消并清空' : '清空'}</button>
        <span className="yrm-load-hint">支持多选或拖入 · 每张最多 8 MB</span>
        <label className="yrm-search">筛选<input type="search" aria-label="筛选地图" placeholder="文件名或地图名称" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!entries.length} /></label>
      </div>
      {selected?.map && <div className="work-options">
        <Select label="编辑规则" value={selected.game ?? ''} options={[["", "请选择游戏版本"], ["ra2", "红警 2"], ["yr", "尤里的复仇"]]} onChange={(game) => {
          if (openingEditor) return;
          setEntries((current) => current.map((entry) => entry.id === selected.id ? { ...entry, game: game || undefined } : entry));
        }} />
        <span className="yrm-preview-note">{selected.game ? '按地图来源选择原版规则；另存保留输入格式。' : '这个文件的版本尚未确定，选择规则后可进入编辑。'}</span>
      </div>}
      {entries.length > 0 ? <>
        <div className="yrm-detail-layout">
          <Panel title="地图预览" actions={<>
            <Action key={`${selected?.id}:${selected?.game}`} disabled={!selected?.source || !selected.game || Boolean(progress) || openingEditor} onAction={async () => {
              if (!selected?.source || !selected.game) return;
              setOpeningEditor(true);
              const revision = generation.current;
              try {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (revision !== generation.current) return;
                retainedEditor = { session: new YrmEditSession(selected.source, selected.game), filename: selected.filename };
                setEditor(retainedEditor);
              } finally { setOpeningEditor(false); }
            }}>编辑地图</Action>
            <Select label="缩放" value={zoom} options={[["fit", "适应窗口"], ["1", "100%"], ["2", "200%"], ["4", "400%"]]} onChange={setZoom} />
            <Action disabled={!selected?.image} onAction={async () => {
              if (!selected?.image) return;
              await saveBytes(new Uint8Array(await selected.image.blob.arrayBuffer()), mapOutputName(selected.filename, 'png'), 'image/png');
            }}>导出 PNG</Action>
            <Action disabled={!selected?.source || artPending} onAction={() => {
              if (!rendered[selectedId]) return renderReal();
              setRendered((current) => { const next = { ...current }; URL.revokeObjectURL(next[selectedId].url); delete next[selectedId]; return next; });
              setPreferArt(false);
              try { localStorage.setItem(ART_PREFERENCE, '0'); } catch { /* 忽略存储不可用。 */ }
            }}>{artPending ? '渲染中…' : rendered[selectedId] ? '内嵌缩略图' : '真实贴图'}</Action>
          </>}>
            <div className={`yrm-stage ${zoom === 'fit' ? 'is-fit' : 'is-zoomed'}`}>
              {shown ? <img alt={`${selected?.filename} 地图预览`} src={shown.url} draggable={false}
                style={zoom === 'fit' ? undefined : { width: shown.width * Number(zoom), height: shown.height * Number(zoom) }} />
                : <div className="yrm-preview-error" role="status"><FileImage size={32} aria-hidden="true" /><strong>当前文件暂无可用预览</strong><span>{selected?.error}</span></div>}
            </div>
            <p className="yrm-preview-note">{rendered[selectedId] ? '用游戏原始贴图重绘的完整地图，含地形、资源、树木与建筑。' : '显示地图内嵌缩略图，清晰度取决于原图。点「真实贴图」用游戏素材重画。'}</p>
          </Panel>
          <Panel title="地图信息" className="yrm-information"><dl>{information?.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></Panel>
        </div>
        <Panel title={`地图列表 · ${visible.length}`}>
          <div className="yrm-gallery" aria-label="地图列表">{visible.map((entry) => <button key={entry.id} className={`yrm-map${selectedId === entry.id ? ' is-selected' : ''}`}
            type="button" aria-pressed={selectedId === entry.id} aria-label={entry.filename} onClick={() => { setSelectedId(entry.id); setZoom('fit'); }}>
            <span className="yrm-thumbnail">{entry.image ? <img alt="" src={entry.image.url} loading="lazy" draggable={false} /> : <FileImage size={28} aria-hidden="true" />}</span>
            <strong>{entry.filename}</strong><span className={entry.error ? 'yrm-file-error' : 'yrm-map-meta'}>{entry.error || playerLabel(entry.map)}</span>
          </button>)}</div>
          {!visible.length && <p className="work-empty">没有匹配的地图，试试其他名称。</p>}
        </Panel>
      </> : <div className="yrm-empty"><FileImage size={46} aria-hidden="true" /><h2>{progress ? '正在读取地图…' : '把红警地图拖到这里'}</h2>
        <p>支持 YRM、MPR、MAP、YRO，可一次载入多张地图。</p><button className="work-button" type="button" onClick={() => input.current?.click()}>选择地图文件</button></div>}
      {dragging && <div className="yrm-drop-overlay">松开鼠标，预览地图</div>}
    </div>
  </ToolWorkspace>;
}
