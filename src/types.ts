/** 读数值域：0..65535（16 位无符号整数） */
export const VALUE_MIN = 0;
export const VALUE_MAX = 65535;
export const READINGS_MAX = 200_000;
export const QUERIES_MAX = 100_000;

/**
 * 扫描文件字节数硬上限（16 MiB），在读取文本前拦截。
 * 契约最坏情况（10 万个最长字段的查询 + 20 万条读数）的紧凑 JSON
 * 也不足 10 MiB，合法文件必然通过；超限文件不得读入内存或参与解析。
 */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** 以中文习惯格式化字节数，供错误提示使用 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 单个查询，区间按半开 [start, end) 解释 */
export interface Query {
  start: number;
  end: number;
  k: number;
}

export interface AnalysisOptions {
  /**
   * 是否同时计算每个窗口的「较低中位数绝对偏差总量」（默认 false）。
   * 关闭时结果与三段拼接之外的既有流程完全一致；
   * 开启时复用同一份 Wavelet Matrix 索引，不逐窗口复制排序。
   */
  includeMad?: boolean;
}

export interface AnalysisResult {
  ok: boolean;
  /** 读入时的查询总数（失败时为 0） */
  queryCount: number;
  /** 与原 queries 顺序一一对应的第 k 小值；失败时为空数组 */
  answers: number[];
  /**
   * 与原 queries 顺序一一对应的「较低中位数绝对偏差总量」（bigint 精确值）。
   * - includeMad 关闭：恒为 null（既有调用方据此保持原行为）；
   * - includeMad 开启且成功：与 answers 等长的 bigint 数组（单元素窗口为 0n）；
   * - 校验/解析失败：恒为 null，绝不留下半截数据。
   */
  madTotals: bigint[] | null;
  /** 校验/解析错误，按数组下标反馈；成功时为空 */
  errors: string[];
  /** 统计摘要，便于质检员核对与回归断言 */
  timingMs: number;
  sum: number;
  /**
   * madTotals 的精确总和（bigint），不受展示舍入与整数溢出影响；
   * includeMad 关闭或失败时为 null。
   */
  madSum: bigint | null;
  /** FNV-1a 风格 32 位摘要（取模），对完整答案序列敏感 */
  digest: number;
}
