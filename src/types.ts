/**
 * 遮盖框以 PDF 页面坐标（用户空间单位，1 单位 = 1/72 英寸，原点为页面左下角，
 * 基于未旋转的页面）保存，因此缩放、旋转、切换页面后位置不会漂移。
 */
export interface RedactionBox {
  id: string;
  /** 已归一化：x1 < x2, y1 < y2 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 页码（从 1 开始） -> 该页的遮盖框列表 */
export type RedactionMap = Record<number, RedactionBox[]>;

export type Tool = 'draw' | 'select';

/** 文本查找命中：某个查询词在某页上的一次出现，坐标与 RedactionBox 同一坐标系 */
export interface FindCandidate {
  id: string;
  page: number;
  /** 命中的查询词（归一化空白后） */
  query: string;
  /** 实际命中字形范围对应的候选框；换行时一次命中会产生多个框 */
  boxes: RedactionBox[];
  /** 是否与已有遮盖坐标重合（重复搜索 / 重复应用时跳过） */
  existing: boolean;
  /** 结果列表中的勾选状态 */
  selected: boolean;
}

/** 查找结果按页分组 */
export interface FindPageGroup {
  page: number;
  candidates: FindCandidate[];
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `box-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
