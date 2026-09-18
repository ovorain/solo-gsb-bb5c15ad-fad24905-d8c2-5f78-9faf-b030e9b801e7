import { useMemo, useState } from 'react';
import type { FindPageGroup } from '../types';

export type FindStatus =
  | { kind: 'idle' }
  | { kind: 'scanning'; done: number; total: number }
  | { kind: 'done'; cancelled: boolean }
  | { kind: 'empty-query' };

export interface ApplyResult {
  added: number;
  skipped: number;
}

interface Props {
  status: FindStatus;
  groups: FindPageGroup[];
  /** 无可提取文字的页码（扫描完成后有值） */
  noTextPages: number[];
  /** 应用后提示信息 */
  applyInfo: ApplyResult | null;
  onSearch(raw: string): void;
  onCancel(): void;
  onApply(): void;
  onClose(): void;
  onToggle(candidateId: string): void;
  onTogglePage(page: number, select: boolean): void;
  onSelectAll(select: boolean): void;
  onJumpPage(page: number): void;
  onJumpItem(candidateId: string, page: number): void;
  onHover(id: string | null): void;
}

/** 三态复选框：本页候选部分勾选时显示半选 */
function TriCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange(): void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function FindPanel(props: Props) {
  const { status, groups } = props;
  const [raw, setRaw] = useState('');

  const scanning = status.kind === 'scanning';
  const allCandidates = useMemo(() => groups.flatMap((g) => g.candidates), [groups]);
  const applicable = allCandidates.filter((c) => !c.existing);
  const selectable = applicable.filter((c) => c.selected);
  const allChecked = applicable.length > 0 && selectable.length === applicable.length;
  const someChecked = selectable.length > 0 && selectable.length < applicable.length;

  const totalHits = allCandidates.length;
  const existingCount = allCandidates.length - applicable.length;

  const runSearch = () => props.onSearch(raw);

  return (
    <aside className="find-panel">
      <div className="find-header">
        <span>文本查找遮盖</span>
        <button className="find-close" title="关闭面板" onClick={props.onClose}>
          ×
        </button>
      </div>

      <div className="find-body">
        <textarea
          className="find-input"
          placeholder={'输入要查找的词或短语，每行一个\n例如：\n身份证号\n张三'}
          value={raw}
          disabled={scanning}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              runSearch();
            }
          }}
          spellCheck={false}
        />

        <div className="find-actions">
          <button className="primary" disabled={scanning} onClick={runSearch}>
            {status.kind === 'idle' || totalHits === 0 ? '查找' : '重新查找'}
          </button>
          {scanning ? (
            <button onClick={props.onCancel}>取消</button>
          ) : (
            <button
              disabled={applicable.length === 0 || selectable.length === 0}
              onClick={props.onApply}
              title="将勾选项一次性加入遮盖（整批仅产生一条撤销记录）"
            >
              加入遮盖{selectable.length > 0 ? `（${selectable.length}）` : ''}
            </button>
          )}
        </div>

        {scanning && (
          <div className="find-status scanning">
            正在扫描第 {status.done} / {status.total} 页…
            <div className="find-progress">
              <div
                className="find-progress-bar"
                style={{ width: `${(status.done / Math.max(1, status.total)) * 100}%` }}
              />
            </div>
          </div>
        )}

        {status.kind === 'empty-query' && (
          <div className="find-status warn">请输入至少一个非空查找词（每行一个）。</div>
        )}

        {status.kind === 'done' && status.cancelled && (
          <div className="find-status warn">已取消扫描，以下为已扫描页面的结果。</div>
        )}

        {status.kind === 'done' && !status.cancelled && totalHits === 0 && (
          <div className="find-status warn">
            没有找到匹配内容。请检查用词；纯扫描件等无文字层的页面无法文本查找。
          </div>
        )}

        {props.applyInfo && (
          <div className="find-status ok">
            已加入 {props.applyInfo.added} 处遮盖
            {props.applyInfo.skipped > 0 ? `，跳过 ${props.applyInfo.skipped} 处重复候选` : ''}
            （可一键撤销）。
          </div>
        )}

        {totalHits > 0 && (
          <>
            <div className="find-summary">
              <TriCheckbox
                checked={allChecked}
                indeterminate={someChecked}
                disabled={applicable.length === 0}
                onChange={() => props.onSelectAll(!allChecked)}
              />
              <span>
                共 {totalHits} 处命中（{groups.filter((g) => g.candidates.length > 0).length} 页）
                {existingCount > 0 && `，${existingCount} 处与现有遮盖重复`}
              </span>
            </div>

            <div className="find-results">
              {groups
                .filter((g) => g.candidates.length > 0)
                .map((g) => {
                  const items = g.candidates;
                  const selectableItems = items.filter((c) => !c.existing);
                  const selected = selectableItems.filter((c) => c.selected).length;
                  return (
                    <div className="find-group" key={g.page}>
                      <div className="find-group-head">
                        <TriCheckbox
                          checked={
                            selectableItems.length > 0 && selected === selectableItems.length
                          }
                          indeterminate={selected > 0 && selected < selectableItems.length}
                          disabled={selectableItems.length === 0}
                          onChange={() =>
                            props.onTogglePage(g.page, selected !== selectableItems.length)
                          }
                        />
                        <button
                          className="find-page-link"
                          title="跳转到该页"
                          onClick={() => props.onJumpPage(g.page)}
                        >
                          第 {g.page} 页 · {items.length} 处
                        </button>
                      </div>
                      {items.map((c) => (
                        <label
                          key={c.id}
                          className={`find-item${c.existing ? ' existing' : ''}`}
                          title={c.existing ? '与已有遮盖坐标相同，已跳过' : '点击文字可跳转并定位到该命中'}
                          onMouseEnter={() => props.onHover(c.id)}
                          onMouseLeave={() => props.onHover(null)}
                        >
                          <TriCheckbox
                            checked={c.existing || c.selected}
                            disabled={c.existing}
                            onChange={() => props.onToggle(c.id)}
                          />
                          <span
                            className="find-item-query"
                            onClick={() => !c.existing && props.onJumpItem(c.id, g.page)}
                          >
                            {c.query}
                          </span>
                          {c.boxes.length > 1 && (
                            <span className="find-item-parts">跨 {c.boxes.length} 行</span>
                          )}
                          {c.existing && <span className="find-item-tag">已遮盖</span>}
                        </label>
                      ))}
                    </div>
                  );
                })}
            </div>
          </>
        )}

        {status.kind === 'done' && props.noTextPages.length > 0 && (
          <div className="find-status dim">
            {props.noTextPages.length} 页没有可提取文字（可能是扫描件），已跳过：第{' '}
            {compactPages(props.noTextPages)} 页
          </div>
        )}

        <p className="find-footnote">
          查找与高亮全部在浏览器本地完成，匹配仅限单页内；空白字符（含换行）统一按单个空格匹配。
        </p>
      </div>
    </aside>
  );
}

/** [1,2,3,8,9] -> "1–3、8–9" */
function compactPages(pages: number[]): string {
  const ranges: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i += 1) {
    const n = pages[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  return ranges.join('、');
}
