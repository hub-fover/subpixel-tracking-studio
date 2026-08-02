import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { TrackingEvent } from "@subpixel/contracts";

export function EventTimeline({ events }: { events: TrackingEvent[] }) { return <section className="timeline" aria-label="事件时间线"><div className="panel-title"><h3>事件</h3><span>{events.length}</span></div>{events.length ? events.slice(-8).reverse().map(event => <div className="event" key={event.id}>{event.kind === "initialized" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}<div><strong>帧 {event.frame}</strong><p>{event.message}</p></div></div>) : <p className="empty-note">尚无异常事件</p>}</section>; }
