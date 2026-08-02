import { Download, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { QualityThresholds, ReportMetadata, ReportModel } from "@subpixel/contracts";
import type { ExportFormat } from "./exportClient";

type Props = {
  open: boolean;
  report?: ReportModel;
  onClose: () => void;
  onRefresh: (metadata: ReportMetadata, thresholds: QualityThresholds) => void;
  onExport: (format: ExportFormat) => void;
};

const labels = { pass: "合格", review: "需复核", fail: "不合格", "not-evaluated": "未评估" } as const;

export function ReportCenter({ open, report, onClose, onRefresh, onExport }: Props) {
  const [tab, setTab] = useState<"overview" | "points" | "settings">("overview");
  const [metadata, setMetadata] = useState<ReportMetadata | null>(null);
  const [thresholds, setThresholds] = useState<QualityThresholds | null>(null);
  const [settingsError, setSettingsError] = useState<string>();
  const [pointFilter, setPointFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("all");
  const [gradeFilter, setGradeFilter] = useState("all");

  useEffect(() => {
    if (!report) return;
    setMetadata(report.metadata);
    setThresholds(report.thresholds);
  }, [report]);

  if (!open) return null;
  const updateMeta = (key: keyof ReportMetadata, value: string) => setMetadata(current => current ? { ...current, [key]: value } : current);
  const updateThreshold = (key: keyof QualityThresholds, value: string) => setThresholds(current => current ? { ...current, [key]: Number(value) } : current);
  const visiblePoints = report?.points.filter(point => point.pointId.toLowerCase().includes(pointFilter.toLowerCase()) && (modelFilter === "all" || point.model === modelFilter) && (gradeFilter === "all" || point.grade === gradeFilter)) ?? [];

  return <div className="report-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="report-center" role="dialog" aria-modal="true" aria-label="报告中心">
      <header className="report-center-header"><div><span className="eyebrow">REPORT CENTER</span><h2>详细报告</h2>{report && <small>快照帧 {report.execution.frameCount} · {report.metadata.generatedAt}</small>}</div><button className="icon-button" title="关闭报告中心" aria-label="关闭报告中心" onClick={onClose}><X size={18} /></button></header>
      <nav className="report-tabs" role="tablist"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>概览</button><button className={tab === "points" ? "active" : ""} onClick={() => setTab("points")}>点质量</button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>导出设置</button></nav>
      {!report ? <div className="report-empty">尚未生成报告快照。请先确认点并开始一次跟踪。</div> : <>
        {tab === "overview" && <section className="report-section">
          <div className={`report-grade grade-${report.grade}`}><span>质量结论</span><strong>{labels[report.grade]}</strong><small>有效率 {(report.execution.validRatio * 100).toFixed(2)}% · 失锁率 {(report.execution.lostRatio * 100).toFixed(2)}%</small></div>
          <div className="report-stat-grid"><div><small>确认点</small><strong>{report.execution.pointCount}</strong></div><div><small>跟踪帧</small><strong>{report.execution.frameCount}</strong></div><div><small>轨迹样本</small><strong>{report.execution.sampleCount}</strong></div><div><small>P95 延迟</small><strong>{report.execution.processingStats.p95LatencyMs.toFixed(1)} ms</strong></div></div>
          <h3>异常摘要</h3>{report.anomalyIntervals.length ? <ul className="report-list">{report.anomalyIntervals.slice(0, 8).map(interval => <li key={`${interval.pointId}-${interval.startFrame}`}><strong>{interval.pointId}</strong> frame {interval.startFrame}–{interval.endFrame} · {interval.worstState} · 最低置信度 {interval.minimumConfidence.toFixed(3)}</li>)}</ul> : <p className="empty-note">没有连续异常区间。</p>}
          <h3>风险与人工干预</h3><p>{report.risks.length} 条风险，{report.humanInterventions.length} 次人工干预。</p>
        </section>}
        {tab === "points" && <section className="report-section"><div className="report-filters"><input aria-label="筛选 pointId" placeholder="筛选 pointId" value={pointFilter} onChange={event => setPointFilter(event.target.value)} /><select aria-label="按模型筛选" value={modelFilter} onChange={event => setModelFilter(event.target.value)}><option value="all">全部模型</option>{[...new Set(report.points.map(point => point.model).filter(Boolean))].map(model => <option key={model} value={model ?? ""}>{model}</option>)}</select><select aria-label="按等级筛选" value={gradeFilter} onChange={event => setGradeFilter(event.target.value)}><option value="all">全部等级</option><option value="pass">合格</option><option value="review">需复核</option><option value="fail">不合格</option><option value="not-evaluated">未评估</option></select></div><div className="report-table-wrap"><table><thead><tr><th>pointId</th><th>组</th><th>模型</th><th>等级</th><th>样本</th><th>有效率</th><th>P50</th><th>ΔX / ΔY</th></tr></thead><tbody>{visiblePoints.map(point => <tr key={point.pointId}><td>{point.pointId}</td><td>{point.groupId ?? "-"}</td><td>{point.model ?? "-"}</td><td><span className={`state state-${point.grade}`}>{labels[point.grade]}</span></td><td>{point.sampleCount}</td><td>{(point.validRatio * 100).toFixed(1)}%</td><td>{point.confidence.p50?.toFixed(3) ?? "-"}</td><td>{point.dx?.toFixed(3) ?? "-"} / {point.dy?.toFixed(3) ?? "-"}</td></tr>)}</tbody></table></div></section>}
        {tab === "settings" && metadata && thresholds && <section className="report-section report-settings"><h3>报告元数据</h3><label>项目名称<input value={metadata.projectName} onChange={event => updateMeta("projectName", event.target.value)} /></label><label>试验编号<input value={metadata.testId} onChange={event => updateMeta("testId", event.target.value)} /></label><label>操作人<input value={metadata.operator} onChange={event => updateMeta("operator", event.target.value)} /></label><label>备注<textarea value={metadata.notes} onChange={event => updateMeta("notes", event.target.value)} /></label><h3>质量阈值</h3><div className="threshold-grid">{(["passValidRatio", "reviewValidRatio", "passConfidenceP50", "reviewConfidenceP50", "failLostRatio", "reviewDroppedFrameRatio"] as const).map(key => <label key={key}>{key}<input type="number" min="0" max="1" step="0.01" value={thresholds[key]} onChange={event => updateThreshold(key, event.target.value)} /></label>)}</div>{settingsError && <p className="error-note">{settingsError}</p>}<button className="primary-action" onClick={() => { try { onRefresh(metadata, thresholds); setSettingsError(undefined); } catch (error) { setSettingsError(error instanceof Error ? error.message : "阈值无效，请检查上下限顺序"); } }}><RefreshCw size={15} />刷新数据快照</button></section>}
        <footer className="report-actions"><button className="source-button" onClick={() => onExport("bundle")}><Download size={15} />生成 ZIP 报告包</button><button className="source-button" onClick={() => onExport("pdf")}>PDF</button><button className="source-button" onClick={() => onExport("xlsx")}>XLSX</button><button className="source-button" onClick={() => onExport("csv")}>CSV</button><button className="source-button" onClick={() => onExport("json")}>JSON</button></footer>
      </>}
    </aside>
  </div>;
}
