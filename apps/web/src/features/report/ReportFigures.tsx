import type { ReportModel } from "@subpixel/contracts";
import { buildPointChartSpecs, buildTopologyChartSpec, chartPathSegments, type ReportChartPoint, type ReportChartSpec, type TopologyChartSpec } from "./reportCharts";

const WIDTH = 480;
const HEIGHT = 220;
const MARGIN = { left: 46, right: 16, top: 28, bottom: 34 };

function scale(value: number, domain: [number, number], range: [number, number]) {
  return range[0] + (value - domain[0]) / Math.max(1e-12, domain[1] - domain[0]) * (range[1] - range[0]);
}

function ticks(domain: [number, number], count = 5) {
  return Array.from({ length: count }, (_, index) => domain[0] + index * (domain[1] - domain[0]) / Math.max(1, count - 1));
}

function mark(point: ReportChartPoint, x: number, y: number, key: string) {
  const stateSymbol = point.state === "provisional" || point.state === "reviewed" ? "square" : point.state === "suspect" ? "triangle" : "circle";
  if (stateSymbol === "square") return <rect key={key} x={x - 2.5} y={y - 2.5} width="5" height="5" className="chart-mark chart-mark-provisional" />;
  if (stateSymbol === "triangle") return <path key={key} d={`M ${x} ${y - 3.5} L ${x + 3.5} ${y + 3} L ${x - 3.5} ${y + 3} Z`} className="chart-mark chart-mark-suspect" />;
  return <circle key={key} cx={x} cy={y} r="2.5" className="chart-mark chart-mark-valid" />;
}

export function ReportChartFigure({ spec, compact = false }: { spec: ReportChartSpec; compact?: boolean }) {
  const plot = { x0: MARGIN.left, x1: WIDTH - MARGIN.right, y0: MARGIN.top, y1: HEIGHT - MARGIN.bottom };
  const sx = (value: number) => scale(value, spec.xDomain, [plot.x0, plot.x1]);
  const sy = (value: number) => scale(value, spec.yDomain, [plot.y1, plot.y0]);
  return <figure className={`report-chart ${compact ? "compact" : ""}`} data-chart-id={spec.id}>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${spec.title}；横轴 ${spec.xLabel}；纵轴 ${spec.yLabel}`}>
      <title>{spec.title}</title>
      <text x={MARGIN.left} y="16" className="chart-title">{spec.title}</text>
      {ticks(spec.yDomain).map((tick, index) => <g key={`y-${index}`}><line x1={plot.x0} x2={plot.x1} y1={sy(tick)} y2={sy(tick)} className="chart-grid" /><text x={plot.x0 - 6} y={sy(tick) + 3} textAnchor="end" className="chart-tick">{tick.toFixed(Math.abs(tick) < 10 ? 2 : 1)}</text></g>)}
      {ticks(spec.xDomain).map((tick, index) => <g key={`x-${index}`}><line x1={sx(tick)} x2={sx(tick)} y1={plot.y0} y2={plot.y1} className="chart-grid chart-grid-x" /><text x={sx(tick)} y={plot.y1 + 15} textAnchor="middle" className="chart-tick">{tick.toFixed(Math.abs(tick) < 10 ? 2 : 0)}</text></g>)}
      {spec.thresholds?.map(threshold => <g key={threshold.label}><line x1={plot.x0} x2={plot.x1} y1={sy(threshold.value)} y2={sy(threshold.value)} className="chart-threshold" /><text x={plot.x1 - 3} y={sy(threshold.value) - 3} textAnchor="end" className="chart-threshold-label">{threshold.label}</text></g>)}
      {spec.series.map(series => <g key={series.id} style={{ color: series.color }}>
        {chartPathSegments(series).map((segment, index) => <path key={index} d={segment.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${sx(point.x)} ${sy(point.y)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray={series.dash?.join(" ")} />)}
        {series.points.filter(point => point.defined).filter((_, index, points) => index % Math.max(1, Math.ceil(points.length / 80)) === 0 || index === points.length - 1).map((point, index) => mark(point, sx(point.x), sy(point.y), `${series.id}-${index}`))}
      </g>)}
      <text x={(plot.x0 + plot.x1) / 2} y={HEIGHT - 5} textAnchor="middle" className="chart-axis-label">{spec.xLabel}</text>
      <text x="11" y={(plot.y0 + plot.y1) / 2} textAnchor="middle" transform={`rotate(-90 11 ${(plot.y0 + plot.y1) / 2})`} className="chart-axis-label">{spec.yLabel}</text>
      <g transform={`translate(${plot.x0},${HEIGHT - 18})`}>{spec.series.map((series, index) => <g key={series.id} transform={`translate(${index * 94},0)`}><line x1="0" x2="16" y1="0" y2="0" stroke={series.color} strokeWidth="2" strokeDasharray={series.dash?.join(" ")} /><text x="20" y="3" className="chart-legend">{series.label}</text></g>)}</g>
    </svg>
    {spec.note && <figcaption>{spec.note}</figcaption>}
  </figure>;
}

export function TopologyFigure({ spec }: { spec: TopologyChartSpec }) {
  const plot = { x0: 42, x1: WIDTH - 16, y0: 28, y1: HEIGHT - 28 };
  const sx = (value: number) => scale(value, spec.xDomain, [plot.x0, plot.x1]);
  const sy = (value: number) => scale(value, spec.yDomain, [plot.y1, plot.y0]);
  const nodes = new Map(spec.nodes.map(node => [node.pointId, node]));
  return <figure className="report-chart topology-chart" data-chart-id={spec.id}>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="首帧固定拓扑、末帧变形和逐点位移箭头">
      <title>{spec.title}</title><text x="42" y="16" className="chart-title">{spec.title}</text>
      {spec.edges.map(edge => {
        const source = nodes.get(edge.sourcePointId); const target = nodes.get(edge.targetPointId);
        if (!source || !target) return null;
        return <g key={edge.edgeId}><line x1={sx(source.reference.x)} y1={sy(source.reference.y)} x2={sx(target.reference.x)} y2={sy(target.reference.y)} className="topology-reference-edge" />{source.current && target.current && <line x1={sx(source.current.x)} y1={sy(source.current.y)} x2={sx(target.current.x)} y2={sy(target.current.y)} className="topology-current-edge" />}</g>;
      })}
      {spec.nodes.map(node => <g key={node.pointId}><circle cx={sx(node.reference.x)} cy={sy(node.reference.y)} r="3" className="topology-reference-node" />{node.current && <><line x1={sx(node.reference.x)} y1={sy(node.reference.y)} x2={sx(node.current.x)} y2={sy(node.current.y)} className="topology-displacement" /><circle cx={sx(node.current.x)} cy={sy(node.current.y)} r="4" className={`topology-current-node state-${node.state ?? "valid"}`} /><text x={sx(node.current.x) + 5} y={sy(node.current.y) - 5} className="topology-label">{node.pointId}</text></>}</g>)}
      <text x="42" y={HEIGHT - 8} className="chart-legend">灰色实线：首帧固定拓扑　琥珀虚线：末帧变形　箭头线：逐点位移</text>
    </svg>
  </figure>;
}

export function PointReportCharts({ report, pointId }: { report: ReportModel; pointId: string }) {
  return <div className="point-report-charts">{buildPointChartSpecs(report, pointId).map(spec => <ReportChartFigure key={spec.id} spec={spec} compact />)}</div>;
}

export function ReportTopology({ report }: { report: ReportModel }) {
  return <TopologyFigure spec={buildTopologyChartSpec(report)} />;
}
