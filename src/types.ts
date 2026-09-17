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

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `box-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
