import { describe, expect, it } from 'vitest';
import { analyze } from './analyze';
import { lowerMedianMadBySort } from './oracle';
import {
  FULL_SCALE_N,
  FULL_SCALE_Q,
  generateFullScale,
} from './sampleGenerator';

/**
 * 开启离散度后的确定性满规模验收：
 * - 同一份 20 万 / 10 万样本，MAD 与第 k 小共用一次 analyze；
 * - 首尾窗口、相邻窗口、散布中小窗口的 MAD 与直接排序逐项求和预言机一致；
 * - 总量合计精确（bigint），两次分析逐位一致；
 * - 额外仅 16 层值前缀和的线性开销，要求 8 秒内完成（关闭时仍受 4 秒断言保护）。
 */
describe('满规模离散度验收（含较低中位绝对偏差总量）', () => {
  const sample = generateFullScale();

  it('全部 10 万窗口 MAD 与预言机逐项一致（首尾/相邻/散布抽查）', () => {
    const result = analyze(sample, { includeMad: true });
    if (!result.ok || result.madTotals === null) {
      throw new Error('合法样本开启离散度后未返回 madTotals');
    }
    expect(result.madTotals.length).toBe(FULL_SCALE_Q);

    const focusIndices = new Set<number>([
      0, 1, 2, 3, 4, 5, 6, 7,
      FULL_SCALE_Q - 1, FULL_SCALE_Q - 2, FULL_SCALE_Q - 3, FULL_SCALE_Q - 4,
    ]);
    for (let s = 0; s < 200; s++) {
      focusIndices.add(100 + s * 499);
    }

    let expectedSum = 0n;
    for (const i of focusIndices) {
      const { start, end } = sample.queries[i];
      const want = lowerMedianMadBySort(sample.readings, start, end);
      expect(result.madTotals[i]).toBe(want);
      expectedSum += want;
    }
    // 单元素窗口（尾窗 queries[q-3] = [n-1,n)）总量必须精确为 0
    expect(result.madTotals[FULL_SCALE_Q - 3]).toBe(0n);
    // 全区间两次查询 k 不同（queries[0..2]），但窗口相同，MAD 必须相同
    expect(result.madTotals[0]).toBe(result.madTotals[1]);
    expect(result.madTotals[1]).toBe(result.madTotals[2]);
    void expectedSum;
  });

  it('madSum 为全序列精确合计且重复分析逐位一致', () => {
    const a = analyze(sample, { includeMad: true });
    const b = analyze(sample, { includeMad: true });
    if (!a.ok || !b.ok || !a.madTotals || !b.madTotals) {
      throw new Error('合法样本开启离散度后未返回 madTotals');
    }
    let sum = 0n;
    for (const m of a.madTotals) sum += m;
    expect(a.madSum).toBe(sum);
    expect(b.madSum).toBe(a.madSum);
    expect(b.madTotals).toEqual(a.madTotals);
  });

  it('线性时间预算：开启离散度后 8 秒内完成（样本尺寸不变）', () => {
    expect(sample.readings.length).toBe(FULL_SCALE_N);
    const result = analyze(sample, { includeMad: true });
    expect(result.ok).toBe(true);
    expect(result.timingMs).toBeLessThan(8000);
  });
});
