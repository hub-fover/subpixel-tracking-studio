import type { ReportModel } from "@subpixel/contracts";
import type { jsPDF } from "jspdf";
import { buildPointChartSpecs, buildTopologyChartSpec, chartPathSegments, type ReportChartPoint, type ReportChartSpec } from "./reportCharts";

export type EngineeringReportImages = { reference?: string; current?: string };
type RGB = readonly [number, number, number];

const PAGE = { width: 595.28, height: 841.89, margin: 42 };
const COLOR = {
  ink: [29, 40, 48] as const,
  muted: [98, 112, 121] as const,
  grid: [217, 224, 228] as const,
  valid: [8, 127, 115] as const,
  provisional: [190, 122, 16] as const,
  invalid: [178, 75, 67] as const,
  neutral: [93, 111, 122] as const,
  paper: [248, 249, 250] as const
};

const gradeLabel = { pass: "合格", review: "需复核", fail: "不合格", "not-evaluated": "未评估" } as const;
const stateLabel = { valid: "有效", provisional: "待复核", suspect: "可疑", lost: "缺测", reviewed: "已复核", paused: "暂停" } as const;

function setColor(doc: jsPDF, color: RGB, fill = false) {
  if (fill) doc.setFillColor(...color); else doc.setDrawColor(...color);
}

function text(doc: jsPDF, value: string, x: number, y: number, size = 9, color: RGB = COLOR.ink, align: "left" | "center" | "right" = "left") {
  doc.setFontSize(size); doc.setTextColor(...color); doc.text(value, x, y, { align });
}

function wrapped(doc: jsPDF, value: string, x: number, y: number, width: number, size = 9, color: RGB = COLOR.ink) {
  doc.setFontSize(size); doc.setTextColor(...color);
  const lines = doc.splitTextToSize(value, width) as string[];
  doc.text(lines, x, y);
  return y + Math.max(1, lines.length) * (size + 3);
}

function sectionHeader(doc: jsPDF, number: string, title: string, subtitle?: string) {
  text(doc, number, PAGE.margin, 54, 9, COLOR.valid);
  text(doc, title, PAGE.margin, 77, 19);
  if (subtitle) text(doc, subtitle, PAGE.margin, 96, 9, COLOR.muted);
  setColor(doc, COLOR.valid);
  doc.setLineWidth(2); doc.line(PAGE.margin, 106, PAGE.width - PAGE.margin, 106);
}

function addSectionPage(doc: jsPDF, number: string, title: string, subtitle?: string) {
  doc.addPage();
  sectionHeader(doc, number, title, subtitle);
}

function card(doc: jsPDF, x: number, y: number, width: number, height: number, label: string, value: string, accent: RGB = COLOR.valid) {
  setColor(doc, COLOR.paper, true); doc.rect(x, y, width, height, "F");
  setColor(doc, accent, true); doc.rect(x, y, 3, height, "F");
  text(doc, label, x + 11, y + 16, 8, COLOR.muted);
  text(doc, value, x + 11, y + 39, 16, COLOR.ink);
}

function image(doc: jsPDF, dataUrl: string | undefined, x: number, y: number, width: number, height: number, label: string) {
  text(doc, label, x, y - 7, 9, COLOR.muted);
  setColor(doc, COLOR.grid); doc.rect(x, y, width, height);
  if (!dataUrl) {
    text(doc, "无可用标注图", x + width / 2, y + height / 2, 10, COLOR.muted, "center");
    return;
  }
  const properties = doc.getImageProperties(dataUrl);
  const scale = Math.min(width / properties.width, height / properties.height);
  const renderedWidth = properties.width * scale;
  const renderedHeight = properties.height * scale;
  doc.addImage(dataUrl, dataUrl.startsWith("data:image/jpeg") ? "JPEG" : "PNG", x + (width - renderedWidth) / 2, y + (height - renderedHeight) / 2, renderedWidth, renderedHeight);
}

function chartScale(value: number, domain: [number, number], range: [number, number]) {
  return range[0] + (value - domain[0]) / Math.max(1e-12, domain[1] - domain[0]) * (range[1] - range[0]);
}

