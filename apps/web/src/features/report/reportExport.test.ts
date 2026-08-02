import { describe, expect, it } from "vitest";
import { ReportManifestSchema, type ReportModel } from "@subpixel/contracts";
import {
  buildReportCsvFiles,
  buildReportManifest,
  buildReportBundle,
  csvWithBom,
  sanitizeReportFileName,
  reportFileStem,
  type ReportAssetResult
} from "./reportExport";

const report = {
  metadata: { reportNumber: "R-1", reportId: "report-1", projectName: "项目/一", testId: "T-1", operator: "", notes: "备注", sourceFile: "input.png", generatedAt: "2026-08-02T08:00:00.000Z", buildCommit: "dev" },
  thresholds: { passValidRatio: .95, reviewValidRatio: .8, passConfidenceP50: .8, reviewConfidenceP50: .55, failLostRatio: .2, reviewDroppedFrameRatio: .1 },
  options: { includedAssets: [], keyFrameCount: 20, imageQuality: "full", language: "zh-CN" },
  grade: "not-evaluated", execution: { pointCount: 2, frameCount: 0, sampleCount: 0, stateCounts: { valid: 0, suspect: 0, lost: 0, reviewed: 0, paused: 0 }, validRatio: 0, lostRatio: 0, droppedFrameRatio: 0, processingStats: { processedFrames: 0, droppedFrames: 0, fps: 0, p95LatencyMs: 0, engine: "typescript", nativeWidth: null, nativeHeight: null } },
  points: [{ pointId: "p-2", groupId: "default", model: "circle", grade: "not-evaluated", finalState: null, sampleCount: 0, stateCounts: { valid: 0, suspect: 0, lost: 0, reviewed: 0, paused: 0 }, validRatio: 0, lostRatio: 0, start: null, end: null, dx: null, dy: null, xRange: null, yRange: null, confidence: { p50: null, p95: null }, gatingFailures: {}, relocationMethods: {} }, { pointId: "p-1", groupId: "default", model: "circle", grade: "not-evaluated", finalState: null, sampleCount: 0, stateCounts: { valid: 0, suspect: 0, lost: 0, reviewed: 0, paused: 0 }, validRatio: 0, lostRatio: 0, start: null, end: null, dx: null, dy: null, xRange: null, yRange: null, confidence: { p50: null, p95: null }, gatingFailures: {}, relocationMethods: {} }],
  tracks: [], registrations: [], events: [], chartSeries: [], registration: { count: 0, acceptedCount: 0, rejectedCount: 0, successRate: 0, meanInlierRatio: null, medianInlierRatio: null, meanReprojectionError: null, p95ReprojectionError: null, methodDistribution: {} }, anomalyIntervals: [], risks: [], humanInterventions: [], keyFrames: []
} as ReportModel;

describe("report package builders", () => {
  it("cleans unsafe report filenames without changing the extension", () => {
    expect(sanitizeReportFileName("项目/一:测试?.pdf")).toBe("项目_一_测试_.pdf");
    expect(reportFileStem(report)).toContain("项目_一_");
  });

  it("writes UTF-8 BOM CSV with RFC-compatible quoting", () => {
    const csv = csvWithBom([["point_id", "备注"], ["p-1", "a,b\"c\nline"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"a,b""c\nline"');
  });

  it("creates stable per-table files containing every point", () => {
    const files = buildReportCsvFiles(report);
    expect(Object.keys(files)).toEqual(["points.csv", "tracks.csv", "registrations.csv", "events.csv", "risks.csv"]);
    expect(files["points.csv"]).toContain("p-1");
    expect(files["points.csv"]).toContain("p-2");
  });

  it("builds a traceable manifest with generated and failed assets", async () => {
    const assets: ReportAssetResult[] = [
      { kind: "json", path: "data/report.json", data: new TextEncoder().encode("{}") },
      { kind: "pdf", path: "report.pdf", error: "font unavailable" }
    ];
    const manifest = await buildReportManifest(report, assets);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.grade).toBe("not-evaluated");
    expect(manifest.source?.kind).toBe("image-sequence");
    expect(manifest.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "data/report.json", status: "generated", bytes: 2 }),
      expect.objectContaining({ path: "report.pdf", status: "failed", failureReason: "font unavailable" })
    ]));
  });

  it("packages manifest, JSON and every CSV in a ZIP", async () => {
    const { blob, manifest } = await buildReportBundle(report);
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "report.pdf", "report.xlsx", "data/report.json", "data/points.csv", "data/tracks.csv", "data/registrations.csv", "data/events.csv", "data/risks.csv"]));
    expect((manifest.assets ?? []).every(asset => asset.status === "generated")).toBe(true);
    expect(ReportManifestSchema.parse(manifest).schemaVersion).toBe(2);
  });

  it("reports bundle progress and stops before packaging when cancelled", async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    controller.abort();
    await expect(buildReportBundle(report, [], undefined, {
      signal: controller.signal,
      onProgress: update => progress.push(update.phase)
    })).rejects.toMatchObject({ code: "export.cancelled" });
    expect(progress).toContain("preflight");
  });

  it("records explicitly skipped assets instead of silently dropping them", async () => {
    const selected = { ...report, options: { ...report.options, includedAssets: ["report.pdf"] } };
    const { blob, manifest } = await buildReportBundle(selected, []);
    const pdf = manifest.assets?.find(asset => asset.path === "report.pdf");
    const json = manifest.assets?.find(asset => asset.path === "data/report.json");
    expect(pdf?.status).toBe("generated");
    expect(json?.status).toBe("skipped");
    const { unzipSync } = await import("fflate");
    expect(Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())))).not.toContain("data/report.json");
  });
});
