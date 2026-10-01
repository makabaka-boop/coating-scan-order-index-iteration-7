// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KthReview } from './KthReview';
import { lowerMedianMadBySort } from './oracle';
import type { Query } from './types';

/**
 * 浏览器侧行为验收（jsdom + Testing Library）：
 * - 开关切换：未启用时表格/导出无 MAD 列，启用后出现且与第 k 小并列；
 * - 切换文件后显示与导出严格来自新文件（统计、摘要、表格不混用两份数据）；
 * - 非法文件拒收后旧表格/导出按钮整体消失；
 * - 表格中显示的每一行（虚拟窗口可见行）与导出 CSV 同一行完全一致，
 *   且值为精确整数，不被展示舍入（MAD 走千分位、CSV 走精确十进制）。
 */

// jsdom 不实现 URL.createObjectURL：桩之并截获导出的 Blob
let lastBlob: Blob | null = null;
let lastDownloadName: string | null = null;
(URL as { createObjectURL?: (b: Blob) => string }).createObjectURL = vi.fn(
  (b: Blob) => {
    lastBlob = b;
    return 'blob:captured';
  },
) as unknown as typeof URL.createObjectURL;
URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
// 截获下载锚点的文件名（jsdom 下 click 不产生真实导航）
vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
  lastDownloadName = this.download;
});

