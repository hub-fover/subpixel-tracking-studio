import { describe, expect, it } from "vitest";
import { jsPDF } from "jspdf";
import type { PointSeed, ReportMetadata } from "@subpixel/contracts";
import { buildReportModel } from "./reportModel";
import { renderEngineeringReportPdf } from "./engineeringReportPdf";

const metadata: ReportMetadata = {
  reportNumber: "R-PAGES",
  reportId: "report-pages",
  projectName: "工程报告页数",
  testId: "T-PAGES",
  operator: "",
  notes: "",
  sourceFile: "input.png",
  generatedAt: "2026-08-04T00:00:00.000Z",
  buildCommit: "test"
};

function seed(index: number): PointSeed {
  return {
    pointId: `p-${String(index + 1).padStart(3, "0")}`,
    click: { x: index * 5 + 10, y: index * 3 + 10 },
    snapped: { x: index * 5 + 10, y: index * 3 + 10 },
    roi: { x: index * 5, y: index * 3, width: 20, height: 20 },
    groupId: "default",
    candidateScore: .9,
    model: "circle",
    selectionMethod: "roi",
    intent: "circle-center"
  };
}

describe("formal engineering PDF structure", () => {
  it.each([1, 2, 100])("creates one complete point page for each of %i points", pointCount => {
    const report = buildReportModel({
      seeds: Array.from({ length: pointCount }, (_, index) => seed(index)),
      activePointIds: [],
      tracksByPoint: new Map(),
      registrations: [],
      recoveryEvents: [],
      riskNotices: [],
      processingStats: { processedFrames: 0, droppedFrames: 0, fps: 0, p95LatencyMs: 0, engine: "typescript", nativeWidth: 1920, nativeHeight: 1080 },
      frameLedger: [],
      events: []
    }, metadata);
    const doc = new jsPDF({ orientation: "portrait", unit: "pt" });

    renderEngineeringReportPdf(doc, report, {});

    expect(doc.getNumberOfPages()).toBe(9 + pointCount);
  });
});
