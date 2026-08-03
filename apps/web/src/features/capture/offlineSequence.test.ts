import { describe, expect, it } from "vitest";
import { processCompleteOfflineSequence } from "./offlineSequence";

describe("complete offline sequence processing", () => {
  it("isolates a failed middle frame and continues with every later input", async () => {
    const processed: number[] = [];
    const isolated: Array<{ value: number; index: number; message: string }> = [];

    const attempted = await processCompleteOfflineSequence(
      [0, 1, 2, 3, 4],
      async value => {
        if (value === 2) throw new Error("decode failed");
        processed.push(value);
      },
      async (value, index, error) => {
        isolated.push({ value, index, message: error instanceof Error ? error.message : String(error) });
      }
    );

    expect(attempted).toBe(5);
    expect(processed).toEqual([0, 1, 3, 4]);
    expect(isolated).toEqual([{ value: 2, index: 2, message: "decode failed" }]);
  });
});
