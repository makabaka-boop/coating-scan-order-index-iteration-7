import { WaveletMatrix } from './waveletMatrix';
import { validateInput } from './validation';
import type { AnalysisOptions, AnalysisResult } from './types';

/**
 * 解析并复核一份已完成 JSON.parse 的文件内容。
 *
 * 任何结构或边界错误都整体拒绝：返回 ok:false、answers 为空、queryCount 为 0、
 * madTotals/madSum 为 null，由调用方据此清除旧结果，统计/摘要/表格/导出
 * 永远不会混用两份数据。
 *
 * options.includeMad 开启时，同一份 Wavelet Matrix 额外携带离散度索引，
 * 逐窗口计算「较低中位数绝对偏差总量」（bigint 精确值）；关闭时走原有路径，
 * 结果字段除新增的 null 槽位外与既往逐字段一致。
 */
export function analyze(data: unknown, options: AnalysisOptions = {}): AnalysisResult {
  const includeMad = options.includeMad === true;
  const verdict = validateInput(data);
  if (!verdict.ok) {
    return {
      ok: false,
      queryCount: 0,
      answers: [],
      madTotals: null,
      errors: verdict.errors,
      timingMs: 0,
      sum: 0,
      madSum: null,
      digest: 0,
    };
  }

  const { readings, queries } = verdict.input;
  const t0 =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const wm = new WaveletMatrix(readings, includeMad ? { includeMad: true } : undefined);
  const answers = new Array<number>(queries.length);
  const madTotals = includeMad ? new Array<bigint>(queries.length) : null;
  // 答案最大 65535、数量最多 10 万，总和远低于 2^53，普通 number 安全
  let sum = 0;
  // 离散度总量用 bigint 聚合：窗口数 10 万、单窗最坏约 6.5e9，
  // 虽同样低于 2^53，仍以任意精度整数保管，从根上杜绝整数溢出质疑
  let madSum = 0n;
  // FNV-1a 32 位风格摘要，逐答案写入两个字节，保证结果序列可核对
  let digest = 0x811c9dc5;

  for (let i = 0; i < queries.length; i++) {
    const { start, end, k } = queries[i];
    const v = wm.kth(start, end, k);
    answers[i] = v;
    sum += v;
    digest = fnv1aByte(digest, v & 0xff);
    digest = fnv1aByte(digest, (v >>> 8) & 0xff);

    if (madTotals !== null) {
      // 较低中位数由窗口长度自身决定，与查询的 k 无关；
      // 矩阵返回的精确整数立即转 bigint，之后不再经过任何浮点/舍入环节
      const m = BigInt(wm.lowerMedianAbsDiffSum(start, end));
      madTotals[i] = m;
      madSum += m;
    }
  }

  const t1 =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  return {
    ok: true,
    queryCount: queries.length,
    answers,
    madTotals,
    errors: [],
    timingMs: t1 - t0,
    sum,
    madSum: includeMad ? madSum : null,
    digest: digest >>> 0,
  };
}

function fnv1aByte(hash: number, byte: number): number {
  return (Math.imul(hash ^ byte, 0x01000193) >>> 0);
}