function drawSymbol(doc: jsPDF, point: ReportChartPoint, x: number, y: number, color: RGB) {
  setColor(doc, color); setColor(doc, [255, 255, 255], true);
  if (point.state === "provisional" || point.state === "reviewed") doc.rect(x - 2, y - 2, 4, 4, "FD");
  else if (point.state === "suspect") doc.triangle(x, y - 2.5, x + 2.5, y + 2, x - 2.5, y + 2, "FD");
  else doc.circle(x, y, 2, "FD");
}

export function drawPdfChart(doc: jsPDF, spec: ReportChartSpec, x: number, y: number, width: number, height: number) {
  const plot = { x0: x + 31, x1: x + width - 9, y0: y + 20, y1: y + height - 28 };
  text(doc, spec.title, x + 4, y + 10, 8.5);
  for (let index = 0; index < 5; index += 1) {
    const fraction = index / 4;
    const py = plot.y1 - fraction * (plot.y1 - plot.y0);
    const px = plot.x0 + fraction * (plot.x1 - plot.x0);
    setColor(doc, COLOR.grid); doc.setLineWidth(.35); doc.line(plot.x0, py, plot.x1, py); doc.line(px, plot.y0, px, plot.y1);
    const yValue = spec.yDomain[0] + fraction * (spec.yDomain[1] - spec.yDomain[0]);
    const xValue = spec.xDomain[0] + fraction * (spec.xDomain[1] - spec.xDomain[0]);
    text(doc, yValue.toFixed(Math.abs(yValue) < 10 ? 2 : 1), plot.x0 - 4, py + 2.5, 5.5, COLOR.muted, "right");
    text(doc, xValue.toFixed(Math.abs(xValue) < 10 ? 1 : 0), px, plot.y1 + 9, 5.5, COLOR.muted, "center");
  }
  for (const threshold of spec.thresholds ?? []) {
    const py = chartScale(threshold.value, spec.yDomain, [plot.y1, plot.y0]);
    setColor(doc, COLOR.invalid); doc.setLineDashPattern([2, 2], 0); doc.line(plot.x0, py, plot.x1, py); doc.setLineDashPattern([], 0);
    text(doc, threshold.label, plot.x1 - 2, py - 2, 5.5, COLOR.invalid, "right");
  }
  for (const [seriesIndex, series] of spec.series.entries()) {
    const color = series.color === "#b24b43" ? COLOR.invalid : series.color === "#b46b10" ? COLOR.provisional : series.color === "#4f6573" ? COLOR.neutral : COLOR.valid;
    setColor(doc, color); doc.setLineWidth(1.2); doc.setLineDashPattern(series.dash ?? [], 0);
    for (const segment of chartPathSegments(series)) {
      for (let index = 1; index < segment.length; index += 1) {
        doc.line(
          chartScale(segment[index - 1].x, spec.xDomain, [plot.x0, plot.x1]),
          chartScale(segment[index - 1].y, spec.yDomain, [plot.y1, plot.y0]),
          chartScale(segment[index].x, spec.xDomain, [plot.x0, plot.x1]),
          chartScale(segment[index].y, spec.yDomain, [plot.y1, plot.y0])
        );
      }
    }
    doc.setLineDashPattern([], 0);
    const defined = series.points.filter(point => point.defined);
    const step = Math.max(1, Math.ceil(defined.length / 50));
    defined.forEach((point, index) => {
      if (index % step === 0 || index === defined.length - 1) drawSymbol(doc, point, chartScale(point.x, spec.xDomain, [plot.x0, plot.x1]), chartScale(point.y, spec.yDomain, [plot.y1, plot.y0]), color);
    });
    const legendX = plot.x0 + seriesIndex * Math.min(82, (plot.x1 - plot.x0) / Math.max(1, spec.series.length));
    setColor(doc, color); doc.line(legendX, y + height - 10, legendX + 12, y + height - 10);
    text(doc, series.label, legendX + 15, y + height - 8, 5.8, COLOR.muted);
  }
  text(doc, spec.xLabel, (plot.x0 + plot.x1) / 2, y + height - 1, 6, COLOR.muted, "center");
  setColor(doc, COLOR.grid); doc.rect(x, y, width, height);
}

