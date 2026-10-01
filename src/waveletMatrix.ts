/**
 * Wavelet Matrix：针对固定 16 位无符号值域（0..65535）构建。
 *
 * 复杂度（n = readings.length，BITS = 16）：
 * - 构建：O(BITS * n) 时间，O(BITS * n) 字节级前缀和空间（约 16*(n+1)*4 字节）
 * - 区间第 k 小：每查询 O(BITS)，与窗口长度无关
 *
 * 可选「离散度索引」（includeMad，默认关闭）：每层额外构建壹段元素「原值」的
 * 前缀和（Float64Array 精确承载 16 位整数的整数和），并保留一份原始读数总值
 * 前缀；全部与零/壹稳定划分同一次扫描完成，不复制任何排序。
 * 区间「较低中位数绝对偏差总量」因此也是每层 O(1)、整查询 O(BITS)，
 * 与第 k 小查询共用同一套索引组织。
 * 关闭时索引形态、构建成本与查询路径与既往完全一致。
 *
 * 因此 20 万读数 + 10 万查询的总工作量约为 16*(20万 + 10万) 次常数级操作，
 * 远快于逐窗口复制排序。
 */
export const BITS = 16;

export interface WaveletMatrixOptions {
  /** 是否额外构建中位数绝对偏差总量所需的值前缀和（默认 false） */
  includeMad?: boolean;
}

export class WaveletMatrix {
  private readonly n: number;
  /** pref[b] 为第 b 层（从高位 BITS-1 到 0）的 1 位计数前缀和，长度 n+1 */
  private readonly pref: Int32Array[];
  /** zeroCount[b] 为第 b 层稳定划分后零段的长度 */
  private readonly zeroCount: Int32Array;
  /**
   * onesValuePref[b] 仅在 includeMad 时构建：第 b 层序列位置 i 之前
   * （即前 i 个元素）所有被划入壹段的元素「原值」之和，长度 n+1。
   * 整数和上界为 n*65535 < 2^47，Float64 全程精确，无舍入。
   */
  private readonly onesValuePref: Float64Array[] | null;
  /**
   * 原始读数（第 0 层序列）的全值前缀和，长度 n+1，仅 includeMad 时构建。
   * 查询时作为随遍历携带的「当前区间值和」初值；每层后区间只保留零段或壹段，
   * 携带值和按 onesValuePref 折减即可，无需为其余 15 层另存全值前缀。
   */
  private readonly inputValuePref: Float64Array | null;

  constructor(values: ArrayLike<number>, options: WaveletMatrixOptions = {}) {
    const includeMad = options.includeMad === true;
    this.n = values.length;
    const pref: Int32Array[] = new Array(BITS);
    const zeroCount = new Int32Array(BITS);
    const onesValuePref: Float64Array[] | null = includeMad ? new Array(BITS) : null;

    // 当前层序列；读数值域 0..65535，Uint16Array 精确容纳
    let cur: Uint16Array = new Uint16Array(this.n);
    let inputValuePref: Float64Array | null = null;
    for (let i = 0; i < this.n; i++) {
      cur[i] = values[i];
    }
    if (includeMad) {
      inputValuePref = new Float64Array(this.n + 1);
      for (let i = 0; i < this.n; i++) {
        inputValuePref[i + 1] = inputValuePref[i] + values[i];
      }
    }

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = new Int32Array(this.n + 1);
      // 与位计数前缀和同一次扫描构建，不增加额外遍历，也不复制排序
      const ovp = includeMad ? new Float64Array(this.n + 1) : null;
      const zeros = new Uint16Array(this.n);
      const ones = new Uint16Array(this.n);
      let z = 0;
      let o = 0;

      for (let i = 0; i < this.n; i++) {
        const v = cur[i];
        const bit = (v >>> b) & 1;
        p[i + 1] = p[i] + bit;
        if (ovp !== null) {
          ovp[i + 1] = ovp[i] + (bit === 1 ? v : 0);
        }
        if (bit === 0) {
          zeros[z++] = v;
        } else {
          ones[o++] = v;
        }
      }

      pref[level] = p;
      zeroCount[level] = z;
      if (onesValuePref !== null && ovp !== null) {
        onesValuePref[level] = ovp;
      }

      // 稳定划分：下一层 = 零段拼接壹段
      const next = new Uint16Array(this.n);
      next.set(zeros.subarray(0, z), 0);
      next.set(ones.subarray(0, o), z);
      cur = next;
    }

