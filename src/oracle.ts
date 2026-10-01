/**
 * 小样本预言机：直接复制窗口并排序，取第 k 小（k 从 1 开始）。
 * 仅供 Vitest 与页面内的抽查使用；满规模性能由 Wavelet Matrix 保证。
 */
export function kthBySort(values: ArrayLike<number>, start: number, end: number, k: number): number {
  const slice: number[] = [];
  for (let i = start; i < end; i++) {
    slice.push(values[i]);
  }
  slice.sort((a, b) => a - b);
  return slice[k - 1];
}

/**
 * 独立预言机：直接复制窗口、排序取「较低中位数」（排序后下标 floor((w-1)/2)，
 * w 为偶数时取两中位数的较小者），再逐项 |读数 − 中位数| 累加。
 *
 * 刻意不共享 Wavelet Matrix 的任何中间量，逐项求和也用 bigint 保管，
 * 作为产品代码（矩阵分层批量统计）的独立参照：重复读数、中位数相等、
 * 单元素窗口、0/65535 边界与最大合法总量都必须逐位一致。
 */
export function lowerMedianMadBySort(
  values: ArrayLike<number>,
  start: number,
  end: number,
): bigint {
  const slice: number[] = [];
  for (let i = start; i < end; i++) {
    slice.push(values[i]);
  }
  slice.sort((a, b) => a - b);
  const median = slice[(slice.length - 1) >> 1];
  const m = BigInt(median);
  let total = 0n;
  for (const v of slice) {
    const x = BigInt(v);
    total += x >= m ? x - m : m - x;
  }
  return total;
}

/** 判定两个整数数组完全一致 */
export function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
