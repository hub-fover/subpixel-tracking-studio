import { ChevronLeft, ChevronRight, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { FrameLedgerEntry } from "@subpixel/contracts";

type Props = {
  ledger: FrameLedgerEntry[];
  selectedFrame: number;
  playing: boolean;
  loading?: boolean;
  onSelect: (frame: number) => void;
  onMove: (direction: -1 | 1) => void;
  onTogglePlayback: () => void;
};

function ledgerState(entry: FrameLedgerEntry) {
  if (entry.decodeStatus === "failed" || entry.processingStatus === "isolated") return "failed";
  if (entry.missingCount > 0 || entry.suspectCount > 0) return "warning";
  if (entry.provisionalCount > 0) return "provisional";
  return "valid";
}

export function FrameReviewBar({ ledger, selectedFrame, playing, loading, onSelect, onMove, onTogglePlayback }: Props) {
  const selectedEntry = ledger.find(entry => entry.frame === selectedFrame) ?? ledger.find(entry => entry.frame !== null);
  const selectedInput = selectedEntry?.inputIndex ?? 0;
  const available = ledger.filter(entry => entry.frame !== null);
  const first = available[0]?.frame ?? 0;
  const last = available.at(-1)?.frame ?? first;
  const selectInput = (inputIndex: number) => {
    const exact = ledger.find(entry => entry.inputIndex === inputIndex && entry.frame !== null);
    const fallback = ledger.find(entry => entry.inputIndex > inputIndex && entry.frame !== null)
      ?? [...ledger].reverse().find(entry => entry.inputIndex < inputIndex && entry.frame !== null);
    if (fallback?.frame !== null && fallback?.frame !== undefined) onSelect((exact ?? fallback).frame!);
    else if (exact?.frame !== null && exact?.frame !== undefined) onSelect(exact.frame);
  };

  return <section className="frame-review-bar" data-testid="frame-review-workspace" aria-label="序列复核">
    <div className="frame-review-heading">
      <div><strong>序列复核</strong><span>{selectedEntry?.sourceName ?? "-"}</span></div>
      <output data-testid="review-frame-label">第 {selectedInput + 1} / {ledger.length} 帧{loading ? " · 载入中" : ""}</output>
    </div>
    <div className="frame-review-controls">
      <button className="icon-button" aria-label="第一帧" title="第一帧" disabled={selectedFrame === first || loading} onClick={() => onSelect(first)}><SkipBack size={16} /></button>
      <button className="icon-button" aria-label="上一帧" title="上一帧" disabled={selectedFrame === first || loading} onClick={() => onMove(-1)}><ChevronLeft size={18} /></button>
      <button className="review-play-button" aria-label={playing ? "暂停回放" : "播放序列"} title={playing ? "暂停回放" : "播放序列"} disabled={available.length < 2 || loading} onClick={onTogglePlayback}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <button className="icon-button" aria-label="下一帧" title="下一帧" disabled={selectedFrame === last || loading} onClick={() => onMove(1)}><ChevronRight size={18} /></button>
      <button className="icon-button" aria-label="最后一帧" title="最后一帧" disabled={selectedFrame === last || loading} onClick={() => onSelect(last)}><SkipForward size={16} /></button>
      <input aria-label="回看帧" type="range" min={0} max={Math.max(0, ledger.length - 1)} step={1} value={selectedInput} onChange={event => selectInput(Number(event.target.value))} />
    </div>
    <div className="frame-strip" role="list" aria-label="帧状态">
      {ledger.map(entry => <button key={entry.inputIndex} type="button" role="listitem" aria-label={`查看第 ${entry.inputIndex + 1} 帧`} aria-current={entry.frame === selectedFrame ? "true" : undefined} className={`frame-tile frame-${ledgerState(entry)} ${entry.frame === selectedFrame ? "selected" : ""}`} disabled={entry.frame === null || loading} onClick={() => entry.frame !== null && onSelect(entry.frame)}><span>{entry.inputIndex + 1}</span><i /></button>)}
    </div>
  </section>;
}
