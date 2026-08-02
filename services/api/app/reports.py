import csv
import json
from io import BytesIO, StringIO

from openpyxl import Workbook
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

from .schemas import MultiPointTrack, PointTrack, RecoveryEvent


def multi_report_payload(job_id: str, tracks: list[MultiPointTrack], events: list[RecoveryEvent], format_name: str) -> tuple[bytes, str, str]:
    payload = {"jobId": job_id, "tracks": [track.model_dump(mode="json") for track in tracks], "recoveryEvents": [event.model_dump(mode="json") for event in events]}
    if format_name == "csv":
        if not tracks:
            raise ValueError("export.empty")
        stream = StringIO(); headers = ["pointId", "frame", "timestampMs", "predictedX", "predictedY", "refinedX", "refinedY", "model", "confidence", "residual", "state", "relocationMethod"]; writer = csv.DictWriter(stream, fieldnames=headers); writer.writeheader()
        for track in tracks:
            row = track.model_dump(mode="json"); writer.writerow({"pointId": row["pointId"], "frame": row["frame"], "timestampMs": row["timestampMs"], "predictedX": row["predicted"]["x"], "predictedY": row["predicted"]["y"], "refinedX": row["refined"]["x"], "refinedY": row["refined"]["y"], **{key: row[key] for key in ("model", "confidence", "residual", "state", "relocationMethod")}})
        return stream.getvalue().encode("utf-8-sig"), "text/csv", f"{job_id}.csv"
    if format_name != "json":
        raise ValueError("export.format-unsupported")
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"), "application/json", f"{job_id}.json"


def tracks_csv(tracks: list[PointTrack]) -> bytes:
    stream = StringIO()
    headers = ["frame", "timestampMs", "x", "y", "model", "residual", "confidence", "state", "durationMs"]
    writer = csv.DictWriter(stream, fieldnames=headers)
    writer.writeheader()
    for track in sorted(tracks, key=lambda item: item.frame):
        row = track.model_dump(mode="json", exclude={"z"})
        writer.writerow({header: row.get(header) for header in headers})
    return stream.getvalue().encode("utf-8-sig")


def tracks_xlsx(tracks: list[PointTrack]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "tracks"
    headers = ["frame", "timestampMs", "x", "y", "model", "residual", "confidence", "state", "durationMs"]
    sheet.append(headers)
    for track in sorted(tracks, key=lambda item: item.frame):
        row = track.model_dump(mode="json")
        sheet.append([row.get(header) for header in headers])
    events = workbook.create_sheet("events")
    events.append(["frame", "kind", "message"])
    stream = BytesIO()
    workbook.save(stream)
    return stream.getvalue()


def tracks_pdf(job_id: str, tracks: list[PointTrack]) -> bytes:
    stream = BytesIO()
    document = canvas.Canvas(stream, pagesize=landscape(A4))
    document.setTitle(f"Subpixel Tracking Report - {job_id}")
    document.setFont("Helvetica-Bold", 16)
    document.drawString(40, 555, "Subpixel Tracking Report")
    document.setFont("Helvetica", 9)
    valid = sum(track.state in ("valid", "reviewed") for track in tracks)
    document.drawString(40, 536, f"Job: {job_id}    Frames: {len(tracks)}    Valid: {valid}")
    document.drawString(40, 515, "Frame       X(px)       Y(px)       Confidence       Residual       State")
    for index, track in enumerate(sorted(tracks, key=lambda item: item.frame)[:38]):
        document.drawString(40, 498 - index * 12, f"{track.frame:<11}{track.x:<12.3f}{track.y:<12.3f}{track.confidence:<17.3f}{track.residual:<15.3f}{track.state}")
    document.save()
    return stream.getvalue()


def report_payload(job_id: str, tracks: list[PointTrack], format_name: str) -> tuple[bytes, str, str]:
    if not tracks:
        raise ValueError("export.empty")
    if format_name == "csv":
        return tracks_csv(tracks), "text/csv", f"{job_id}.csv"
    if format_name == "xlsx":
        return tracks_xlsx(tracks), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", f"{job_id}.xlsx"
    if format_name == "pdf":
        return tracks_pdf(job_id, tracks), "application/pdf", f"{job_id}.pdf"
    return json.dumps([track.model_dump(mode="json") for track in tracks], ensure_ascii=False, indent=2).encode(), "application/json", f"{job_id}.json"
