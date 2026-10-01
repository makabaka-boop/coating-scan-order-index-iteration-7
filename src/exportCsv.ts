import type { Query } from './types';

/** 结果表列头，与页面表格逐列对应（开启离散度时多最后一列） */
const BASE_HEADER = ['查询下标', 'start', 'end', 'k', '窗口长度', '第k小值'] as const;
const MAD_HEADER = '中位绝对偏差总量';

/**
 * 按**原查询顺序**逐行构造结果 CSV（不含 BOM，纯字符串，便于测试直接核对）。
 *
 * 关键不变量：
 * - rows 与传入的 queries / answers / madTotals 来自同一次成功分析的同一负载，
 *   调用方在换文件或查询失败时整体替换/销毁负载，导出内容不可能混入两份数据；
 * - 第 k 小值与中位数绝对偏差总量都按精确整数写入（String(number) / String(bigint)），
 *   不经 toFixed、千分位等任何展示舍入；
 * - madTotals 为 null（未启用）时输出与既往结果完全一致的六列。
 */
export function buildResultsCsv(
  queries: readonly Query[],
  answers: readonly number[],
  madTotals?: readonly bigint[] | null,
): string {
  const withMad = Array.isArray(madTotals);
  const lines: string[] = [];
  lines.push(withMad ? [...BASE_HEADER, MAD_HEADER].join(',') : BASE_HEADER.join(','));

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const base = [
      String(i),
      String(q.start),
      String(q.end),
      String(q.k),
      String(q.end - q.start),
      String(answers[i]),
    ];
    if (withMad) {
      base.push(String((madTotals as readonly bigint[])[i]));
    }
    lines.push(base.join(','));
  }

  return lines.join('\n') + '\n';
}

/**
 * 触发浏览器下载：UTF-8 BOM 使 Excel 正确识别中文列头。
 * 仅此函数触碰 DOM，内容构造保持纯粹可测。
 */
export function downloadResultsCsv(
  fileName: string,
  queries: readonly Query[],
  answers: readonly number[],
  madTotals?: readonly bigint[] | null,
): void {
  const csv = buildResultsCsv(queries, answers, madTotals);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