// jsdom 26 的 Blob/File 既未实现 text()/arrayBuffer()，包装层也取不到内部缓冲。
// 安装最小的、规范等价的测试替身（保存原始片段并支持 UTF-8 读取），
// 产品代码的 file.text() 与导出截获的 Blob 因此都走与浏览器一致的解码路径。
class TextBlob {
  private readonly bytes: Uint8Array;
  readonly type: string;
  constructor(parts: BlobPart[] = [], options: BlobPropertyBag = {}) {
    const chunks: Uint8Array[] = parts.map((p) => {
      if (typeof p === 'string') return new TextEncoder().encode(p);
      if (p instanceof ArrayBuffer) return new Uint8Array(p);
      const view = p as ArrayBufferView;
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    this.bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      this.bytes.set(c, off);
      off += c.length;
    }
    this.type = options.type ?? '';
  }
  get size(): number {
    return this.bytes.length;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    ) as ArrayBuffer;
  }
}
class TextFile extends TextBlob {
  readonly name: string;
  readonly lastModified: number;
  constructor(parts: BlobPart[], name: string, options: FilePropertyBag = {}) {
    super(parts, { type: options.type ?? '' });
    this.name = name;
    this.lastModified = options.lastModified ?? Date.now();
  }
}
(globalThis as { Blob: typeof Blob }).Blob = TextBlob as unknown as typeof Blob;
(globalThis as { File: typeof File }).File = TextFile as unknown as typeof File;

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  const buf = await blob.arrayBuffer();
  // 去掉可能存在的 UTF-8 BOM
  let text = new TextDecoder().decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function loadFile(container: HTMLElement, name: string, content: string) {
  const input = container.querySelector('[data-testid="file-input"]') as HTMLInputElement;
  const file = new File([content], name, { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
}

// 两份可区分的小样本
const dataA = {
  readings: [0, 65535, 0, 65535, 100, 200, 300, 400],
  queries: [
    { start: 0, end: 4, k: 1 },
    { start: 0, end: 8, k: 8 },
    { start: 4, end: 8, k: 2 },
    { start: 7, end: 8, k: 1 },
  ] as Query[],
};
const dataB = {
  readings: [1, 2, 3, 4, 5, 6],
  queries: [
    { start: 0, end: 6, k: 1 },
    { start: 0, end: 2, k: 2 },
    { start: 5, end: 6, k: 1 },
  ] as Query[],
};

function expectedMad(data: { readings: number[]; queries: Query[] }): bigint[] {
  return data.queries.map((q) => lowerMedianMadBySort(data.readings, q.start, q.end));
}

function expectedAnswers(data: { readings: number[]; queries: Query[] }): number[] {
  return data.queries.map((q) => {
    const slice = data.readings.slice(q.start, q.end).sort((a, b) => a - b);
    return slice[q.k - 1];
  });
}

/** 解析 CSV 为行数组（数字均为十进制整数字符串） */
function parseCsv(csv: string): string[][] {
  return csv
    .trim()
    .split('\n')
    .map((line) => line.split(','));
}

afterEach(() => {
  cleanup();
  lastBlob = null;
  lastDownloadName = null;
});

describe('第 k 小复核台：离散度开关、切换文件与显示/导出一致性', () => {
  it('默认未启用：无 MAD 列与合计，导出六列精确值', async () => {
    const { container } = render(<KthReview />);
    loadFile(container, 'a.json', JSON.stringify(dataA));

    await screen.findByText('复核完成：a.json');
    expect(screen.queryByTestId('mad-cell')).toBeNull();
    expect(screen.queryByTestId('mad-sum')).toBeNull();

    fireEvent.click(screen.getByTestId('export-csv'));
    await waitFor(() => expect(lastBlob).not.toBeNull());
    const rows = parseCsv(await blobText(lastBlob!));
    expect(rows[0]).toEqual(['查询下标', 'start', 'end', 'k', '窗口长度', '第k小值']);
    expect(lastDownloadName).toBe('kth-review-a.csv');
    const wants = expectedAnswers(dataA);
    expect(rows.slice(1).map((r) => Number(r[5]))).toEqual(wants);
  });

  it('启用后：表格出现精确 MAD 列与合计，与预言机及七列导出逐行一致', async () => {
    const { container } = render(<KthReview />);
    loadFile(container, 'a.json', JSON.stringify(dataA));
    await screen.findByText('复核完成：a.json');

    await act(async () => {
      fireEvent.click(screen.getByTestId('mad-toggle'));
    });

    // 首行 MAD：[0,65535,0,65535] 较低中位数 0，总量 131070，显示带千分位
    const cells = screen.getAllByTestId('mad-cell');
    expect(cells.length).toBeGreaterThan(0);
    const displayValues = cells.map((c) => (c.textContent ?? '').replace(/[^0-9]/g, ''));

    const wantsMad = expectedMad(dataA);
    const wantsAnswers = expectedAnswers(dataA);
    // 虚拟表只渲染前若干行，逐行与预言机的可见前缀比对（显示舍入被剥离）
    const rowsEl = screen.getAllByRole('row').slice(1); // 去掉表头行
    for (let i = 0; i < cells.length; i++) {
      expect(displayValues[i]).toBe(String(wantsMad[i]));
      // 同一行内第 k 小值与 MAD 并列、各就各位
      const answerCell = rowsEl[i].querySelector('.col-ans');
      expect(answerCell?.textContent).toBe(String(wantsAnswers[i]));
    }

    // 合计精确：逐窗口求和后同样按 zh-CN 千分位展示
    const sum = wantsMad.reduce((acc, v) => acc + v, 0n);
    const sumText = (screen.getByTestId('mad-sum').textContent ?? '').replace(/[^0-9]/g, '');
    expect(BigInt(sumText)).toBe(sum);

    // 导出七列，MAD 为精确十进制（无千分位、无科学计数法）
    fireEvent.click(screen.getByTestId('export-csv'));
    await waitFor(() => expect(lastBlob).not.toBeNull());
    const rows = parseCsv(await blobText(lastBlob!));
    expect(rows[0][6]).toBe('中位绝对偏差总量');
    expect(rows.length).toBe(dataA.queries.length + 1);
    rows.slice(1).forEach((r, i) => {
      expect(r[5]).toBe(String(wantsAnswers[i]));
      expect(r[6]).toBe(String(wantsMad[i]));
      expect(r[6]).not.toMatch(/[eE.]/);
    });

    // 可见行的「显示值 === 导出行」（去掉展示分组符后），保证不混用、不舍入
    for (let i = 0; i < cells.length; i++) {
      expect(rows[i + 1][6]).toBe(displayValues[i]);
    }
    expect(lastDownloadName).toBe('kth-review-mad-a.csv');
  });

  it('切换到文件 B：表格、合计与导出全部只反映 B，无 A 残留', async () => {
    const { container } = render(<KthReview />);
    loadFile(container, 'a.json', JSON.stringify(dataA));
    await screen.findByText('复核完成：a.json');
    // 保持开关开启，直接载入 B
    await act(async () => {
      fireEvent.click(screen.getByTestId('mad-toggle'));
    });

    loadFile(container, 'b.json', JSON.stringify(dataB));
    await screen.findByText('复核完成：b.json');

    // A 含 65535 答案；B 最大答案 6，页面不得残留 A 的答案
    expect(screen.queryByText('65535')).toBeNull();
    const cells = screen.getAllByTestId('mad-cell');
    const wantsB = expectedMad(dataB);
    for (let i = 0; i < cells.length; i++) {
      expect((cells[i].textContent ?? '').replace(/[^0-9]/g, '')).toBe(String(wantsB[i]));
    }

    fireEvent.click(screen.getByTestId('export-csv'));
    await waitFor(() => expect(lastBlob).not.toBeNull());
    const rows = parseCsv(await blobText(lastBlob!));
    expect(rows.length).toBe(dataB.queries.length + 1);
    rows.slice(1).forEach((r, i) => {
      expect(r[6]).toBe(String(wantsB[i]));
    });
  });

  it('载入非法文件：错误面板替换就绪面板，表格与导出均消失，再载入合法文件可恢复', async () => {
    const { container } = render(<KthReview />);
    loadFile(container, 'a.json', JSON.stringify(dataA));
    await screen.findByText('复核完成：a.json');
    expect(screen.getByTestId('export-csv')).toBeTruthy();

    loadFile(container, 'bad.json', '{ not json');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('bad.json');
    expect(screen.queryByTestId('export-csv')).toBeNull();
    expect(screen.queryAllByTestId('mad-cell').length).toBe(0);
    expect(screen.queryByText('65535')).toBeNull();

    // 再载入 B：开关此前为关，成功后恢复为 B 的六列结果
    loadFile(container, 'b.json', JSON.stringify(dataB));
    await screen.findByText('复核完成：b.json');
    expect(screen.getByTestId('export-csv')).toBeTruthy();
    expect(screen.queryByTestId('mad-cell')).toBeNull();
  });

  it('开关为开启时载入新文件：首次渲染即带 MAD，无需再切换', async () => {
    const { container } = render(<KthReview />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mad-toggle'));
    });
    loadFile(container, 'b.json', JSON.stringify(dataB));
    await screen.findByText('复核完成：b.json');

    const cells = screen.getAllByTestId('mad-cell');
    const wantsB = expectedMad(dataB);
    for (let i = 0; i < cells.length; i++) {
      expect((cells[i].textContent ?? '').replace(/[^0-9]/g, '')).toBe(String(wantsB[i]));
    }
  });
});