function drawTopology(doc: jsPDF, report: ReportModel, x: number, y: number, width: number, height: number) {
  const spec = buildTopologyChartSpec(report);
  const sx = (value: number) => chartScale(value, spec.xDomain, [x + 28, x + width - 12]);
  const sy = (value: number) => chartScale(value, spec.yDomain, [y + height - 24, y + 22]);
  const nodes = new Map(spec.nodes.map(node => [node.pointId, node]));
  text(doc, spec.title, x + 4, y + 11, 9);
  for (const edge of spec.edges) {
    const source = nodes.get(edge.sourcePointId); const target = nodes.get(edge.targetPointId);
    if (!source || !target) continue;
    setColor(doc, [155, 168, 176]); doc.setLineWidth(.65); doc.line(sx(source.reference.x), sy(source.reference.y), sx(target.reference.x), sy(target.reference.y));
    if (source.current && target.current) {
      setColor(doc, COLOR.provisional); doc.setLineDashPattern([3, 2], 0); doc.line(sx(source.current.x), sy(source.current.y), sx(target.current.x), sy(target.current.y)); doc.setLineDashPattern([], 0);
    }
  }
  for (const node of spec.nodes) {
    setColor(doc, COLOR.neutral); doc.circle(sx(node.reference.x), sy(node.reference.y), 2);
    if (!node.current) continue;
    setColor(doc, COLOR.neutral); doc.line(sx(node.reference.x), sy(node.reference.y), sx(node.current.x), sy(node.current.y));
    const color = node.state === "provisional" || node.state === "reviewed" ? COLOR.provisional : node.state === "suspect" ? COLOR.invalid : COLOR.valid;
    setColor(doc, color, true); doc.circle(sx(node.current.x), sy(node.current.y), 3, "F");
    text(doc, node.pointId, sx(node.current.x) + 4, sy(node.current.y) - 3, 5.5, COLOR.ink);
  }
  setColor(doc, COLOR.grid); doc.rect(x, y, width, height);
  text(doc, "灰色：首帧固定拓扑　琥珀虚线：末帧变形　连线：位移", x + 8, y + height - 7, 6, COLOR.muted);
}

function drawStateDistribution(doc: jsPDF, report: ReportModel, x: number, y: number, width: number) {
  const counts = report.execution.stateCounts;
  const entries = [
    ["有效", counts.valid, COLOR.valid],
    ["待复核", counts.provisional + counts.reviewed, COLOR.provisional],
    ["可疑", counts.suspect, COLOR.invalid],
    ["缺测/暂停", counts.lost + counts.paused, COLOR.invalid]
  ] as const;
  const total = Math.max(1, entries.reduce((sum, entry) => sum + entry[1], 0));
  let cursor = x;
  for (const [label, count, color] of entries) {
    const itemWidth = width * count / total;
    if (itemWidth > 0) { setColor(doc, color, true); doc.rect(cursor, y, itemWidth, 14, "F"); }
    cursor += itemWidth;
  }
  entries.forEach(([label, count, color], index) => text(doc, `${label} ${count}`, x + index * width / entries.length, y + 29, 7, color));
}

function metricValues(report: ReportModel, pointId: string, key: "confidence" | "residual" | "innovationPx") {
  const values = report.tracks.filter(track => track.pointId === pointId).map(track => key === "confidence" ? track.confidence : key === "residual" ? track.residual : track.innovationPx).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (fraction: number) => {
    if (!values.length) return null;
    const index = (values.length - 1) * fraction; const lower = Math.floor(index); const upper = Math.ceil(index);
    return values[lower] + (values[upper] - values[lower]) * (index - lower);
  };
  return { p50: percentile(.5), p95: percentile(.95), max: values.at(-1) ?? null };
}

