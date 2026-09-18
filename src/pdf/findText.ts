import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { RedactionBox } from '../types';
import { uid } from '../types';

/** 坐标比较容差（PDF 用户空间单位 = 1/72 英寸），小于该差视为同一框 */
const SAME_BOX_EPS = 0.75;
/** 相邻 text item 之间几何空隙超过 0.5 倍字号时补一个空格 */
const ITEM_GAP_RATIO = 0.5;

/** 连续空白（含换行、制表符）统一归一化为单个空格 */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** 解析用户输入：换行分隔的纯文本词组，去空白、去重、保持输入顺序 */
export function parseQueries(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const q = normalizeWhitespace(line).trim();
    if (q && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
  }
  return out;
}

interface PdfRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 扁平化页面文本流中的一个单位：字符（带字形包围盒）或空格（无盒） */
interface Unit {
  ch: string;
  /** 归一化文本中的下标 */
  index: number;
  box: PdfRect | null;
  /** 该空格由换行（hasEOL / 行间几何间隔）产生：命中跨过它时必须拆成两个框 */
  hardBreak?: boolean;
}

interface FlatPage {
  text: string;
  units: Unit[];
}

function isTextItem(it: unknown): it is TextItem {
  return !!it && typeof (it as TextItem).str === 'string';
}

/** 依据推进长度判断文本走向：竖排文字 height 为推进量、width≈0 */
function isVerticalItem(item: TextItem): boolean {
  return item.height > item.width;
}

/** 单个非空字符在 PDF 用户空间中的包围盒（水平 / 竖排通用） */
function charBox(item: TextItem, charIndex: number, len: number): PdfRect {
  const t = item.transform;
  const ux = t[0];
  const uy = t[1];
  const vx = t[2];
  const vy = t[3];
  const ox = t[4];
  const oy = t[5];
  const uLen = Math.hypot(ux, uy);
  const vLen = Math.hypot(vx, vy);
  const rectFromCorners = (corners: Array<[number, number]>): PdfRect => {
    const xs = corners.map((q) => q[0]);
    const ys = corners.map((q) => q[1]);
    return {
      x1: Math.min(...xs),
      y1: Math.min(...ys),
      x2: Math.max(...xs),
      y2: Math.max(...ys),
    };
  };

  if (isVerticalItem(item)) {
    // item.height 为整串沿 -v 的推进量（用户空间单位），均分到每个字符
    const adv = item.height && len > 0 ? item.height / len : uLen;
    const d0 = charIndex * adv;
    const d1 = (charIndex + 1) * adv;
    // 字形 em 方块沿 u 方向铺开
    const corners: Array<[number, number]> = [
      [ox - vx * (d0 / vLen), oy - vy * (d0 / vLen)],
      [ox + ux - vx * (d0 / vLen), oy + uy - vy * (d0 / vLen)],
      [ox - vx * (d1 / vLen), oy - vy * (d1 / vLen)],
      [ox + ux - vx * (d1 / vLen), oy + uy - vy * (d1 / vLen)],
    ];
    return rectFromCorners(corners);
  }

  // item.width 为整串沿 u 的推进量（用户空间单位），均分到每个字符
  const adv = item.width && len > 0 ? item.width / len : vLen;
  const d0 = charIndex * adv;
  const d1 = (charIndex + 1) * adv;
  // 盒高沿 v 方向贴合 item.height（字号），基线到 em 顶；下沉部分极少超出，
  // 这样多个同行片段的盒在垂直方向自然重叠，可可靠判定为同一文本行
  const p = (u: number, v: number): [number, number] => [
    ox + ux * (u / uLen) + vx * v,
    oy + uy * (u / uLen) + vy * v,
  ];
  const corners: Array<[number, number]> = [
    p(d0, -0.05),
    p(d1, -0.05),
    p(d0, 0.95),
    p(d1, 0.95),
  ];
  return rectFromCorners(corners);
}

/** text item 的整体包围盒与推进终点，用于判断相邻 item 间是否需要补空格 */
function itemGeometry(item: TextItem): { box: PdfRect; end: [number, number]; fontSize: number } {
  const t = item.transform;
  const ux = t[0];
  const uy = t[1];
  const vx = t[2];
  const vy = t[3];
  const ox = t[4];
  const oy = t[5];
  const uLen = Math.hypot(ux, uy);
  const vLen = Math.hypot(vx, vy);
  const rectFromCorners = (corners: Array<[number, number]>): PdfRect => {
    const xs = corners.map((q) => q[0]);
    const ys = corners.map((q) => q[1]);
    return {
      x1: Math.min(...xs),
      y1: Math.min(...ys),
      x2: Math.max(...xs),
      y2: Math.max(...ys),
    };
  };

  if (isVerticalItem(item)) {
    const total = item.height || 0;
    const corners: Array<[number, number]> = [
      [ox, oy],
      [ox + ux, oy + uy],
      [ox - vx * (total / vLen), oy - vy * (total / vLen)],
      [ox + ux - vx * (total / vLen), oy + uy - vy * (total / vLen)],
    ];
    return {
      box: rectFromCorners(corners),
      end: [ox - vx * (total / vLen), oy - vy * (total / vLen)],
      fontSize: uLen,
    };
  }

  const total = item.width || 0;
  const ex = ox + ux * (total / uLen);
  const ey = oy + uy * (total / uLen);
  const corners: Array<[number, number]> = [
    [ox + vx * -0.05, oy + vy * -0.05],
    [ex + vx * -0.05, ey + vy * -0.05],
    [ox + vx * 0.95, oy + vy * 0.95],
    [ex + vx * 0.95, ey + vy * 0.95],
  ];
  return {
    box: rectFromCorners(corners),
    end: [ex, ey],
    fontSize: vLen,
  };
}

