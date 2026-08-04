import type { MultiPointTrack } from "@subpixel/contracts";

type Props = {
  tracks: MultiPointTrack[];
  onReview: (pointId: string, frame: number) => void;
};

export function TrackTable({ tracks, onReview }: Props) {
  return <div className="table-wrap"><table><thead><tr><th>点号</th><th>帧</th><th>X / px</th><th>Y / px</th><th>置信度</th><th>状态</th><th /></tr></thead><tbody>{tracks.slice(-12).reverse().map(track => {
    const reviewed = track.state === "reviewed";
    const warning = track.state === "provisional" || track.state === "suspect" || track.state === "lost" || track.state === "paused";
    return <tr key={`${track.pointId}-${track.frame}`} data-point-id={track.pointId} data-frame={track.frame} className={warning ? "row-warning" : ""}><td>{track.pointId}</td><td>{track.frame}</td><td>{track.refined.x.toFixed(3)}</td><td>{track.refined.y.toFixed(3)}</td><td>{Math.round(track.confidence * 100)}%</td><td><span className={`state state-${track.state}`}>{reviewed ? "已复核" : track.state}</span></td><td>{reviewed ? <span className="review-complete">已复核</span> : track.state !== "valid" ? <button className="text-button" aria-label={`复核 ${track.pointId} 第 ${track.frame + 1} 帧`} onClick={() => onReview(track.pointId, track.frame)}>复核</button> : null}</td></tr>;
  })}</tbody></table></div>;
}
