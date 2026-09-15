import { decodeShpFrame, GameArt, readTile, TILE_HEIGHT, TILE_WIDTH, type Palette } from './game-art';
import { PLACEABLE, type MapCell, type YrmEditSession } from './yrm-editor';

export type View = { left: number; top: number; width: number; height: number };
// 建筑和树高过格子，向上多留一截才不会画到一半。
const OVERHANG = 200;

export const mapX = (session: YrmEditSession, x: number, y: number) => (x - y + session.info.width) * (TILE_WIDTH / 2);
export const mapY = (session: YrmEditSession, x: number, y: number, level = 0) => (x + y - session.info.width) * (TILE_HEIGHT / 2) - level * (TILE_HEIGHT / 2);

// 地图实际用到的贴图文件，载入前先收集一遍，避免逐格触发 IPC。
export function collectArtNames(session: YrmEditSession, art: GameArt, overlays: readonly string[]): string[] {
  const names = new Set<string>();
  for (const cell of session.cells.values()) {
    const file = art.tileFile(cell.tile);
    if (file) names.add(file);
    const overlay = session.overlay[cell.y * 512 + cell.x];
    if (overlay !== 255) {
      const name = overlays[overlay];
      if (name) names.add(`${name.toLowerCase()}.${art.extension}`);
    }
  }
  for (const object of session.objects) {
    if (!object.name) continue;
    names.add(object.kind === 'building' || object.kind === 'unit' ? `${object.name.toLowerCase()}.shp` : `${object.name.toLowerCase()}.${art.extension}`);
  }
  return [...names];
}

// 编辑器能放进地图的对象与覆盖物，进编辑器时一并预载，放下去就能画出来。
export function editingArtNames(session: YrmEditSession, art: GameArt): string[] {
  const names = new Set<string>();
  for (const spec of Object.values(PLACEABLE)) {
    names.add(spec.section === 'structures' ? `${spec.name.toLowerCase()}.shp` : `${spec.name.toLowerCase()}.${art.extension}`);
  }
  for (const id of session.editableOverlays) {
    const name = session.overlayNames[id];
    if (name) names.add(`${name.toLowerCase()}.${art.extension}`);
  }
  return [...names];
}

function blit(image: ImageData, pixels: Uint8Array, width: number, height: number, left: number, top: number, palette: Palette): void {
  const data = image.data;
  for (let y = 0; y < height; y += 1) {
    const ty = top + y;
    if (ty < 0 || ty >= image.height) continue;
    for (let x = 0; x < width; x += 1) {
      const value = pixels[y * width + x];
      if (!value) continue;
      const tx = left + x;
      if (tx < 0 || tx >= image.width) continue;
      const at = (ty * image.width + tx) * 4;
      data[at] = palette[value * 3]; data[at + 1] = palette[value * 3 + 1]; data[at + 2] = palette[value * 3 + 2]; data[at + 3] = 255;
    }
  }
}

function drawShp(image: ImageData, art: GameArt, file: string, frameIndex: number, centreX: number, centreY: number, view: View, palette: Palette): boolean {
  const shp = art.shp(file);
  if (!shp?.count) return false;
  const frame = shp.frames[Math.min(Math.max(0, frameIndex), shp.count - 1)];
  if (!frame?.width || !frame.height) return false;
  const left = Math.round(centreX - view.left + (TILE_WIDTH - shp.width) / 2 + frame.x);
  const top = Math.round(centreY - view.top + (TILE_HEIGHT - shp.height) / 2 + frame.y);
  if (left > image.width || top > image.height || left + frame.width < 0 || top + frame.height < 0) return false;
  blit(image, decodeShpFrame(shp, shp.frames.indexOf(frame)), frame.width, frame.height, left, top, palette);
  return true;
}

export type RenderStats = { terrain: number; overlays: number; objects: number };

