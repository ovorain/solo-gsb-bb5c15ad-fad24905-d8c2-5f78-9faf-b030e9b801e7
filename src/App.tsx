import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjs } from './pdf/pdfjs';
import type { FindCandidate, FindPageGroup, RedactionBox, RedactionMap, Tool } from './types';
import { useUndoable } from './state/useUndoable';
import { exportRedactedPdf } from './pdf/exportPdf';
import {
  isCandidateCovered,
  parseQueries,
  scanDocument,
} from './pdf/findText';
import { Toolbar } from './components/Toolbar';
import { PageList } from './components/PageList';
import { PageCanvas } from './components/PageCanvas';
import { FindPanel, type ApplyResult, type FindStatus } from './components/FindPanel';

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

  // ---------- 文本查找遮盖 ----------
  const [findOpen, setFindOpen] = useState(false);
  const [findStatus, setFindStatus] = useState<FindStatus>({ kind: 'idle' });
  const [groups, setGroups] = useState<FindPageGroup[]>([]);
  const [noTextPages, setNoTextPages] = useState<number[]>([]);
  const [hoveredCandidate, setHoveredCandidate] = useState<string | null>(null);
  /** 请求 PageCanvas 滚动到可见区域的候选 id（点击结果项 / 悬停时设置） */
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [applyInfo, setApplyInfo] = useState<ApplyResult | null>(null);
  const cancelRef = useRef(false);
  const candidateSeq = useRef(0);
  const currentDocRef = useRef<PDFDocumentProxy | null>(null);
  const scanSeqRef = useRef(0);

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
        currentDocRef.current = pdf;
        setFileName(file.name);
        setPageNum(1);
        setRotation(0);
        setSelectedId(null);
        reset({});
        setFindOpen(false);
        setFindStatus({ kind: 'idle' });
        setGroups([]);
        setNoTextPages([]);
        setApplyInfo(null);
        setHoveredCandidate(null);
        cancelRef.current = true;
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

  // ---------- 查找 ----------
  const onSearch = useCallback(
    async (raw: string) => {
      if (!doc) return;
      const queries = parseQueries(raw);
      if (queries.length === 0) {
        setFindStatus({ kind: 'empty-query' });
        setGroups([]);
        setNoTextPages([]);
        return;
      }
      cancelRef.current = false;
      const mySeq = (scanSeqRef.current += 1);
      setApplyInfo(null);
      setHoveredCandidate(null);
      setFindStatus({ kind: 'scanning', done: 0, total: doc.numPages });
      const scanDoc = doc;
      const { pages, cancelled } = await scanDocument(scanDoc, queries, {
        onProgress: (done, total) => {
          // 已有更新的一次扫描开始时，旧扫描的进度不再回写
          if (scanSeqRef.current === mySeq) {
            setFindStatus({ kind: 'scanning', done, total });
          }
        },
        isCancelled: () => cancelRef.current || scanSeqRef.current !== mySeq,
      });
      // 扫描期间用户已导入其它文件或发起了更新的扫描，则丢弃本次结果
      if (currentDocRef.current !== scanDoc || scanSeqRef.current !== mySeq) return;
      if (cancelRef.current && cancelled) {
        setFindStatus({ kind: 'done', cancelled: true });
      } else {
        setFindStatus({ kind: 'done', cancelled: false });
      }
      const nextGroups: FindPageGroup[] = [];
      const noText: number[] = [];
      for (const r of pages) {
        if (r.noText) {
          noText.push(r.page);
          continue;
        }
        if (r.hits.length === 0) continue;
        const candidates: FindCandidate[] = r.hits.map((hit) => ({
          id: `cand-${(candidateSeq.current += 1)}`,
          page: r.page,
          query: hit.query,
          boxes: hit.boxes,
          existing: isCandidateCovered(hit, redactions[r.page] ?? []),
          selected: false,
        }));
        nextGroups.push({ page: r.page, candidates });
      }
      setGroups(nextGroups);
      setNoTextPages(noText);
    },
    [doc, redactions],
  );

  const onCancelSearch = () => {
    cancelRef.current = true;
  };

  const updateCandidate = (id: string, patch: Partial<FindCandidate>) => {
    setGroups((gs) =>
      gs.map((g) => ({
        ...g,
        candidates: g.candidates.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),
    );
  };

  const onToggleCandidate = (id: string) => {
    const target = groups.find((g) => g.candidates.some((c) => c.id === id))?.candidates.find(
      (c) => c.id === id,
    );
    if (!target || target.existing) return;
    setApplyInfo(null);
    updateCandidate(id, { selected: !target.selected });
  };

  const onTogglePage = (pageNo: number, select: boolean) => {
    setApplyInfo(null);
    setGroups((gs) =>
      gs.map((g) =>
        g.page === pageNo
          ? {
              ...g,
              candidates: g.candidates.map((c) =>
                c.existing ? c : { ...c, selected: select },
              ),
            }
          : g,
      ),
    );
  };

  const onSelectAll = (select: boolean) => {
    setApplyInfo(null);
    setGroups((gs) =>
      gs.map((g) => ({
        ...g,
        candidates: g.candidates.map((c) => (c.existing ? c : { ...c, selected: select })),
      })),
    );
  };

  /**
   * 整批加入遮盖：所有勾选候选一次性合并进 RedactionMap，
   * 只调用一次 setRedactions，因此只产生一条撤销记录。
   * 与已有遮盖坐标相同的候选跳过。
   */
  const onApply = () => {
    const chosen = groups.flatMap((g) => g.candidates).filter((c) => c.selected && !c.existing);
    if (chosen.length === 0) return;
    const next: RedactionMap = { ...redactions };
    let added = 0;
    let skipped = 0;
    // 本批内已加入的框也要参与判重
    const isDup = (pageNo: number, boxes: RedactionBox[]) =>
      isCandidateCovered({ boxes }, next[pageNo] ?? []);
    const touched = new Set<number>();
    for (const c of chosen) {
      touched.add(c.page);
      if (isDup(c.page, c.boxes)) {
        skipped += 1;
        continue;
      }
      next[c.page] = [...(next[c.page] ?? []), ...c.boxes];
      added += 1;
    }
    if (added > 0) setRedactions(next);
    // 已应用的候选标记为“已遮盖”并取消勾选，重复搜索前不会再次被加入
    setGroups((gs) =>
      gs.map((g) =>
        touched.has(g.page)
          ? {
              ...g,
              candidates: g.candidates.map((c) =>
                c.selected && !c.existing
                  ? { ...c, selected: false, existing: true }
                  : c,
              ),
            }
          : g,
      ),
    );
    setApplyInfo({ added, skipped });
  };

  // 当前页需要在画布上高亮的候选（未遮盖的）
  const currentHighlights =
    groups.find((g) => g.page === pageNum)?.candidates.filter((c) => !c.existing) ?? [];

  // 遮盖发生变化（手工删除 / 撤销 / 重做）后，重新计算候选的“与现有遮盖重合”标记，
  // 保证重复应用时始终跳过坐标相同的候选，删除遮盖后候选又可重新勾选
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  useEffect(() => {
    const gs = groupsRef.current;
    if (gs.length === 0) return;
    let changed = false;
    const next = gs.map((g) => ({
      ...g,
      candidates: g.candidates.map((c) => {
        const existing = isCandidateCovered(c, redactions[c.page] ?? []);
        if (existing === c.existing) return c;
        changed = true;
        return { ...c, existing, selected: existing ? false : c.selected };
      }),
    }));
    if (changed) setGroups(next);
  }, [redactions]);

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
        findOpen={findOpen}
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
        onToggleFind={() => setFindOpen((v) => !v)}
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
                highlights={currentHighlights}
                hoveredHighlightId={hoveredCandidate}
                scrollTargetId={scrollTarget}
                onSelect={setSelectedId}
                onAdd={addBox}
                onChange={changeBox}
              />
            )}
          </div>
          {findOpen && (
            <FindPanel
              status={findStatus}
              groups={groups}
              noTextPages={noTextPages}
              applyInfo={applyInfo}
              onSearch={(raw) => void onSearch(raw)}
              onCancel={onCancelSearch}
              onApply={onApply}
              onClose={() => setFindOpen(false)}
              onToggle={onToggleCandidate}
              onTogglePage={onTogglePage}
              onSelectAll={onSelectAll}
              onJumpPage={(n) => setPageNum(n)}
              onJumpItem={(id, pageNo) => {
                setPageNum(pageNo);
                setScrollTarget(id);
              }}
              onHover={setHoveredCandidate}
            />
          )}
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