function addPointPage(doc: jsPDF, report: ReportModel, point: ReportModel["points"][number], pageIndex: number) {
  addSectionPage(doc, `8.${pageIndex + 1}`, `${point.pointId} 逐点完整分析`, `${point.model ?? "-"} · ${point.groupId ?? "-"} · ${gradeLabel[point.grade]}`);
  const start = point.start ? `${point.start.x.toFixed(3)}, ${point.start.y.toFixed(3)}` : "-";
  const end = point.end ? `${point.end.x.toFixed(3)}, ${point.end.y.toFixed(3)}` : "-";
  text(doc, `起点 ${start} px　终点 ${end} px　ΔX ${point.dx?.toFixed(3) ?? "-"} px　ΔY ${point.dy?.toFixed(3) ?? "-"} px`, PAGE.margin, 128, 8);
  text(doc, `样本 ${point.sampleCount}　有效率 ${(point.validRatio * 100).toFixed(2)}%　最终状态 ${point.finalState ? stateLabel[point.finalState] : "-"}　置信度 P50/P95 ${point.confidence.p50?.toFixed(3) ?? "-"}/${point.confidence.p95?.toFixed(3) ?? "-"}`, PAGE.margin, 144, 8);
  const confidence = metricValues(report, point.pointId, "confidence");
  const residual = metricValues(report, point.pointId, "residual");
  const innovation = metricValues(report, point.pointId, "innovationPx");
  text(doc, `内部质量统计：残差 P50/P95/max ${residual.p50?.toFixed(3) ?? "-"}/${residual.p95?.toFixed(3) ?? "-"}/${residual.max?.toFixed(3) ?? "-"} px；创新量 P95/max ${innovation.p95?.toFixed(3) ?? "-"}/${innovation.max?.toFixed(3) ?? "-"} px`, PAGE.margin, 160, 7, COLOR.muted);
  const specs = buildPointChartSpecs(report, point.pointId);
  const positions = [[PAGE.margin, 176], [303, 176], [PAGE.margin, 362], [303, 362]] as const;
  specs.slice(0, 4).forEach((spec, index) => drawPdfChart(doc, spec, positions[index][0], positions[index][1], 250, 170));
  if (specs[4]) drawPdfChart(doc, specs[4], PAGE.margin, 548, 511, 145);
  const intervals = report.anomalyIntervals.filter(interval => interval.pointId === point.pointId);
  let y = specs[4] ? 710 : 555;
  text(doc, "异常区间与重定位", PAGE.margin, y, 9); y += 14;
  if (!intervals.length) text(doc, "无连续异常区间。", PAGE.margin, y, 7, COLOR.muted);
  else intervals.slice(0, 5).forEach(interval => { text(doc, `frame ${interval.startFrame}-${interval.endFrame} · ${stateLabel[interval.worstState]} · 最低置信度 ${interval.minimumConfidence.toFixed(3)} · 最大残差 ${interval.maximumResidual.toFixed(3)} px`, PAGE.margin, y, 7, COLOR.muted); y += 11; });
  if (confidence.p50 === null) text(doc, "该点无可评估逐帧数据。", PAGE.margin, y + 12, 8, COLOR.invalid);
}

