import { describe, expect, it } from 'vitest';
import { buildResultsCsv } from './exportCsv';
import type { Query } from './types';

const queries: Query[] = [
  { start: 0, end: 1, k: 1 },
  { start: 2, end: 6, k: 3 },
];
const answers = [65535, 42];

describe('buildResultsCsv：原查询顺序、精确整数、可选 MAD 列', () => {
  it('未启用：六列，与既有结果流程一致', () => {
    const csv = buildResultsCsv(queries, answers);
    expect(csv).toBe(
      '查询下标,start,end,k,窗口长度,第k小值\n' +
        '0,0,1,1,1,65535\n' +
        '1,2,6,3,4,42\n',
    );
  });

  it('启用：追加 MAD 列，bigint 按精确十进制写出（无千分位/无科学计数法）', () => {
    const csv = buildResultsCsv(queries, answers, [0n, 6_553_500_000n]);
    expect(csv).toBe(
      '查询下标,start,end,k,窗口长度,第k小值,中位绝对偏差总量\n' +
        '0,0,1,1,1,65535,0\n' +
        '1,2,6,3,4,42,6553500000\n',
    );
  });

  it('空查询：仅表头', () => {
    expect(buildResultsCsv([], [], null)).toBe(
      '查询下标,start,end,k,窗口长度,第k小值\n',
    );
    expect(buildResultsCsv([], [], [])).toBe(
      '查询下标,start,end,k,窗口长度,第k小值,中位绝对偏差总量\n',
    );
  });

  it('行数与下标严格对应查询顺序', () => {
    const qs: Query[] = [
      { start: 7, end: 8, k: 1 },
      { start: 0, end: 200000, k: 200000 },
    ];
    const csv = buildResultsCsv(qs, [12, 0], [34n, 56n]);
    const lines = csv.trim().split('\n');
    expect(lines[1]).toBe('0,7,8,1,1,12,34');
    expect(lines[2]).toBe('1,0,200000,200000,200000,0,56');
  });
});
