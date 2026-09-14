export interface ExportFile { name: string; base64: string }

export interface DesktopBridge {
  platform: string;
  saveFile(file: ExportFile): Promise<string | null>;
}

declare global {
  interface Window { mapDesktop?: DesktopBridge }
}