export function renderEngineeringReportPdf(
  doc: jsPDF,
  report: ReportModel,
  images: EngineeringReportImages,
  checkpoint?: (pointIndex: number, pointCount: number) => void
) {
  text(doc, "亚像素特征提取与跟踪工程报告", PAGE.width / 2, 116, 24, COLOR.ink, "center");
  text(doc, "SUBPIXEL FEATURE EXTRACTION AND TRACKING ENGINEERING REPORT", PAGE.width / 2, 139, 8, COLOR.muted, "center");
  setColor(doc, report.grade === "pass" ? COLOR.valid : report.grade === "review" ? COLOR.provisional : COLOR.invalid, true);
  doc.rect(PAGE.width / 2 - 58, 174, 116, 31, "F");
  text(doc, gradeLabel[report.grade], PAGE.width / 2, 195, 13, [255, 255, 255], "center");
  const rows = [
    ["报告编号", report.metadata.reportNumber, "版本", "V1.0"],
    ["项目名称", report.metadata.projectName || "未填写", "试验编号", report.metadata.testId || "未填写"],
    ["数据源", report.metadata.sourceFile, "构建版本", report.metadata.buildCommit],
    ["生成时间", report.metadata.generatedAt, "坐标单位", report.calibration?.unit ?? "原图像素"]
  ];
  let y = 260;
  for (const row of rows) {
    setColor(doc, COLOR.grid); doc.rect(PAGE.margin, y, 511, 28);
    text(doc, row[0], PAGE.margin + 8, y + 18, 8, COLOR.muted); text(doc, row[1], PAGE.margin + 82, y + 18, 8);
    text(doc, row[2], PAGE.margin + 300, y + 18, 8, COLOR.muted); text(doc, row[3], PAGE.margin + 362, y + 18, 8);
    y += 28;
  }
  text(doc, "文控与签署", PAGE.margin, 405, 11);
  [["编制", report.metadata.operator || ""], ["复核", ""], ["批准", ""]].forEach((row, index) => {
    setColor(doc, COLOR.grid); doc.rect(PAGE.margin + index * 170.3, 420, 170.3, 62);
    text(doc, row[0], PAGE.margin + index * 170.3 + 8, 438, 8, COLOR.muted);
    text(doc, row[1], PAGE.margin + index * 170.3 + 8, 464, 9);
  });
  wrapped(doc, `备注：${report.metadata.notes || "无"}`, PAGE.margin, 522, 511, 9);
  wrapped(doc, "声明：本报告质量等级仅代表算法门控、数据完整性和内部质量指标；在未提供标定证书、物理尺度和计量溯源时，不构成计量检定结论。", PAGE.margin, 715, 511, 8, COLOR.muted);

  addSectionPage(doc, "2", "结论与执行摘要", "完整性、有效性和复核需求");
  card(doc, PAGE.margin, 126, 118, 58, "确认点", String(report.execution.pointCount));
  card(doc, 172, 126, 118, 58, "输入/已尝试", `${report.execution.inputFrameCount}/${report.execution.processedFrameCount + report.execution.isolatedFrameCount}`);
  card(doc, 302, 126, 118, 58, "待复核样本", String(report.execution.stateCounts.provisional), COLOR.provisional);
  card(doc, 432, 126, 121, 58, "缺测帧", String(report.execution.missingFrameCount), report.execution.missingFrameCount ? COLOR.invalid : COLOR.valid);
  text(doc, "逐点状态分布", PAGE.margin, 218, 10); drawStateDistribution(doc, report, PAGE.margin, 232, 511);
  wrapped(doc, `结论：总体质量判定为“${gradeLabel[report.grade]}”。正式有效率 ${(report.execution.validRatio * 100).toFixed(2)}%，失锁率 ${(report.execution.lostRatio * 100).toFixed(2)}%，配准正式通过 ${report.registration.acceptedCount} 次、待复核 ${report.registration.provisionalCount} 次、拒绝 ${report.registration.rejectedCount} 次。`, PAGE.margin, 294, 511, 10);
  image(doc, images.current, PAGE.margin, 352, 511, 330, "末个有效帧总览标注图");

  addSectionPage(doc, "3", "数据源、标定与坐标系", "所有计算均使用原始图像像素");
  const stats = report.execution.processingStats;
  const sourceLines = [
    `源文件：${report.metadata.sourceFile}`,
    `原图尺寸：${stats.nativeWidth ?? "-"} × ${stats.nativeHeight ?? "-"} px`,
    `输入帧：${report.execution.inputFrameCount}；已处理：${report.execution.processedFrameCount}；隔离：${report.execution.isolatedFrameCount}`,
    `算法引擎：${stats.engine}；处理 P95：${stats.p95LatencyMs.toFixed(2)} ms；跳帧：${stats.droppedFrames}`
  ];
  sourceLines.forEach((line, index) => text(doc, line, PAGE.margin, 140 + index * 22, 10));
  text(doc, "标定参数", PAGE.margin, 246, 11);
  if (report.calibration) {
    text(doc, `X：${report.calibration.xUnitsPerPixel} ${report.calibration.unit}/px；Y：${report.calibration.yUnitsPerPixel} ${report.calibration.unit}/px；Y 轴：${report.calibration.yAxisDirection === "up" ? "向上" : "向下"}`, PAGE.margin, 270, 9);
    text(doc, `像素原点：(${report.calibration.pixelOrigin.x}, ${report.calibration.pixelOrigin.y})；工程原点：(${report.calibration.engineeringOrigin.x}, ${report.calibration.engineeringOrigin.y}) ${report.calibration.unit}`, PAGE.margin, 289, 9);
  } else text(doc, "未提供工程单位标定；报告仅输出原图像素坐标。", PAGE.margin, 270, 9, COLOR.provisional);
  wrapped(doc, "坐标约定：数据层 frame 从 0 开始；报告阅读顺序显示“帧 1、帧 2……”时保留原始 frame 字段。缺测帧不插值、不静默重绑相似点。", PAGE.margin, 338, 511, 9, COLOR.muted);

  addSectionPage(doc, "4", "参考帧与末个有效帧总览", "标注位置与原图坐标一致");
  image(doc, images.reference, PAGE.margin, 130, 511, 286, "参考帧标注图");
  image(doc, images.current, PAGE.margin, 455, 511, 286, "末个有效帧标注图");

  addSectionPage(doc, "5", "输入帧完整性与状态分布", "每个输入均保留解码和处理记录");
  const ledger = report.frameLedger.slice(0, 40);
  text(doc, "序号", PAGE.margin, 132, 7, COLOR.muted); text(doc, "源文件/时间", 83, 132, 7, COLOR.muted); text(doc, "处理", 330, 132, 7, COLOR.muted); text(doc, "有效/复核/缺测", 420, 132, 7, COLOR.muted);
  y = 148;
  ledger.forEach(entry => {
    const color = entry.processingStatus === "isolated" || entry.decodeStatus === "failed" ? COLOR.invalid : entry.provisionalCount ? COLOR.provisional : COLOR.valid;
    text(doc, String(entry.inputIndex + 1), PAGE.margin, y, 7);
    text(doc, entry.sourceName.slice(0, 42), 83, y, 7);
    text(doc, entry.processingStatus, 330, y, 7, color);
    text(doc, `${entry.validCount}/${entry.provisionalCount}/${entry.missingCount}`, 420, y, 7);
    y += 14;
  });
  if (report.frameLedger.length > ledger.length) text(doc, `其余 ${report.frameLedger.length - ledger.length} 条完整记录见 XLSX/CSV/JSON 附件。`, PAGE.margin, y + 12, 8, COLOR.muted);

  addSectionPage(doc, "6", "固定拓扑空间点线与位移", "拓扑仅在首帧建立，后续帧不重建");
  drawTopology(doc, report, PAGE.margin, 130, 511, 430);
  wrapped(doc, `启用拓扑边 ${report.topology.filter(edge => edge.enabled).length} 条，禁用 ${report.topology.filter(edge => !edge.enabled).length} 条。拓扑用于检查邻接关系和整体变形，不替代逐点身份门控。`, PAGE.margin, 590, 511, 9, COLOR.muted);

  addSectionPage(doc, "7", "场景配准、风险与人工干预", "软质量失败与硬几何失败分级记录");
  text(doc, `配准：正式通过 ${report.registration.acceptedCount}；待复核 ${report.registration.provisionalCount}；拒绝 ${report.registration.rejectedCount}；正式通过率 ${(report.registration.successRate * 100).toFixed(2)}%`, PAGE.margin, 135, 9);
  text(doc, `中位内点率 ${report.registration.medianInlierRatio?.toFixed(3) ?? "-"}；P95 重投影误差 ${report.registration.p95ReprojectionError?.toFixed(3) ?? "-"} px`, PAGE.margin, 155, 9);
  y = 190;
  [...report.risks.slice(0, 22).map(risk => `风险 frame ${risk.frame}：${risk.message}（动作：${risk.action}）`), ...report.humanInterventions.slice(0, 10).map(event => `人工干预：${JSON.stringify(event)}`)].forEach(line => {
    y = wrapped(doc, line, PAGE.margin, y, 511, 7, COLOR.muted) + 4;
  });

  report.points.forEach((point, index) => {
    checkpoint?.(index, report.points.length);
    addPointPage(doc, report, point, index);
  });

  addSectionPage(doc, "9", "内部质量与可选真值误差统计", "不同模型的原始残差不跨模型直接比较");
  y = 136;
  text(doc, "内部质量指标", PAGE.margin, y, 10); y += 20;
  for (const [name, summary] of Object.entries(report.internalQuality)) {
    text(doc, `${name}　n=${summary.count}　P50=${summary.p50?.toFixed(3) ?? "-"}　P95=${summary.p95?.toFixed(3) ?? "-"}　max=${summary.max?.toFixed(3) ?? "-"}`, PAGE.margin, y, 8);
    y += 17;
  }
  y += 14; text(doc, "真值误差", PAGE.margin, y, 10); y += 20;
  if (!report.groundTruthErrors.length) text(doc, "未导入真值；不计算 Bias、MAE、RMSE、P95 和最大误差。", PAGE.margin, y, 9, COLOR.provisional);
  else report.groundTruthErrors.slice(0, 24).forEach(error => {
    text(doc, `${error.pointId}　n=${error.count}　Bias X/Y=${error.biasX.toFixed(3)}/${error.biasY.toFixed(3)}　MAE X/Y=${error.maeX.toFixed(3)}/${error.maeY.toFixed(3)}　RMSE X/Y=${error.rmseX.toFixed(3)}/${error.rmseY.toFixed(3)}　径向 P95/max=${error.radialP95.toFixed(3)}/${error.radialMax.toFixed(3)} ${error.unit}`, PAGE.margin, y, 7);
    y += 15;
  });

  addSectionPage(doc, "10", "方法、阈值、限制与附件", "报告结论不替代计量检定或标定证书");
  const method = [
    "配准双层门控：accepted 可更新受控关键帧；provisional 仅用于搜索预测，逐点仍须通过模型精修和身份门控；hard rejection 隔离当前帧。",
    "离线图片、视频和停止后精算优先保证完整性：失败帧写入台账，后续帧从最近可靠关键帧继续尝试。实时相机遇到硬失败或可疑+失锁达到 20% 时暂停。",
    "合作标志在当前帧原图预测 ROI 内重新执行几何精修；自然点使用 NCC/KLT、正反向误差、Sampson 极线误差和描述子比率门控。",
    `默认阈值：有效率 ${report.thresholds.passValidRatio}/${report.thresholds.reviewValidRatio}；置信度 P50 ${report.thresholds.passConfidenceP50}/${report.thresholds.reviewConfidenceP50}；失锁率 ${report.thresholds.failLostRatio}。`,
    "PDF 保存结论、图表和关键统计；完整逐帧原始精度数据保存在 XLSX、CSV 和 JSON。图表最多使用 1000 个 min/max 保真显示样本，原始数据不裁剪。"
  ];
  y = 138;
  method.forEach((line, index) => { y = wrapped(doc, `${index + 1}. ${line}`, PAGE.margin, y, 511, 9) + 10; });

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    setColor(doc, COLOR.grid); doc.line(PAGE.margin, PAGE.height - 30, PAGE.width - PAGE.margin, PAGE.height - 30);
    text(doc, `${report.metadata.reportNumber} · schema v3 · ${report.metadata.buildCommit}`, PAGE.margin, PAGE.height - 16, 6.5, COLOR.muted);
    text(doc, `第 ${page} / ${pageCount} 页`, PAGE.width - PAGE.margin, PAGE.height - 16, 6.5, COLOR.muted, "right");
  }
}
