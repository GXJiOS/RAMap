import { useEffect, useMemo, useRef, useState } from 'react';
import { Action, Select, ToolWorkspace } from '../components/ToolWorkspace';
import { bytesToBase64, errorMessage, saveBytes } from '../lib/tool-actions';
import { PLACEABLE, YrmEditSession, type EditBrush, type PlaceKind } from '../lib/yrm-editor';
import { GameArt, theaterSupported } from '../lib/game-art';
import { collectArtNames, renderFullMap, renderMap, worldSize } from '../lib/map-render';
import { MAP_GAME_NAMES, mapOutputName } from '../lib/yrm-preview';

const ART_PREFERENCE = 'ramap.real-art';

export function YRMEditor({ session, filename, onClose }: { session: YrmEditSession; filename: string; onClose(): void }) {
  const [brush, setBrush] = useState<EditBrush | 'move'>('ore');
  const [radius, setRadius] = useState('0');
  const [zoom, setZoom] = useState('1');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('选择画笔，在可绘制的格子上按住并拖动。');
  const [error, setError] = useState('');
  const [art, setArt] = useState<GameArt | null>(null);
  const [artPending, setArtPending] = useState(false);
  const [artRaster, setArtRaster] = useState<HTMLCanvasElement | null>(null);
  const artRevision = useRef(-1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ id: number; mode: 'paint' | 'move'; clientX: number; clientY: number; x: number; y: number; pan: typeof pan } | null>(null);
  const raster = useRef<HTMLCanvasElement | null>(null);
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  const update = () => setRevision((value) => value + 1);
  const world = useMemo(() => worldSize(session), [session]);
  const worldWidth = session.info.width * 60;
  const worldHeight = (session.info.height * 2 + 1) * 15;
  const scale = Math.min((size.width - 24) / worldWidth, (size.height - 24) / worldHeight) * Number(zoom);
  const origin = { x: (size.width - worldWidth * scale) / 2 + pan.x, y: (size.height - worldHeight * scale) / 2 + pan.y };

  useEffect(() => {
    try { if (localStorage.getItem(ART_PREFERENCE) === '1') void loadArt(true); } catch { /* 忽略存储不可用。 */ }
  }, [session]);

  useEffect(() => {
    if (!art || artRevision.current === revision) return;
    const timer = setTimeout(() => { artRevision.current = revision; setArtRaster(renderFullMap(session, art, 2600)); }, 400);
    return () => clearTimeout(timer);
  }, [art, revision, session]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(200, entry.contentRect.width), height: 480 }));
    if (container.current) observer.observe(container.current);
    const unload = (event: BeforeUnloadEvent) => { if (session.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { observer.disconnect(); window.removeEventListener('beforeunload', unload); session.cancelStroke(); };
  }, [session]);

  useEffect(() => {
    const preview = session.overview();
    const image = document.createElement('canvas'); image.width = preview.width; image.height = preview.height;
    const ctx = image.getContext('2d');
    if (!ctx) { setError('当前环境无法绘制地图。'); return; }
    const pixels = ctx.createImageData(preview.width, preview.height);
    for (let p = 0, target = 0; p < preview.rgb.length; p += 3, target += 4) {
      pixels.data[target] = preview.rgb[p]; pixels.data[target + 1] = preview.rgb[p + 1]; pixels.data[target + 2] = preview.rgb[p + 2]; pixels.data[target + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0); raster.current = image;
  }, [session, revision]);

  useEffect(() => {
    const image = canvas.current; const ctx = image?.getContext('2d'); if (!image || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    image.width = Math.round(size.width * dpr); image.height = Math.round(size.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#252d35'; ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = false;
    const viewWidth = Math.max(1, Math.ceil(size.width / scale)); const viewHeight = Math.max(1, Math.ceil(size.height / scale));
    const painted = Boolean(art) && viewWidth * viewHeight <= 12_000_000;
    if (painted && art) {
      let buffer = offscreen.current;
      if (!buffer) { buffer = document.createElement('canvas'); offscreen.current = buffer; }
      if (buffer.width !== viewWidth || buffer.height !== viewHeight) { buffer.width = viewWidth; buffer.height = viewHeight; }
      const target = buffer.getContext('2d', { willReadFrequently: true });
      if (target) {
        const image = target.createImageData(viewWidth, viewHeight);
        renderMap(image, session, art, { left: -origin.x / scale, top: -origin.y / scale, width: viewWidth, height: viewHeight }, session.overlayNames, session.drawOrder);
        target.putImageData(image, 0, 0);
        ctx.drawImage(buffer, 0, 0, viewWidth, viewHeight, 0, 0, size.width, size.height);
      }
    }
    ctx.translate(origin.x, origin.y); ctx.scale(scale, scale);
    if (!painted) {
      if (artRaster) ctx.drawImage(artRaster, world.left, world.top, world.width, world.height);
      else if (raster.current) ctx.drawImage(raster.current, 0, 0, worldWidth, worldHeight);
    }
    const diamond = (x: number, y: number) => {
      const cx = (x - y + session.info.width) * 30; const cy = (x + y - session.info.width) * 15;
      ctx.beginPath(); ctx.moveTo(cx, cy - 15); ctx.lineTo(cx + 30, cy); ctx.lineTo(cx, cy + 15); ctx.lineTo(cx - 30, cy); ctx.closePath();
    };
    if (scale * 60 >= 9) {
      ctx.lineWidth = 0.65 / scale; ctx.strokeStyle = '#00000035';
      for (const cell of session.cells.values()) {
        const cx = (cell.x - cell.y + session.info.width) * 30 * scale + origin.x;
        const cy = (cell.x + cell.y - session.info.width) * 15 * scale + origin.y;
        if (cx < -60 * scale || cx > size.width + 60 * scale || cy < -30 * scale || cy > size.height + 30 * scale) continue;
        diamond(cell.x, cell.y); ctx.stroke();
        if (cell.blocked) { ctx.fillStyle = '#00000024'; ctx.fill(); }
      }
    }
    for (const point of session.starts) {
      const x = (point.x - point.y + session.info.width) * 30; const y = (point.x + point.y - session.info.width) * 15;
      ctx.fillStyle = '#2867c7'; ctx.beginPath(); ctx.arc(x, y, 16 / scale, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.font = `bold ${18 / scale}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(point.id, x, y);
    }
    if (hover && brush !== 'move') {
      const footprint = brush in PLACEABLE ? session.footprint(brush as PlaceKind) : null;
      const origin = session.cells.get(hover.y * 512 + hover.x);
      if (footprint) {
        const blocked = !origin || origin.x !== hover.x || origin.y !== hover.y || Boolean(session.reasonAt(origin, brush));
        ctx.fillStyle = blocked ? '#ff555559' : '#ffffff55'; ctx.lineWidth = 1.5 / scale; ctx.strokeStyle = blocked ? '#ff7373' : '#ffffff';
        for (let dy = 0; dy < footprint[1]; dy += 1) for (let dx = 0; dx < footprint[0]; dx += 1) { diamond(hover.x + dx, hover.y + dy); ctx.fill(); ctx.stroke(); }
      } else {
        const r = brush === 'bridge' || brush === 'remove' ? 0 : Number(radius);
        for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
          const x = hover.x + dx; const y = hover.y + dy; const cell = session.cells.get(y * 512 + x);
          if (!cell || cell.x !== x || cell.y !== y) continue;
          diamond(x, y); const blocked = Boolean(session.reasonAt(cell, brush));
          ctx.fillStyle = blocked ? '#ff555559' : '#ffffff55'; ctx.fill(); ctx.lineWidth = 1.5 / scale; ctx.strokeStyle = blocked ? '#ff7373' : '#ffffff'; ctx.stroke();
        }
      }
    }
  }, [session, size, scale, origin.x, origin.y, worldWidth, worldHeight, revision, hover, brush, radius, art, artRaster, world]);

  const coordinates = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const u = (event.clientX - bounds.left - origin.x) / (30 * scale); const v = (event.clientY - bounds.top - origin.y) / (15 * scale);
    return { x: Math.round((u + v) / 2), y: Math.round((v - u) / 2 + session.info.width) };
  };
  const drawLine = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    if (brush === 'move') return;
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
    for (let i = 0; i <= Math.min(steps, 1024); i += 1) {
      const x = Math.round(from.x + (to.x - from.x) * i / steps); const y = Math.round(from.y + (to.y - from.y) * i / steps);
      if (brush === 'remove') session.removeAt(x, y);
      else if (brush in PLACEABLE) session.place(x, y, brush as PlaceKind);
      else session.paint(x, y, brush, Number(radius));
    }
    update();
  };
  const finish = (cancel = false) => {
    if (dragging.current?.mode === 'paint') {
      if (cancel) session.cancelStroke(); else session.endStroke();
      update();
    }
    dragging.current = null;
  };
  const loadArt = async (silent = false) => {
    const bridge = window.mapDesktop;
    if (!bridge) { if (!silent) setError('网页版无法读取游戏资源，请在桌面应用中使用。'); return; }
    if (!theaterSupported(session.info.theater)) { if (!silent) setError(`暂不支持 ${session.info.theater} 地形的真实贴图。`); return; }
    setArtPending(true); setError('');
    try {
      let status = await bridge.assetStatus();
      if (!status) {
        if (silent) return;
        const folder = await bridge.chooseFolder();
        if (!folder) return;
        status = await bridge.openAssets(folder);
      }
      const next = new GameArt(session.info.theater);
      if (!await next.prepare()) { setError('没能读出该地形的图块表，请确认目录里是完整的游戏资源。'); return; }
      await next.load(collectArtNames(session, next, session.overlayNames));
      setArt(next);
      artRevision.current = revision;
      setArtRaster(renderFullMap(session, next, 2600));
      try { localStorage.setItem(ART_PREFERENCE, '1'); } catch { /* 存不下就只在本次会话生效。 */ }
      setMessage(`已载入游戏贴图（${status.files} 个资源文件），缩放低于 25% 时仍显示色块示意图。`);
    } catch (cause) { if (!silent) setError(errorMessage(cause)); }
    finally { setArtPending(false); }
  };
  const undo = () => { finish(); session.undo(); update(); };
  const redo = () => { finish(); session.redo(); update(); };
  const close = () => {
    finish();
    if (session.dirty && !window.confirm('还有未导出的地图修改。返回预览会丢弃这些修改，是否继续？')) return;
    onClose();
  };
  const activeCell = hover && session.cells.get(hover.y * 512 + hover.x);
  const here = hover && session.objectAt(hover.x, hover.y);
  const positionText = activeCell && activeCell.x === hover?.x && activeCell.y === hover?.y
    ? `格子 ${hover.x}, ${hover.y} · 高度 ${activeCell.level}${here ? ` · ${here.name}` : ''} · ${brush === 'move' ? '拖动以平移' : session.reasonAt(activeCell, brush) || '可绘制'}` : '将鼠标移到地图上查看格子信息';

  return <ToolWorkspace title="地图编辑" description={`${filename} · ${MAP_GAME_NAMES[session.game]}规则`} error={error}
    actions={<button type="button" className="work-button" onClick={close} disabled={saving}>返回预览</button>}
    status={`${session.changedCount} 格与原图不同 · ${session.objectCount} 处对象增删 · ${session.dirty ? '有未导出的修改' : '当前修改已保存或尚未修改'}`}>
    <div className="yrm-editor" onKeyDown={(event) => {
      if (saving) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      if (event.key === 'Escape') { finish(true); update(); }
    }}>
      {session.readOnly && <div className="work-error" role="status"><strong>当前地图只读</strong><ul>{[...new Set(session.readOnlyReasons)].slice(0, 6).map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
      <div className="yrm-edit-controls">
        <Select label="工具" value={brush} options={[["ore", "矿石"], ["gems", "宝石"], ["erase", "擦除资源"], ["bridge", "断桥"], ["oil", "油井"], ["airport", "科技机场"], ["hospital", "市民医院"], ["oretree", "矿石树"], ["remove", "删除对象"], ["move", "平移画布"]]} onChange={(value) => { finish(); setBrush(value); }} />
        <Select label="画笔" value={radius} options={[["0", "1 × 1"], ["1", "3 × 3"], ["2", "5 × 5"]]} onChange={(value) => { finish(); setRadius(value); }} />
        <Select label="缩放" value={zoom} options={[["1", "适应窗口"], ["2", "2×"], ["4", "4×"], ["8", "8×"]]} onChange={(value) => { finish(); setZoom(value); setPan({ x: 0, y: 0 }); }} />
        <button type="button" className="work-button" disabled={artPending || saving} onClick={() => {
          if (!art) { void loadArt(); return; }
          setArt(null); setArtRaster(null); artRevision.current = -1;
          try { localStorage.setItem(ART_PREFERENCE, '0'); } catch { /* 忽略存储不可用。 */ }
          setMessage('已切回色块示意图。');
        }}>{artPending ? '载入贴图…' : art ? '示意图' : '真实贴图'}</button>
        <button type="button" className="work-button" disabled={!session.canUndo || saving} onClick={undo}>撤销</button>
        <button type="button" className="work-button" disabled={!session.canRedo || saving} onClick={redo}>重做</button>
        <Action primary disabled={session.readOnly || !session.dirty || session.activeStroke || saving} onAction={async () => {
          setSaving(true); setError('');
          try {
            const bytes = session.exportMap(); const savedOverlay = session.overlay.slice(); const savedFrames = session.frames.slice();
            const name = mapOutputName(filename, 'edited');
            if (window.mapDesktop) {
              const path = await window.mapDesktop.saveFile({ name, base64: bytesToBase64(bytes) });
              if (!path) { setMessage('已取消导出，修改保留在编辑器中。'); return; }
            } else await saveBytes(bytes, name);
            session.markSaved(savedOverlay, savedFrames); update(); setMessage(`已导出 ${name}，缩略图已同步为资源分布示意图。`);
          } catch (cause) { setError(errorMessage(cause)); }
          finally { setSaving(false); }
        }}>另存地图</Action>
      </div>
      <div className="yrm-edit-legend"><span className="is-ore">矿石</span><span className="is-gems">宝石</span><span className="is-bridge">桥面</span><span className="is-broken">断桥</span><span className="is-building">建筑</span><span className="is-tree">树木与矿石树</span><span className="is-start">出生点</span><span>灰暗格／红色画笔：不可绘制</span></div>
      <div ref={container} className={`yrm-editor-viewport${brush === 'move' ? ' is-panning' : ''}`}>
        <canvas ref={canvas} style={{ width: '100%', height: 480 }} tabIndex={0} aria-label="地图编辑画布"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (saving || dragging.current || (event.button !== 0 && event.button !== 1)) return;
            event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
            const point = coordinates(event); const moving = brush === 'move' || event.button === 1;
            dragging.current = { id: event.pointerId, mode: moving ? 'move' : 'paint', clientX: event.clientX, clientY: event.clientY, ...point, pan };
            if (!moving) { session.beginStroke(); drawLine(point, point); }
          }}
          onPointerMove={(event) => {
            const point = coordinates(event); setHover(point); const drag = dragging.current;
            if (!drag || event.pointerId !== drag.id) return;
            if (drag.mode === 'move') setPan({ x: drag.pan.x + event.clientX - drag.clientX, y: drag.pan.y + event.clientY - drag.clientY });
            else { drawLine(drag, point); drag.x = point.x; drag.y = point.y; }
          }}
          onPointerUp={(event) => { if (dragging.current?.id !== event.pointerId) return; finish(); event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} onPointerLeave={() => { if (!dragging.current) setHover(null); }} />
      </div>
      <div className="yrm-editor-position" role="status">{positionText}</div>
      <p className="yrm-preview-note">{message}</p>
      <p className="yrm-preview-note">按原版{MAP_GAME_NAMES[session.game]}规则绘制等距格子示意图。矿石和宝石使用满量；断桥沿桥身逐格断开整条桥面并自动补上断口。油井、机场、医院、矿石树按原版占地放置，删除对象可移除地图上任意建筑与树木，这几项都不受画笔大小影响。可用平移工具或鼠标中键移动画布。⌘Z 撤销，⇧⌘Z 重做。</p>
    </div>
  </ToolWorkspace>;
}