    this.pref = pref;
    this.zeroCount = zeroCount;
    this.onesValuePref = onesValuePref;
    this.inputValuePref = inputValuePref;
  }

  /**
   * 半开区间 [start, end) 内的第 k 小值（k 从 1 开始）。
   * 调用方负责保证 0≤start<end≤n 且 1≤k≤end-start。
   */
  kth(start: number, end: number, k: number): number {
    let l = start;
    let r = end;
    let answer = 0;

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = this.pref[level];
      const onesL = p[l];
      const onesR = p[r];
      const zerosInRange = r - l - (onesR - onesL);

      if (k <= zerosInRange) {
        // 进入零段：位置 p 映射为 p - rank1(p)
        l -= onesL;
        r -= onesR;
      } else {
        // 进入壹段：答案该位为 1，位置 p 映射为 zeroCount + rank1(p)
        answer |= 1 << b;
        k -= zerosInRange;
        l = this.zeroCount[level] + onesL;
        r = this.zeroCount[level] + onesR;
      }
    }

    return answer;
  }

  /**
   * 半开区间 [start, end) 内的「较低中位数绝对偏差总量」：
   * 取较低中位数（排序后下标 floor((w-1)/2)，w 为偶数时取两中位数的较小者），
   * 精确累加窗口内每个读数到该中位数的绝对差（中位数自身贡献 0，含重复读数；
   * 单元素窗口结果为 0）。
   *
   * 复用本矩阵的层状组织，一次自高位到低位的遍历同时完成：
   * - 像 kth 一样跟随较低中位数的秩（rank）确定中位数；
   * - 每层把与中位数该位分叉的元素整批归类为严格小于 / 严格大于，
   *   借助 onesValuePref 与随遍历携带的当前区间值和，O(1) 取得这批元素的
   *   个数与原值和，不为任何窗口复制、排序或逐读数扫描。
   *
   * 最终 Σ|x − median| = (Σgreater − cntGreater·m) + (cntLess·m − Σless)，
   * 各中间量均为 ≤ n·65535（< 2^47）的整数，Float64 全程精确，
   * 由调用方转 BigInt 保存，不受展示舍入与整数溢出影响。
   * 必须以 includeMad:true 构建索引，否则调用非法。
   */
  lowerMedianAbsDiffSum(start: number, end: number): number {
    const ovps = this.onesValuePref;
    const inputPref = this.inputValuePref;
    if (ovps === null || inputPref === null) {
      throw new Error('当前 WaveletMatrix 未启用离散度索引（includeMad），无法计算中位数绝对偏差总量');
    }

    const w = end - start;
    // 较低中位数的秩（从 1 开始）：w 奇取正中位，w 偶取两中位数的较小者
    let rank = ((w - 1) >> 1) + 1;

    let l = start;
    let r = end;
    let median = 0;
    // 当前层映射区间 [l,r) 内元素「原值」之和；初值为原始窗口值和（精确整数）
    let rangeSum = inputPref[end] - inputPref[start];
    // 已分叉为严格小于 / 严格大于中位数的元素个数与原值之和
    let lessCount = 0;
    let lessSum = 0;
    let greaterCount = 0;
    let greaterSum = 0;

    for (let level = 0; level < BITS; level++) {
      const p = this.pref[level];
      const ovp = ovps[level];
      const onesL = p[l];
      const onesR = p[r];
      const onesInRange = onesR - onesL;
      const zerosInRange = r - l - onesInRange;
      // 当前区间内壹段（该位为 1）元素的原值和，前缀差精确给出
      const onesValInRange = ovp[r] - ovp[l];

      if (rank <= zerosInRange) {
        // 中位数该位为 0、走零段：壹段元素在该位分叉，严格大于中位数
        median <<= 1;
        greaterCount += onesInRange;
        greaterSum += onesValInRange;
        // 下一层区间只保留零段：位置与值和同步折减
        l -= onesL;
        r -= onesR;
        rangeSum -= onesValInRange;
      } else {
        // 中位数该位为 1、走壹段：零段元素在该位分叉，严格小于中位数；
        // 零段原值和 = 区间总值和 − 壹段值和（恒等拆分，精确）
        rank -= zerosInRange;
        median = (median << 1) | 1;
        lessCount += zerosInRange;
        lessSum += rangeSum - onesValInRange;
        l = this.zeroCount[level] + onesL;
        r = this.zeroCount[level] + onesR;
        rangeSum = onesValInRange;
      }
    }

    // 剩余始终与中位数同路的元素恰为全部等于中位数的读数（贡献 0）
    return greaterSum - greaterCount * median + lessCount * median - lessSum;
  }
}