export function renderMap(image: ImageData, session: YrmEditSession, art: GameArt, view: View, overlays: readonly string[], order: readonly MapCell[]): RenderStats {
  const stats: RenderStats = { terrain: 0, overlays: 0, objects: 0 };
  const objectsByCell = new Map<number, typeof session.objects>();
  for (const object of session.objects) {
    const anchorX = object.x + object.width - 1; const anchorY = object.y + object.height - 1;
    const key = anchorY * 512 + anchorX;
    const list = objectsByCell.get(key);
    if (list) list.push(object); else objectsByCell.set(key, [object]);
  }
  const tiles = new Map<string, Uint8Array | null>();
  for (const cell of order) {
    const left = mapX(session, cell.x, cell.y) - view.left;
    const top = mapY(session, cell.x, cell.y, cell.level) - view.top;
    if (left > image.width || left + TILE_WIDTH < 0 || top > image.height + OVERHANG || top + TILE_HEIGHT + OVERHANG < 0) continue;
    const file = art.tileFile(cell.tile);
    if (file) {
      const key = `${file}#${cell.subTile}`;
      if (!tiles.has(key)) {
        const bytes = art.bytes(file);
        tiles.set(key, bytes ? readTile(bytes, cell.subTile)?.pixels ?? null : null);
      }
      const pixels = tiles.get(key);
      if (pixels) { blit(image, pixels, TILE_WIDTH, TILE_HEIGHT, Math.round(left), Math.round(top), art.isoPalette); stats.terrain += 1; }
    }
    const id = cell.y * 512 + cell.x;
    const overlay = session.overlay[id];
    if (overlay !== 255) {
      const name = overlays[overlay];
      if (name && drawShp(image, art, `${name.toLowerCase()}.${art.extension}`, session.frames[id], mapX(session, cell.x, cell.y), mapY(session, cell.x, cell.y, cell.level), view, art.isoPalette)) stats.overlays += 1;
    }
    for (const object of objectsByCell.get(id) ?? []) {
      const centreX = mapX(session, object.x + (object.width - 1) / 2, object.y + (object.height - 1) / 2);
      const centreY = mapY(session, object.x + (object.width - 1) / 2, object.y + (object.height - 1) / 2, cell.level);
      const building = object.kind === 'building' || object.kind === 'unit';
      const file = building ? `${object.name.toLowerCase()}.shp` : `${object.name.toLowerCase()}.${art.extension}`;
      if (drawShp(image, art, file, 0, centreX, centreY, view, building ? art.unitPalette : art.isoPalette)) stats.objects += 1;
    }
  }
  return stats;
}

// 按格子的实际投影范围取边界，避免整图留出大片空白。
export function worldSize(session: YrmEditSession) {
  let left = Infinity; let right = -Infinity; let top = Infinity; let bottom = -Infinity;
  for (const cell of session.cells.values()) {
    const x = mapX(session, cell.x, cell.y); const y = mapY(session, cell.x, cell.y, cell.level);
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (!Number.isFinite(left)) return { left: 0, top: 0, width: TILE_WIDTH, height: TILE_HEIGHT };
  return { left, top: top - OVERHANG, width: right - left + TILE_WIDTH, height: bottom - top + TILE_HEIGHT + OVERHANG };
}

// 整图按块渲染再缩放贴到目标画布，避免为整张地图一次分配上亿像素。
export function renderFullMap(session: YrmEditSession, art: GameArt, maxWidth: number): HTMLCanvasElement {
  const world = worldSize(session);
  const scale = Math.min(1, maxWidth / world.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(world.width * scale));
  canvas.height = Math.max(1, Math.round(world.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const step = 1600;
  const buffer = document.createElement('canvas');
  const bufferContext = buffer.getContext('2d', { willReadFrequently: true });
  if (!bufferContext) return canvas;
  const order = session.drawOrder;
  const overlays = session.overlayNames;
  for (let top = 0; top < world.height; top += step) {
    for (let left = 0; left < world.width; left += step) {
      const tileWidth = Math.min(step, Math.ceil(world.width - left));
      const tileHeight = Math.min(step, Math.ceil(world.height - top));
      if (buffer.width !== tileWidth || buffer.height !== tileHeight) { buffer.width = tileWidth; buffer.height = tileHeight; }
      const image = bufferContext.createImageData(tileWidth, tileHeight);
      const stats = renderMap(image, session, art, { left: world.left + left, top: world.top + top, width: tileWidth, height: tileHeight }, overlays, order);
      if (!stats.terrain && !stats.objects && !stats.overlays) continue;
      bufferContext.putImageData(image, 0, 0);
      // 目标多画一像素，盖住相邻块缩放后的接缝
      context.drawImage(buffer, 0, 0, tileWidth, tileHeight, left * scale, top * scale, tileWidth * scale + 1, tileHeight * scale + 1);
    }
  }
  return canvas;
}
