import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjs } from './pdf/pdfjs';
import type { RedactionBox, RedactionMap, Tool } from './types';
import { useUndoable } from './state/useUndoable';
import { exportRedactedPdf } from './pdf/exportPdf';
import { Toolbar } from './components/Toolbar';
import { PageList } from './components/PageList';
import { PageCanvas } from './components/PageCanvas';

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('');
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [zoom, setZoom] = useState(1.25);
  const [rotation, setRotation] = useState(0);
  const [tool, setTool] = useState<Tool>('draw');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    value: redactions,
    set: setRedactions,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
  } = useUndoable<RedactionMap>({});

  const numPages = doc?.numPages ?? 0;
  const boxesForPage = redactions[pageNum] ?? [];
  const totalBoxes = Object.values(redactions).reduce((sum, list) => sum + list.length, 0);

  const openFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const data = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data }).promise;
        void doc?.destroy();
        setDoc(pdf);
        setFileName(file.name);
        setPageNum(1);
        setRotation(0);
        setSelectedId(null);
        reset({});
      } catch {
        setError('无法解析该文件，请确认是有效的 PDF。');
      }
    },
    [doc, reset],
  );

  // 当前页面对象
  useEffect(() => {
    if (!doc) {
      setPage(null);
      return;
    }
    let cancelled = false;
    doc.getPage(pageNum).then(
      (p) => {
        if (!cancelled) setPage(p);
      },
      () => setError('读取页面失败。'),
    );
    return () => {
      cancelled = true;
    };
  }, [doc, pageNum]);

  // 键盘快捷键：撤销 / 重做 / 删除选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!doc) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteBox(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 拖拽 PDF 文件到窗口即可导入
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
        void openFile(file);
      } else {
        setError('请拖入 PDF 文件。');
      }
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
    };
  }, [openFile]);

  const mutatePage = (pageNo: number, fn: (boxes: RedactionBox[]) => RedactionBox[]) => {
    const next = fn(redactions[pageNo] ?? []);
    const map = { ...redactions };
    if (next.length === 0) delete map[pageNo];
    else map[pageNo] = next;
    setRedactions(map);
  };

  const addBox = (box: RedactionBox) => {
    mutatePage(pageNum, (boxes) => [...boxes, box]);
    setSelectedId(box.id);
  };

  const changeBox = (box: RedactionBox) => {
    mutatePage(pageNum, (boxes) => boxes.map((b) => (b.id === box.id ? box : b)));
  };

  const deleteBox = (id: string) => {
    mutatePage(pageNum, (boxes) => boxes.filter((b) => b.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const clearPage = () => {
    if (boxesForPage.length === 0) return;
    mutatePage(pageNum, () => []);
    setSelectedId(null);
  };

  const zoomIn = () => setZoom((z) => ZOOM_LEVELS.find((l) => l > z + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
  const zoomOut = () => setZoom((z) => [...ZOOM_LEVELS].reverse().find((l) => l < z - 0.001) ?? ZOOM_LEVELS[0]);

  const onExport = async () => {
    if (!doc || exporting) return;
    setExporting(true);
    setProgress({ done: 0, total: doc.numPages });
    setError(null);
    try {
      await exportRedactedPdf(doc, redactions, fileName, (done, total) =>
        setProgress({ done, total }),
      );
    } catch {
      setError('导出失败，请重试。');
    } finally {
      setExporting(false);
      setProgress(null);
    }
  };

  return (
    <div className="app">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = '';
        }}
      />

      <Toolbar
        hasDoc={!!doc}
        tool={tool}
        zoom={zoom}
        pageNum={pageNum}
        numPages={numPages}
        canUndo={canUndo}
        canRedo={canRedo}
        exporting={exporting}
        onOpen={() => fileInputRef.current?.click()}
        onToolChange={setTool}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onRotate={() => setRotation((r) => (r + 90) % 360)}
        onPrevPage={() => setPageNum((n) => Math.max(1, n - 1))}
        onNextPage={() => setPageNum((n) => Math.min(numPages, n + 1))}
        onUndo={undo}
        onRedo={redo}
        onClearPage={clearPage}
        onExport={() => void onExport()}
      />

      {error && <div className="error-bar">{error}</div>}
      {progress && (
        <div className="progress-bar">
          正在按 144 DPI 栅格化并烧入遮盖：第 {progress.done} / {progress.total} 页
        </div>
      )}

      {doc ? (
        <div className="main">
          <PageList pdf={doc} current={pageNum} redactions={redactions} onSelect={setPageNum} />
          <div className="viewer">
            {page && (
              <PageCanvas
                page={page}
                zoom={zoom}
                rotation={rotation}
                tool={tool}
                boxes={boxesForPage}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onAdd={addBox}
                onChange={changeBox}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="empty">
          <div className="empty-card">
            <h1>PDF 安全遮盖台</h1>
            <p>在浏览器本地对 PDF 进行不可逆遮盖：所有处理均在本机完成，文件不会上传到任何服务器。</p>
            <button className="primary big" onClick={() => fileInputRef.current?.click()}>
              选择 PDF 文件
            </button>
            <p className="hint">也可以将 PDF 文件直接拖入窗口</p>
          </div>
        </div>
      )}

      <footer className="status-bar">
        <span>{doc ? fileName : '未打开文件'}</span>
        {doc && (
          <>
            <span>本页遮盖 {boxesForPage.length} 处</span>
            <span>全文共 {totalBoxes} 处</span>
            <span>导出分辨率 144 DPI · 纯本地处理</span>
          </>
        )}
      </footer>
    </div>
  );
}
