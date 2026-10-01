import { useCallback, useMemo, useRef, useState } from 'react';
import { analyze } from './analyze';
import { generateFullScale } from './sampleGenerator';
import { downloadResultsCsv } from './exportCsv';
import { MAX_FILE_BYTES, formatByteSize } from './types';
import type { AnalysisResult, Query } from './types';

interface LoadedPayload {
  fileName: string;
  /** 已整体验证通过的同一份数据，供切换离散度开关后重新分析 */
  data: { readings: number[]; queries: Query[] };
  readingsCount: number;
  queries: Query[];
  result: AnalysisResult;
  /** 本负载是否启用了「中位绝对偏差总量」；展示/导出严格以本字段为准 */
  madEnabled: boolean;
}

type ViewState =
  | { status: 'idle' }
  | { status: 'busy'; fileName: string }
  | { status: 'error'; fileName: string; errors: string[] }
  | { status: 'ready'; payload: LoadedPayload };

/** 导出文件名（ASCII 安全），随负载一起替换，绝不跨文件复用内容 */
function exportFileNameFor(fileName: string, madEnabled: boolean): string {
  const stem = fileName.replace(/\.json$/i, '');
  return `kth-review${madEnabled ? '-mad' : ''}-${stem}.csv`;
}

/**
 * 第 k 小复核台。关键不变量：
 * - 每次重新选文件/载入样本都先清空旧视图，再处理新内容；
 * - 只有全部校验通过才渲染答案，任何非法文件只显示错误、绝不留下部分答案；
 * - 答案按 queries 原顺序一一对应展示，显式打印查询下标，杜绝相邻窗口错位；
 * - 统计表、摘要与 CSV 导出都读取同一个 LoadedPayload，切换文件或失败后旧负载
 *   整体销毁，三处不可能混用两份数据。
 */
export function KthReview() {
  const [view, setView] = useState<ViewState>({ status: 'idle' });
  const [madEnabled, setMadEnabled] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 始终镜像当前视图，供事件回调读取最新就绪负载（避免在 setState 更新函数里做重计算）
  const viewRef = useRef<ViewState>(view);
  viewRef.current = view;

  const consumeObject = useCallback((obj: unknown, fileName: string, withMad: boolean) => {
    // analyze 内部保证：失败时 answers 为空、madTotals 为 null，调用方据此清除旧结果
    const result = analyze(obj, withMad ? { includeMad: true } : undefined);
    if (!result.ok) {
      setView({ status: 'error', fileName, errors: result.errors });
      return;
    }
    const data = obj as { readings: number[]; queries: Query[] };
    setView({
      status: 'ready',
      payload: {
        fileName,
        data,
        readingsCount: data.readings.length,
        queries: data.queries,
        result,
        madEnabled: withMad,
      },
    });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      // 先清除旧结果（含上一份成功答案），再进入新文件处理
      setView({ status: 'busy', fileName: file.name });
      // 读取前规模闸门：超限文件不读入内存，诊断有界
      if (file.size > MAX_FILE_BYTES) {
        setView({
          status: 'error',
          fileName: file.name,
          errors: [
            `文件过大：${formatByteSize(file.size)} 超出 ${formatByteSize(MAX_FILE_BYTES)} 上限，读取前拒绝`,
          ],
        });
        return;
      }
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setView({
            status: 'error',
            fileName: file.name,
            errors: [`JSON 语法错误，整个文件被拒绝：${msg}`],
          });
          return;
        }
        // 开关状态在读取完成的同一续体读取；重算路径同样以当前开关为准
        consumeObject(parsed, file.name, madEnabled);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setView({ status: 'error', fileName: file.name, errors: [`文件读取失败：${msg}`] });
      }
    },
    [consumeObject, madEnabled],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      // 允许再次选择同名文件时重新触发 change
      e.target.value = '';
    },
    [handleFile],
  );

  const loadFullScaleSample = useCallback(() => {
    setView({ status: 'busy', fileName: '内置满规模样本（200000 读数 / 100000 查询）' });
    // 让 busy 有机会绘制后再做重计算
    setTimeout(() => {
      const sample = generateFullScale();
      consumeObject(sample, '内置满规模样本（200000 读数 / 100000 查询）', madEnabled);
    }, 16);
  }, [consumeObject, madEnabled]);

  const toggleMad = useCallback(
    (next: boolean) => {
      setMadEnabled(next);
      // 仅在已有合法负载时就同一份数据重算；错误/忙/空闲视图不受影响。
      // 重计算在更新函数之外完成：StrictMode 下更新函数可能被重复调用。
      const current = viewRef.current;
      if (current.status !== 'ready') return;
      const reanalyzed = analyze(
        current.payload.data,
        next ? { includeMad: true } : undefined,
      );
      if (!reanalyzed.ok) {
        // 同一份此前已通过整体验证的数据不可能再次失败；防御性地回到错误态，
        // 绝不保留与当前开关不一致的旧表格/摘要
        setView({
          status: 'error',
          fileName: current.payload.fileName,
          errors: reanalyzed.errors,
        });
        return;
      }
      setView({
        status: 'ready',
        payload: { ...current.payload, result: reanalyzed, madEnabled: next },
      });
    },
    [],
  );

  return (
    <>
      <section className="loader">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={onInputChange}
          style={{ display: 'none' }}
          data-testid="file-input"
        />
        <button className="primary" onClick={() => fileInputRef.current?.click()}>
          选择 JSON 文件
        </button>
        <button onClick={loadFullScaleSample}>载入内置满规模样本</button>
        <label className="mad-toggle">
          <input
            type="checkbox"
            checked={madEnabled}
            onChange={(e) => toggleMad(e.target.checked)}
            data-testid="mad-toggle"
          />
          <span>
            同时核对中位绝对偏差总量
            <span className="formula">
              （半开窗口取较低中位数，Σ|读数−中位数|，精确整数，复用同一索引）
            </span>
          </span>
        </label>
        <span className="hint">文件全程仅在本机浏览器中读取与计算</span>
      </section>

      {view.status === 'busy' && (
        <section className="panel busy">正在解析与复核「{view.fileName}」……</section>
      )}

      {view.status === 'error' && (
        <section className="panel error" role="alert">
          <h2>文件被整体拒绝：{view.fileName}</h2>
          <p className="error-lead">
            以下结构或边界错误导致整个文件被拒，未产生任何查询答案；如之前有旧结果也已清除。
          </p>
          <ul className="error-list">
            {view.errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </section>
      )}

      {view.status === 'ready' && (
        <ResultsTable payload={view.payload} />
      )}

      {view.status === 'idle' && (
        <section className="panel idle">
          尚未载入文件。选择 JSON 文件，或直接载入内置的确定性满规模样本进行验收。
        </section>
      )}
    </>
  );
}

