import type { ReportModel } from "@subpixel/contracts";

export type ReportChartPoint = {
  x: number;
  y: number;
  frame: number;
  defined: boolean;
  state: ReportModel["tracks"][number]["state"];
};

export type ReportChartSeries = {
  id: string;
  label: string;
  color: string;
  dash?: number[];
  symbol: "circle" | "square" | "triangle";
  points: ReportChartPoint[];
};

export type ReportChartSpec = {
  id: string;
  title: string;
  xLabel: string;
  yLabel: string;
  xDomain: [number, number];
  yDomain: [number, number];
  series: ReportChartSeries[];
  thresholds?: Array<{ value: number; label: string }>;
  note?: string;
};

export type TopologyNode = {
  pointId: string;
  reference: { x: number; y: number };
  current?: { x: number; y: number };
  state?: ReportModel["tracks"][number]["state"];
};

export type TopologyChartSpec = {
  id: string;
  title: string;
  xDomain: [number, number];
  yDomain: [number, number];
  nodes: TopologyNode[];
  edges: ReportModel["topology"];
};

function paddedDomain(values: number[], fallback: [number, number] = [0, 1]): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return fallback;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return [min - 1, max + 1];
  const padding = (max - min) * .08;
  return [min - padding, max + padding];
}

function lineSeries(
  id: string,
  label: string,
  color: string,
  symbol: ReportChartSeries["symbol"],
  rows: ReportModel["chartSeries"][number]["samples"],
  x: (row: typeof rows[number]) => number,
  y: (row: typeof rows[number]) => number | null,
  dash?: number[]
): ReportChartSeries {
  return {
    id, label, color, dash, symbol,
    points: rows.map(row => {
      const value = y(row);
      return {
        x: x(row),
        y: value ?? 0,
        frame: row.frame,
        defined: value !== null && row.state !== "lost" && row.state !== "paused",
        state: row.state
      };
    })
  };
}

export function buildPointChartSpecs(report: ReportModel, pointId: string): ReportChartSpec[] {
  const rows = report.chartSeries.find(series => series.pointId === pointId)?.samples ?? [];
  const model = report.points.find(point => point.pointId === pointId)?.model ?? "unknown";
  const trajectory = lineSeries("trajectory", "轨迹", "#087f73", "circle", rows, row => row.x, row => row.y);
  const deltaX = lineSeries("dx", "ΔX", "#087f73", "circle", rows, row => row.frame, row => row.dx);
  const deltaY = lineSeries("dy", "ΔY", "#b46b10", "square", rows, row => row.frame, row => row.dy, [5, 3]);
  const confidence = lineSeries("confidence", "置信度", "#087f73", "circle", rows, row => row.frame, row => row.confidence);
  const residual = lineSeries("residual", "拟合残差", "#b24b43", "triangle", rows, row => row.frame, row => row.residual);
  const innovation = lineSeries("innovation", "创新量", "#4f6573", "square", rows, row => row.frame, row => row.innovationPx, [5, 3]);
  const naturalSeries = [
    lineSeries("ncc", "NCC", "#087f73", "circle", rows, row => row.frame, row => row.ncc),
    lineSeries("lowe", "Lowe 比率", "#b46b10", "square", rows, row => row.frame, row => row.loweRatio, [5, 3])
  ];
  const frameValues = rows.map(row => row.frame);
  const specs: ReportChartSpec[] = [
    {
      id: `${pointId}-trajectory`, title: "XY 空间轨迹", xLabel: "X / px", yLabel: "Y / px",
      xDomain: paddedDomain(rows.map(row => row.x)), yDomain: paddedDomain(rows.map(row => row.y)),
      series: [trajectory], note: "缺测和硬失败帧以断线表示；圆点为有效，方形为待复核，三角形为异常。"
    },
    {
      id: `${pointId}-delta`, title: "相对首个可用帧的位移", xLabel: "原始 frame", yLabel: "位移 / px",
      xDomain: paddedDomain(frameValues), yDomain: paddedDomain(rows.flatMap(row => [row.dx, row.dy]).filter((value): value is number => value !== null)),
      series: [deltaX, deltaY]
    },
    {
      id: `${pointId}-confidence`, title: "逐帧识别置信度", xLabel: "原始 frame", yLabel: "置信度",
      xDomain: paddedDomain(frameValues), yDomain: [0, 1],
      series: [confidence], thresholds: [{ value: report.thresholds.reviewConfidenceP50, label: "复核阈值" }]
    },
    {
      id: `${pointId}-quality`, title: "拟合残差与预测创新量", xLabel: "原始 frame", yLabel: "原图像素 / px",
      xDomain: paddedDomain(frameValues), yDomain: paddedDomain(rows.flatMap(row => [row.residual, row.innovationPx])),
      series: [residual, innovation], note: `残差语义：${model} 模型内部质量，仅在同模型内比较。`
    }
  ];
  if (model === "natural-keypoint") specs.push({
    id: `${pointId}-natural`, title: "自然特征身份门控", xLabel: "原始 frame", yLabel: "归一化指标",
    xDomain: paddedDomain(frameValues), yDomain: [0, 1],
    series: naturalSeries,
    thresholds: [{ value: .7, label: "NCC 下限" }, { value: .75, label: "Lowe 上限" }]
  });
  return specs;
}

export function buildTopologyChartSpec(report: ReportModel): TopologyChartSpec {
  const tracksByPoint = new Map<string, ReportModel["tracks"]>();
  for (const track of report.tracks) tracksByPoint.set(track.pointId, [...(tracksByPoint.get(track.pointId) ?? []), track]);
  const nodes = report.points.flatMap(point => {
    const rows = tracksByPoint.get(point.pointId) ?? [];
    const first = rows.find(row => row.state !== "lost" && row.state !== "paused");
    const last = [...rows].reverse().find(row => row.state !== "lost" && row.state !== "paused");
    const reference = first?.refined ?? point.start;
    if (!reference) return [];
    return [{ pointId: point.pointId, reference, current: last?.refined, state: last?.state }] satisfies TopologyNode[];
  });
  const valuesX = nodes.flatMap(node => [node.reference.x, node.current?.x].filter((value): value is number => value !== undefined));
  const valuesY = nodes.flatMap(node => [node.reference.y, node.current?.y].filter((value): value is number => value !== undefined));
  return {
    id: "fixed-topology", title: "首帧固定拓扑与末帧位移",
    xDomain: paddedDomain(valuesX), yDomain: paddedDomain(valuesY),
    nodes, edges: report.topology.filter(edge => edge.enabled)
  };
}

export function chartPathSegments(series: ReportChartSeries): ReportChartPoint[][] {
  const segments: ReportChartPoint[][] = [];
  let current: ReportChartPoint[] = [];
  for (const point of series.points) {
    if (!point.defined) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
