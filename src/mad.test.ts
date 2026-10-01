import { describe, expect, it } from 'vitest';
import { WaveletMatrix } from './waveletMatrix';
import { kthBySort, lowerMedianMadBySort } from './oracle';
import { analyze } from './analyze';
import type { Query } from './types';

/**
 * 预言机为「直接排序 + 逐项绝对差求和」（见 oracle.ts，bigint 保管），
 * 与产品代码（Wavelet Matrix 分层批量统计）不共享任何中间量。
 */
function exhaustivelyCompareMad(readings: number[]) {
  const wm = new WaveletMatrix(readings, { includeMad: true });
  const n = readings.length;
  for (let start = 0; start < n; start++) {
    for (let end = start + 1; end <= n; end++) {
      const got = BigInt(wm.lowerMedianAbsDiffSum(start, end));
      const want = lowerMedianMadBySort(readings, start, end);
      if (got !== want) {
        throw new Error(
          `readings=${JSON.stringify(readings)} [${start},${end}): got ${got}, want ${want}`,
        );
      }
    }
  }
}

describe('lowerMedianAbsDiffSum 对直接排序+逐项求和预言机', () => {
  it('单元素窗口：总量恒为 0（值域两端）', () => {
    exhaustivelyCompareMad([0]);
    exhaustivelyCompareMad([65535]);
    const wm = new WaveletMatrix([0, 65535], { includeMad: true });
    expect(wm.lowerMedianAbsDiffSum(0, 1)).toBe(0);
    expect(wm.lowerMedianAbsDiffSum(1, 2)).toBe(0);
  });

  it('全相等/重复读数：中位数相等时总量为 0', () => {
    exhaustivelyCompareMad([7, 7, 7, 7, 7]);
    exhaustivelyCompareMad(new Array(30).fill(42000));
    // 偶数长度、两中位数相等：较低中位数即该值，总量仍为 0
    exhaustivelyCompareMad([5, 5, 5, 5]);
  });

  it('重复值混合：含 0、65535、交错重复与偶数窗口（取较低中位数）', () => {
    exhaustivelyCompareMad([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]);
    exhaustivelyCompareMad([65535, 0, 0, 65535, 1, 0, 65535]);
    exhaustivelyCompareMad([2, 2, 1, 1, 2, 2, 1, 1]);
  });

  it('首尾窗口与偶数长度较低中位数手算核对', () => {
    // [10,50,20,40] 排序 [10,20,40,50]，较低中位数 20（下标 1），总量 10+30+0+20=60
    const wm = new WaveletMatrix([10, 50, 20, 40], { includeMad: true });
    expect(wm.lowerMedianAbsDiffSum(0, 4)).toBe(60);
    // [50,20] 排序 [20,50]，较低中位数 20，总量 30
    expect(wm.lowerMedianAbsDiffSum(1, 3)).toBe(30);
    // 长度 5：排序 [10,20,40,50,?]——取整体 [10,50,20,40,30] 排序 [10,20,30,40,50]，中位 30，总量 60
    const wm2 = new WaveletMatrix([10, 50, 20, 40, 30], { includeMad: true });
    expect(wm2.lowerMedianAbsDiffSum(0, 5)).toBe(60);
  });

  it('随机小样本：全部子区间穷举（刻意收窄值域制造重复）', () => {
    let seed = 4321;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 60; trial++) {
      const n = 1 + Math.floor(rng() * 20);
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        vals.push(Math.floor(rng() * 7));
      }
      exhaustivelyCompareMad(vals);
    }
  });

  it('满值域随机小样本：全部子区间穷举', () => {
    let seed = 987654;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 20; trial++) {
      const n = 1 + Math.floor(rng() * 14);
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        vals.push(Math.floor(rng() * 65536));
      }
      exhaustivelyCompareMad(vals);
    }
  });
});

