import type { MultiPointTrack } from "@subpixel/contracts";

export function MetricStrip({ tracks, latency }: { tracks: MultiPointTrack[]; latency: number }) {
  const latest = tracks.at(-1);
  const valid = tracks.filter(track => track.state === "valid" || track.state === "reviewed").length;
  const metrics = [
    { label: "X", value: latest ? latest.refined.x.toFixed(3) : "--", unit: "px" },
    { label: "Y", value: latest ? latest.refined.y.toFixed(3) : "--", unit: "px" },
    { label: "置信度", value: latest ? `${Math.round(latest.confidence * 100)}` : "--", unit: "%" },
    { label: "有效率", value: tracks.length ? `${Math.round(valid / tracks.length * 100)}` : "--", unit: "%" },
    { label: "P95 延迟", value: latency ? latency.toFixed(0) : "--", unit: "ms" }
  ];
  return <div className="metric-strip">{metrics.map(metric => <div className="metric" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.unit}</small></div>)}</div>;
}