/**
 * 把一页的 text items 扁平化为“归一化空白”的字符流：
 * - item 内部连续空白压成一个空格；
 * - item 之间按 hasEOL 或几何空隙补一个空格（可跨相邻 item 匹配单词）；
 * - 每个非空字符携带其字形包围盒。
 */
function flattenPage(items: TextItem[]): FlatPage {
  const units: Unit[] = [];
  let text = '';
  let prevGeom: ReturnType<typeof itemGeometry> | null = null;
  let pendingBreak = false;

  const pushChar = (ch: string, box: PdfRect | null, hardBreak = false) => {
    const normalized = ch === ' ' ? ' ' : ch;
    units.push({ ch: normalized, index: text.length, box, hardBreak: box ? false : hardBreak });
    text += normalized;
  };

  const pushSpace = (hardBreak: boolean) => {
    if (text.length > 0 && text[text.length - 1] === ' ') {
      // 已有的空格若原来是“软”空格，升级为硬换行
      if (hardBreak) units[units.length - 1].hardBreak = true;
      return;
    }
    pushChar(' ', null, hardBreak);
  };

  for (const raw of items) {
    if (!isTextItem(raw)) continue;
    const str = raw.str;
    if (!str) {
      if (raw.hasEOL) pendingBreak = true;
      continue;
    }
    // 纯空白 item：归一化为一个空格，但不更新 prevGeom，
    // 否则它自带的空格推进会“吃掉”后续几何空隙
    if (!str.trim()) {
      if (prevGeom) pushSpace(true);
      if (raw.hasEOL) pendingBreak = true;
      continue;
    }
    // 与上一个文本 item 的间隔：换行或几何上明显分开则补空格；
    // 只有基线在垂直方向真正错开（或 hasEOL 显式换行）才标记为硬换行
    if (prevGeom) {
      const g = itemGeometry(raw);
      const gap = Math.hypot(g.box.x1 - prevGeom.end[0], g.box.y1 - prevGeom.end[1]);
      if (
        pendingBreak ||
        gap > ITEM_GAP_RATIO * Math.max(g.fontSize, prevGeom.fontSize)
      ) {
        const lineShift = Math.abs(g.box.y1 - prevGeom.end[1]);
        const minFs = Math.min(g.fontSize, prevGeom.fontSize);
        pushSpace(pendingBreak || lineShift > 0.6 * minFs);
      }
    }
    pendingBreak = false;
    const len = str.length;
    let pendingWS = false;
    for (let i = 0; i < len; i += 1) {
      const ch = str[i];
      if (/\s/.test(ch)) {
        pendingWS = true;
        continue;
      }
      if (pendingWS) {
        pushSpace(false);
        pendingWS = false;
      }
      pushChar(ch, charBox(raw, i, len));
    }
    if (raw.hasEOL) pendingBreak = true;
    prevGeom = itemGeometry(raw);
  }
  return { text, units };
}

/** 两个垂直方向上有实质重叠的盒视为同一文本行 */
function sameLine(a: PdfRect, b: PdfRect): boolean {
  const ah = a.y2 - a.y1;
  const bh = b.y2 - b.y1;
  const tol = 0.15 * Math.min(ah, bh);
  return a.y1 < b.y2 - tol && a.y2 > b.y1 + tol;
}

/** 合并两个（在 u 方向上）相邻的矩形 */
function unionRect(a: PdfRect, b: PdfRect): PdfRect {
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}

/**
 * 依据命中字符在文本流中的顺序生成候选框：
 * - 遇到硬换行（hasEOL / 行间几何间隔）强制断开，一次跨行命中产生多个框；
 * - 同一行且中间只隔着软空格（词间距）的片段合并为一个框；
 * - 同行但几何上明显分离（>2.5 倍字号，说明中间夹有未命中的其它内容）时断开，
 *   绝不遮住同一行中未命中的间隔文字。
 * 不使用较窄的空隙阈值：pdf.js 按整串报告 width，逐字符均分后词边界会有累积误差。
 */