describe('中位绝对偏差总量：索引复用与开关行为', () => {
  it('未启用 includeMad 时不构建离散度索引，调用显式报错（既有 kth 路径不受影响）', () => {
    const wm = new WaveletMatrix([1, 2, 3]);
    expect(wm.kth(0, 3, 2)).toBe(2);
    expect(() => wm.lowerMedianAbsDiffSum(0, 3)).toThrow(/includeMad/);
  });

  it('同一窗口上 kth 与离散度计算互不干扰（重复调用一致）', () => {
    const readings = [9, 3, 7, 0, 65535, 2, 8, 4];
    const wm = new WaveletMatrix(readings, { includeMad: true });
    for (let i = 0; i < 3; i++) {
      expect(wm.kth(0, 8, 1)).toBe(kthBySort(readings, 0, 8, 1));
      expect(BigInt(wm.lowerMedianAbsDiffSum(0, 8))).toBe(
        lowerMedianMadBySort(readings, 0, 8),
      );
      expect(wm.kth(2, 7, 3)).toBe(kthBySort(readings, 2, 7, 3));
      expect(BigInt(wm.lowerMedianAbsDiffSum(2, 7))).toBe(
        lowerMedianMadBySort(readings, 2, 7),
      );
    }
  });

  it('analyze 默认关闭：madTotals/madSum 为 null，其余字段与既有结果一致', () => {
    const readings = [5, 1, 4, 2, 8, 3, 7, 6];
    const queries = [
      { start: 0, end: 8, k: 1 },
      { start: 2, end: 5, k: 2 },
      { start: 7, end: 8, k: 1 },
    ];
    const off = analyze({ readings, queries });
    expect(off.ok).toBe(true);
    expect(off.answers).toEqual([1, 4, 6]);
    expect(off.madTotals).toBeNull();
    expect(off.madSum).toBeNull();
  });

  it('analyze 开启：madTotals 按原查询顺序与 answers 并列，madSum 为精确 bigint', () => {
    const readings = [5, 1, 4, 2, 8, 3, 7, 6];
    const queries: Query[] = [
      { start: 0, end: 8, k: 1 },
      { start: 0, end: 8, k: 8 },
      { start: 2, end: 5, k: 2 },
      { start: 0, end: 1, k: 1 },
      { start: 7, end: 8, k: 1 },
      { start: 0, end: 4, k: 3 },
      { start: 1, end: 4, k: 3 },
    ];
    const on = analyze({ readings, queries }, { includeMad: true });
    expect(on.ok).toBe(true);
    expect(on.answers).toEqual([1, 8, 4, 5, 6, 4, 4]);
    expect(on.madTotals).not.toBeNull();

    const expected = queries.map((q) => lowerMedianMadBySort(readings, q.start, q.end));
    expect(on.madTotals).toEqual(expected);
    // 较低中位数与各查询的 k 无关：同一窗口即便 k 不同，MAD 也必须相同
    expect(on.madTotals![0]).toBe(on.madTotals![1]);

    let total = 0n;
    for (const m of expected) total += m;
    expect(on.madSum).toBe(total);
    expect(typeof on.madSum).toBe('bigint');
    // 第 k 小答案与摘要在开关两侧逐位一致
    const off = analyze({ readings, queries });
    expect(on.answers).toEqual(off.answers);
    expect(on.sum).toBe(off.sum);
    expect(on.digest).toBe(off.digest);
    expect(on.queryCount).toBe(off.queryCount);
  });

  it('空 queries 开启离散度：空数组与 0n，不报错', () => {
    const r = analyze({ readings: [1, 2, 3], queries: [] }, { includeMad: true });
    expect(r.ok).toBe(true);
    expect(r.madTotals).toEqual([]);
    expect(r.madSum).toBe(0n);
  });

  it('校验失败：madTotals/madSum 为 null，绝不留下半截数据', () => {
    const r = analyze(
      { readings: [1, 2, 3], queries: [{ start: 0, end: 9, k: 1 }] },
      { includeMad: true },
    );
    expect(r.ok).toBe(false);
    expect(r.answers).toEqual([]);
    expect(r.madTotals).toBeNull();
    expect(r.madSum).toBeNull();
    expect(r.queryCount).toBe(0);
  });
});

describe('中位绝对偏差总量：最大合法总量不受整数溢出/展示舍入影响', () => {
  it('单窗口最坏情形：一半 0、一半 65535（偶数长度，较低中位数为 0）', () => {
    // 20 万读数：前 10 万条 65535、后 10 万条 0。
    // 排序后较低中位数为下标 99999 的 0，Σ|x-0| = 100000*65535 = 6_553_500_000
    const half = 100_000;
    const readings: number[] = new Array(200_000);
    for (let i = 0; i < half; i++) readings[i] = 65535;
    for (let i = half; i < 200_000; i++) readings[i] = 0;

    const wm = new WaveletMatrix(readings, { includeMad: true });
    const got = wm.lowerMedianAbsDiffSum(0, 200_000);
    expect(Number.isSafeInteger(got)).toBe(true);
    expect(BigInt(got)).toBe(6_553_500_000n);
    expect(lowerMedianMadBySort(readings, 0, 200_000)).toBe(6_553_500_000n);
  });

  it('analyze 满规模最坏聚合：10 万个最大偏差窗口，madSum 精确等于理论上界', () => {
    // 每个查询都是同一全区间（契约允许重复窗口），10 万 * 6_553_500_000
    // = 655_350_000_000_000 < 2^53，但以 bigint 逐位断言，杜绝任何舍入
    const half = 100_000;
    const readings: number[] = new Array(200_000);
    for (let i = 0; i < half; i++) readings[i] = 65535;
    for (let i = half; i < 200_000; i++) readings[i] = 0;
    const queries: Query[] = new Array(100_000);
    queries.fill({ start: 0, end: 200_000, k: 1 });

    const r = analyze({ readings, queries }, { includeMad: true });
    expect(r.ok).toBe(true);
    expect(r.madTotals!.length).toBe(100_000);
    expect(r.madTotals![0]).toBe(6_553_500_000n);
    expect(r.madTotals![99_999]).toBe(6_553_500_000n);
    expect(r.madSum).toBe(655_350_000_000_000n);
    // 精确十进制字符串不丢位、不带科学计数法
    expect(String(r.madSum)).toBe('655350000000000');
    expect(String(r.madTotals![0])).toBe('6553500000');
  });
});
