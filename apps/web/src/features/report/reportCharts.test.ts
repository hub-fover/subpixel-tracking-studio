import { describe, expect, it } from "vitest";
import { chartPathSegments, type ReportChartSeries } from "./reportCharts";

describe("engineering report chart specifications", () => {
  it("breaks a trajectory at every missing frame instead of drawing through missing data", () => {
    const series: ReportChartSeries = {
      id: "p-001-trajectory",
      label: "轨迹",
      color: "#087f73",
      symbol: "circle",
      points: [
        { x: 10, y: 10, frame: 0, defined: true, state: "valid" },
        { x: 11, y: 11, frame: 1, defined: true, state: "provisional" },
        { x: 0, y: 0, frame: 2, defined: false, state: "lost" },
        { x: 13, y: 13, frame: 3, defined: true, state: "valid" },
        { x: 0, y: 0, frame: 4, defined: false, state: "paused" },
        { x: 15, y: 15, frame: 5, defined: true, state: "suspect" }
      ]
    };

    expect(chartPathSegments(series).map(segment => segment.map(point => point.frame))).toEqual([[0, 1], [3], [5]]);
  });
});
