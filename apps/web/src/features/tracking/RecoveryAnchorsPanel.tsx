import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { AnchorCorrespondence, PointSeed } from "@subpixel/contracts";

type Props = { referenceImage?: CanvasImageSource; currentImage?: CanvasImageSource; sourceSize?: { width: number; height: number }; seeds: PointSeed[]; onApply: (anchors: AnchorCorrespondence[]) => void; onRollback: () => void };

function draw(image: CanvasImageSource | undefined, canvas: HTMLCanvasElement | null, size?: { width: number; height: number }) {
  if (!image || !canvas || !size) return;
  canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext("2d"); if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
}

export function RecoveryAnchorsPanel({ referenceImage, currentImage, sourceSize, seeds, onApply, onRollback }: Props) {
  const referenceCanvas = useRef<HTMLCanvasElement>(null); const currentCanvas = useRef<HTMLCanvasElement>(null); const [anchors, setAnchors] = useState<AnchorCorrespondence[]>([]); const [referenceSelection, setReferenceSelection] = useState<{ pointId: string; point: { x: number; y: number } }>();
  useEffect(() => { draw(referenceImage, referenceCanvas.current, sourceSize); draw(currentImage, currentCanvas.current, sourceSize); }, [referenceImage, currentImage, sourceSize]);
  const point = (event: MouseEvent<HTMLCanvasElement>) => { const canvas = event.currentTarget; const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; };
  const selectReference = (event: MouseEvent<HTMLCanvasElement>) => { const candidate = point(event); const nearest = seeds.map(seed => ({ seed, distance: Math.hypot(seed.snapped.x - candidate.x, seed.snapped.y - candidate.y) })).sort((a, b) => a.distance - b.distance)[0]; if (nearest && nearest.distance <= 48) setReferenceSelection({ pointId: nearest.seed.pointId, point: candidate }); };
  const selectCurrent = (event: MouseEvent<HTMLCanvasElement>) => { if (!referenceSelection) return; const current = point(event); setAnchors(items => [...items.filter(item => item.pointId !== referenceSelection.pointId), { pointId: referenceSelection.pointId, reference: referenceSelection.point, current, confidence: 1 }]); setReferenceSelection(undefined); };
  const aspectRatio = sourceSize ? `${sourceSize.width} / ${sourceSize.height}` : "4 / 3";
  return <section className="recovery-panel"><div className="panel-title"><h3>恢复锚点</h3><span>{anchors.length}/6</span></div><p className="empty-note">先在参考帧选择点，再在当前帧点击对应位置，至少 4 个锚点。</p><div className="recovery-canvases"><div><small>参考帧</small><canvas ref={referenceCanvas} style={{ aspectRatio }} onClick={selectReference} /></div><div><small>当前帧</small><canvas ref={currentCanvas} style={{ aspectRatio }} onClick={selectCurrent} /></div></div><div className="recovery-anchor-list">{anchors.map(anchor => <span key={anchor.pointId}>{anchor.pointId}</span>)}</div><div className="draft-actions"><button className="primary-action" disabled={anchors.length < 4} onClick={() => onApply(anchors)}>应用恢复</button><button className="source-button secondary" onClick={onRollback}>回退</button></div></section>;
}