function buildHitBoxes(segments: Array<{ unit: Unit; rect: PdfRect }>): PdfRect[] {
  const out: PdfRect[] = [];
  let current: PdfRect | null = null;
  for (const seg of segments) {
    const r = seg.rect;
    let separated = false;
    if (current) {
      const fontSize = Math.max(1, (r.y2 - r.y1) / 1.0);
      const horizGap = Math.max(0, Math.min(
        Math.abs(r.x1 - current.x2),
        Math.abs(r.x2 - current.x1),
      ));
      separated = horizGap > 2.5 * fontSize;
    }
    if (!current || !sameLine(current, r) || seg.unit.hardBreak || separated) {
      if (current) out.push(current);
      current = { ...r };
    } else {
      current = unionRect(current, r);
    }
  }
  if (current) out.push(current);
  return out;
}

export interface RawHit {
  query: string;
  boxes: RedactionBox[];
}

/** 在单页内查找所有查询词的命中（搜索不跨页） */
export function findInPage(items: TextItem[], rawQueries: string[]): RawHit[] {
  // 查询与页面文本一致地归一化连续空白
  const queries = Array.from(new Set(rawQueries.map(normalizeWhitespace).map((q) => q.trim()).filter(Boolean)));
  if (queries.length === 0) return [];
  const { text, units } = flattenPage(items);
  if (!text.trim()) return [];
  const hits: RawHit[] = [];
  for (const query of queries) {
    let from = 0;
    while (from <= text.length - query.length) {
      const at = text.indexOf(query, from);
      if (at < 0) break;
      // 只收集命中范围内的非空字符字形盒，空格不产生遮盖；
      // 段前的单位若为硬换行，则在 buildHitBoxes 中拆框
      const segments: Array<{ unit: Unit; rect: PdfRect }> = [];
      for (let i = at; i < at + query.length; i += 1) {
        const u = units[i];
        if (u && u.box) {
          // hardBreak 标记属于它前面的间隔：把“该字符前是否跨硬换行”带进来
          const prevUnit = units[i - 1];
          segments.push({
            unit: { ...u, hardBreak: !!prevUnit?.hardBreak },
            rect: u.box,
          });
        }
      }
      if (segments.length > 0) {
        hits.push({
          query,
          boxes: buildHitBoxes(segments).map((r) => ({
            id: uid(),
            x1: r.x1,
            y1: r.y1,
            x2: r.x2,
            y2: r.y2,
          })),
        });
      }
      from = at + Math.max(1, query.length);
    }
  }
  return hits;
}

function sameBox(a: RedactionBox, b: RedactionBox): boolean {
  return (
    Math.abs(a.x1 - b.x1) <= SAME_BOX_EPS &&
    Math.abs(a.y1 - b.y1) <= SAME_BOX_EPS &&
    Math.abs(a.x2 - b.x2) <= SAME_BOX_EPS &&
    Math.abs(a.y2 - b.y2) <= SAME_BOX_EPS
  );
}

/**
 * 判断候选是否与已有遮盖坐标完全重合：
 * 候选的每个框都能在现有遮盖中找到同坐标框时视为重复。
 */
export function isCandidateCovered(
  candidate: { boxes: RedactionBox[] },
  existing: RedactionBox[],
): boolean {
  if (existing.length === 0 || candidate.boxes.length === 0) return false;
  return candidate.boxes.every((cb) => existing.some((eb) => sameBox(cb, eb)));
}

export interface ScanCallbacks {
  onProgress?(done: number, total: number): void;
  /** 每次 await 之间检查，返回 true 表示用户已取消 */
  isCancelled?(): boolean;
}

export interface ScanPageResult {
  page: number;
  hits: RawHit[];
  /** 该页完全无法提取文字（扫描件 / 无文字层） */
  noText: boolean;
}

/** 逐页提取文字并查找，纯本地执行；每若干页让出主线程以更新进度 / 响应取消 */
export async function scanDocument(
  pdf: PDFDocumentProxy,
  queries: string[],
  cb: ScanCallbacks = {},
): Promise<{ pages: ScanPageResult[]; cancelled: boolean }> {
  const pages: ScanPageResult[] = [];
  const total = pdf.numPages;
  for (let n = 1; n <= total; n += 1) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items = content.items.filter(isTextItem);
    const hasText = items.some((it) => it.str.trim().length > 0);
    if (!hasText) {
      pages.push({ page: n, hits: [], noText: true });
    } else {
      pages.push({ page: n, hits: findInPage(items, queries), noText: false });
    }
    cb.onProgress?.(n, total);
    // 每页都让出一次主线程，使进度条能刷新、取消能及时生效
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (cb.isCancelled?.()) {
      return { pages, cancelled: true };
    }
  }
  return { pages, cancelled: false };
}
