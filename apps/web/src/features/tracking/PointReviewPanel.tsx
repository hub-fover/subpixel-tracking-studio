import { AlertTriangle, Check, Crosshair } from "lucide-react";
import type { MultiPointTrack, PointSeed } from "@subpixel/contracts";
import { buildFrameReviewRows } from "./reviewState";

type Props = {
  seeds: PointSeed[];
  tracks: MultiPointTrack[];
  frame: number;
  selectedPointId?: string;
  onSelect: (pointId: string) => void;
  onDecision: (pointId: string, frame: number, decision: "accept" | "reject") => void;
  onReinitialize: (pointId: string) => void;
  testId?: string;
};

const stateLabels: Record<MultiPointTrack["state"] | "missing", string> = {
  valid: "有效", provisional: "点已通过 · 配准待复核", suspect: "点门控异常", lost: "缺测",
  reviewed: "已复核", paused: "已暂停", missing: "无观测"
};
const modelLabels: Record<PointSeed["model"], string> = {
  circle: "圆/椭圆", crosshair: "十字丝", diagonal: "对角标志", blob: "光斑", speckle: "散斑", "natural-keypoint": "自然特征"
};

function qualityText(track: MultiPointTrack) {
  if (track.model === "natural-keypoint" && track.ncc !== null) return `NCC ${track.ncc.toFixed(3)}`;
  return `模型质量 ${(track.confidence * 100).toFixed(1)}%`;
}

export function PointReviewPanel({ seeds, tracks, frame, selectedPointId, onSelect, onDecision, onReinitialize, testId = "point-review-panel" }: Props) {
  const rows = buildFrameReviewRows(seeds, tracks, frame);
  const selected = rows.find(row => row.pointId === selectedPointId) ?? rows[0];
  const valid = rows.filter(row => row.track?.state === "valid" || row.track?.state === "reviewed").length;
  const pending = rows.length - valid;
  return <section className="point-review-panel" data-testid={testId}>
    <div className="panel-title"><h3>当前帧点检</h3><span>{valid}/{rows.length}</span></div>
    <div className="review-summary"><span>已确认 {valid}</span><span>待处理 {pending}</span><span>帧 {frame + 1}</span></div>
    <div className="review-point-list">
      {rows.map(row => {
        const state = row.track?.state ?? "missing";
        return <button key={row.pointId} type="button" aria-label={`选择点 ${row.pointId}`} aria-pressed={selected?.pointId === row.pointId} className={`review-point-row ${selected?.pointId === row.pointId ? "selected" : ""}`} onClick={() => onSelect(row.pointId)}>
          <i className={`review-state-dot state-dot-${state}`} /><strong>{row.pointId}</strong><small>{modelLabels[row.seed.model]}</small>
          <span className={`state state-${state}`}>{stateLabels[state]}</span>
          <output>{row.track ? `${row.track.refined.x.toFixed(3)}, ${row.track.refined.y.toFixed(3)}` : "--"}</output>
          <em>{row.track ? qualityText(row.track) : "--"}</em>
        </button>;
      })}
    </div>
    {selected && <div className="review-inspector">
      <div className="review-inspector-heading"><div><strong>{selected.pointId}</strong><span>{modelLabels[selected.seed.model]}</span></div><span className={`state state-${selected.track?.state ?? "missing"}`}>{stateLabels[selected.track?.state ?? "missing"]}</span></div>
      <dl>
        <div><dt>精修坐标</dt><dd>{selected.track ? `${selected.track.refined.x.toFixed(3)} / ${selected.track.refined.y.toFixed(3)}` : "--"}</dd></div>
        <div><dt>点提取质量</dt><dd>{selected.track ? qualityText(selected.track) : "--"}</dd></div>
        <div><dt>拟合残差</dt><dd>{selected.track ? `${selected.track.residual.toFixed(3)} px` : "--"}</dd></div>
        <div><dt>场景配准</dt><dd>{selected.track?.registrationDecision === "provisional" ? "软通过，需复核" : selected.track?.registrationDecision === "rejected" ? "拒绝" : selected.track?.registrationDecision === "accepted" ? "通过" : "未执行"}</dd></div>
        <div><dt>定位方法</dt><dd>{selected.track?.relocationMethod ?? "--"}</dd></div>
      </dl>
      {selected.track?.gateFailures.length ? <div className="review-gate-failures">{selected.track.gateFailures.map(failure => <span key={failure}>{failure}</span>)}</div> : null}
      <div className="review-actions">
        <button className="primary-action" aria-label={`确认 ${selected.pointId} 正确`} disabled={!selected.track} onClick={() => onDecision(selected.pointId, frame, "accept")}><Check size={15} />确认正确</button>
        <button className="source-button review-reject" aria-label={`标记 ${selected.pointId} 异常`} disabled={!selected.track} onClick={() => onDecision(selected.pointId, frame, "reject")}><AlertTriangle size={15} />标记异常</button>
        <button className="source-button" aria-label={`重新定位 ${selected.pointId}`} onClick={() => onReinitialize(selected.pointId)}><Crosshair size={15} />框选并重新定位</button>
      </div>
    </div>}
  </section>;
}