function ResultsTable({ payload }: { payload: LoadedPayload }) {
  const { fileName, readingsCount, queries, result, madEnabled } = payload;
  const madTotals = madEnabled ? result.madTotals : null;

  const handleExport = useCallback(() => {
    downloadResultsCsv(exportFileNameFor(fileName, madEnabled), queries, result.answers, madTotals);
  }, [fileName, madEnabled, queries, result.answers, madTotals]);

  return (
    <section className="panel ready">
      <div className="summary">
        <h2>复核完成：{fileName}</h2>
        <dl className="metrics">
          <div><dt>读数条数</dt><dd>{readingsCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>查询条数</dt><dd>{result.queryCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>计算耗时</dt><dd>{result.timingMs.toFixed(1)} ms</dd></div>
          <div><dt>答案总和</dt><dd>{result.sum.toLocaleString('zh-CN')}</dd></div>
          {madEnabled && result.madSum !== null && (
            <div>
              <dt>中位绝对偏差总量合计</dt>
              <dd data-testid="mad-sum">{result.madSum.toLocaleString('zh-CN')}</dd>
            </div>
          )}
          <div><dt>摘要 FNV-1a</dt><dd>{result.digest.toString(16).padStart(8, '0')}</dd></div>
        </dl>
        {result.queryCount > 0 && (
          <div className="table-toolbar">
            <button onClick={handleExport} data-testid="export-csv">
              导出 CSV（按原查询顺序{madEnabled ? '，含中位绝对偏差总量' : ''}）
            </button>
            <span className="hint">
              导出值为精确整数，不做展示舍入；与下表来自同一次分析结果。
            </span>
          </div>
        )}
      </div>

      {result.queryCount === 0 ? (
        <p className="empty-queries">queries 为空：文件合法，但没有需要复核的查询。</p>
      ) : (
        <VirtualTable queries={queries} answers={result.answers} madTotals={madTotals} />
      )}
    </section>
  );
}

const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 560;
const OVERSCAN = 12;

/**
 * 仅渲染视口附近约 30 行，支撑 10 万行结果不卡顿；
 * 行的查询下标直接来自数组下标，首尾相邻窗口不会出现任何错位。
 */
function VirtualTable({
  queries,
  answers,
  madTotals,
}: {
  queries: Query[];
  answers: number[];
  madTotals: bigint[] | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const total = queries.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);

  const rows = useMemo(() => {
    const items: Array<{ i: number; q: Query; a: number; m: bigint | null }> = [];
    for (let i = startIndex; i < endIndex; i++) {
      items.push({
        i,
        q: queries[i],
        a: answers[i],
        m: madTotals !== null ? madTotals[i] : null,
      });
    }
    return items;
  }, [startIndex, endIndex, queries, answers, madTotals]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const jump = useCallback((target: number) => {
    const el = scrollRef.current;
    if (el) {
      const clamped = Math.max(0, Math.min(target, total - 1)) * ROW_HEIGHT;
      el.scrollTop = clamped;
      setScrollTop(clamped);
    }
  }, [total]);

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <button onClick={() => jump(0)}>首行 (#0)</button>
        <button onClick={() => jump(total - 1)}>末行 (#{(total - 1).toLocaleString('zh-CN')})</button>
        <span className="hint">
          当前可见 #{startIndex.toLocaleString('zh-CN')} – #{(endIndex - 1).toLocaleString('zh-CN')}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="viewport"
        onScroll={onScroll}
        style={{ height: VIEWPORT_HEIGHT }}
      >
        <div className="spacer" style={{ height: total * ROW_HEIGHT }}>
          <table className="results" style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
            <thead>
              <tr>
                <th className="col-idx">查询下标</th>
                <th>start</th>
                <th>end</th>
                <th>k</th>
                <th>窗口长度</th>
                <th className="col-ans">第 k 小值（精确）</th>
                {madTotals !== null && <th className="col-mad">中位绝对偏差总量（精确）</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ i, q, a, m }) => (
                <tr key={i}>
                  <td className="col-idx mono">#{i}</td>
                  <td className="mono">{q.start}</td>
                  <td className="mono">{q.end}</td>
                  <td className="mono">{q.k}</td>
                  <td className="mono">{q.end - q.start}</td>
                  <td className="col-ans mono strong">{a}</td>
                  {madTotals !== null && (
                    <td className="col-mad mono" data-testid="mad-cell">
                      {m === null ? '' : m.toLocaleString('zh-CN')}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
