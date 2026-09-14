export interface ExportFile { name: string; base64: string }

export interface AssetStatus { directory: string; files: number; archives?: string[] }

export interface DesktopBridge {
  platform: string;
  saveFile(file: ExportFile): Promise<string | null>;
  openAssets(directory: string): Promise<AssetStatus>;
  assetStatus(): Promise<AssetStatus | null>;
  readAsset(name: string): Promise<string | null>;
  chooseFolder(): Promise<string | null>;
}

declare global {
  interface Window { mapDesktop?: DesktopBridge }
}
