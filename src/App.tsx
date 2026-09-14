import { YRMPreviewTool } from './tools/YRMPreviewTool';

export default function App() {
  return <div className="ramap-app">
    <div className="ramap-titlebar" />
    <main className="ramap-content"><YRMPreviewTool /></main>
  </div>;
}
