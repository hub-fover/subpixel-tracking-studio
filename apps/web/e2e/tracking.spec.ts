import { expect, test, type Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const sample = "C:\\Users\\biaoh\\Desktop\\1\\圆\\1.jpg";

async function importSample(page: Page) {
  await page.locator('input[type="file"]').setInputFiles(sample);
  // Cold decoding of the native 6144x8192 sample can exceed the default
  // assertion timeout; wait for the actual native canvas contract instead.
  await expect(page.locator("canvas.roi-canvas")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("canvas.roi-canvas")).toHaveAttribute("width", "6144", { timeout: 15000 });
  await expect(page.locator("canvas.roi-canvas")).toHaveAttribute("height", "8192", { timeout: 15000 });
}

async function dragRoi(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const canvas = page.locator("canvas.roi-canvas"); const box = await canvas.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * from.x, box!.y + box!.height * from.y); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * to.x, box!.y + box!.height * to.y); await page.mouse.up();
}

test("imports a 6144x8192 image without downsampling", async ({ page }) => {
  const errors: string[] = []; page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/"); await importSample(page); const canvas = page.locator("canvas.roi-canvas");
  await expect(canvas).toHaveAttribute("width", "6144"); await expect(canvas).toHaveAttribute("height", "8192"); await expect(page.getByText(/6144.*8192/)).toBeVisible(); expect(errors).toEqual([]);
});

test("rectangle ROI creates a draft and clicking does not create a point", async ({ page }) => {
  await page.goto("/"); await importSample(page); await expect(page.locator(".seed-row")).toHaveCount(0); await dragRoi(page, { x: .2, y: .1 }, { x: .8, y: .9 });
  await expect(page.locator(".draft-state")).toBeVisible(); await expect(page.getByRole("button", { name: "确认点" })).toBeVisible(); await expect(page.locator(".seed-row")).toHaveCount(0);
});

test("accepted ROI can be confirmed and renders a center crosshair", async ({ page }) => {
  await page.goto("/"); await importSample(page); await page.getByLabel("提取类型").selectOption("blob-center");
  await dragRoi(page, { x: .4, y: .3 }, { x: .6, y: .6 });
  await expect(page.locator(".draft-ready")).toBeVisible({ timeout: 5000 }); const confirm = page.getByRole("button", { name: "确认点" }); await expect(confirm).toBeEnabled(); await confirm.click();
  await expect(page.locator(".seed-row strong", { hasText: "p-001" })).toBeVisible(); await expect(page.locator(".seed-row")).toHaveCount(1);
});

test("a real circular target can be refined and confirmed", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/");
  await importSample(page);
  await page.getByLabel("提取类型").selectOption("circle-center");
  await dragRoi(page, { x: .225, y: .625 }, { x: .275, y: .675 });

  await expect(page.locator(".draft-ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="refinement-quality"]')).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认点" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator('.seed-row strong', { hasText: "p-001" })).toBeVisible();
  await expect(page.locator('[data-point-id="p-001"]').first()).toBeVisible();
});

test("an unwanted ROI can be deleted before entering the point set", async ({ page }) => {
  await page.goto("/"); await importSample(page); await dragRoi(page, { x: .01, y: .01 }, { x: .15, y: .15 }); await expect(page.locator(".draft-state")).toBeVisible();
  await page.getByRole("button", { name: "删除草稿" }).click(); await expect(page.locator(".seed-row")).toHaveCount(0); await expect(page.locator(".draft-state")).toHaveCount(0);
});

test("view zoom changes CSS display only and preserves native ROI coordinates", async ({ page }) => {
  await page.goto("/"); await importSample(page); await dragRoi(page, { x: .2, y: .1 }, { x: .8, y: .9 }); const before = await page.locator(".roi-values dd").allTextContents();
  await page.getByRole("button", { name: "放大图像" }).click(); await page.getByRole("button", { name: "缩小图像" }).click(); const after = await page.locator(".roi-values dd").allTextContents(); expect(after).toEqual(before);
});

test("report center exposes frozen point data and explicit asset settings", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) apiRequests.push(request.url()); });
  await page.goto("/"); await importSample(page); await page.getByLabel("提取类型").selectOption("blob-center");
  await dragRoi(page, { x: .4, y: .3 }, { x: .6, y: .6 });
  await expect(page.locator(".draft-ready")).toBeVisible({ timeout: 10000 }); await page.getByRole("button", { name: "确认点" }).click();
  await page.getByRole("button", { name: "报告" }).click(); await expect(page.getByRole("dialog", { name: "报告中心" })).toBeVisible();
  await expect(page.getByText("确认点")).toBeVisible(); await page.getByRole("button", { name: "导出设置" }).click();
  await expect(page.getByText("报告资产")).toBeVisible(); await expect(page.getByLabel("图片包")).toHaveValue("full"); expect(apiRequests).toEqual([]);
});

test("browser PDF export embeds a searchable Chinese TrueType font", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; const apiRequests: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => { if (request.url().includes("/api/")) apiRequests.push(request.url()); });
  await page.goto("/"); await importSample(page); await page.getByLabel("提取类型").selectOption("blob-center");
  await dragRoi(page, { x: .4, y: .3 }, { x: .6, y: .6 });
  await expect(page.locator(".draft-ready")).toBeVisible({ timeout: 10_000 }); await page.getByRole("button", { name: "确认点" }).click();
  await page.getByRole("button", { name: "报告" }).click(); await page.getByRole("button", { name: "导出设置" }).click();
  await page.getByLabel("项目名称").fill("大视角中文项目"); await page.getByLabel("备注").fill("字体与防漂移复核");
  await page.getByRole("button", { name: "刷新数据快照" }).click();
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "PDF", exact: true }).click();
  const download = await downloadPromise;
  if (process.env.PDF_QA_PATH) await download.saveAs(process.env.PDF_QA_PATH);
  const path = await download.path(); expect(path).not.toBeNull();
  const binary = (await readFile(path!)).toString("latin1");
  expect(binary).toContain("/FontFile2"); expect(binary).toContain("/ToUnicode");
  expect(errors.filter(message => /font|PubSub|jsPDF/i.test(message))).toEqual([]); expect(apiRequests).toEqual([]);
});

test("Z1 offline replay attempts all 10 inputs and exposes engineering charts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The full native-image replay runs once on desktop.");
  test.setTimeout(120_000);
  const z1Directory = "C:\\Users\\biaoh\\Desktop\\1\\十字丝\\Z1";
  const frames = (await readdir(z1Directory).catch(() => [])).filter(name => /\.jpe?g$/i.test(name)).sort().map(name => join(z1Directory, name));
  test.skip(frames.length !== 10, "Requires the optional local Z1 replay fixture.");
  expect(frames).toHaveLength(10);

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(frames);
  await expect(page.locator("canvas.roi-canvas")).toHaveAttribute("width", "1279", { timeout: 15_000 });
  await expect(page.locator("canvas.roi-canvas")).toHaveAttribute("height", "1706");
  await page.getByLabel("提取类型").selectOption("crosshair-center");
  await dragRoi(page, { x: 569 / 1279, y: 376 / 1706 }, { x: 596 / 1279, y: 407 / 1706 });
  await expect(page.locator(".draft-ready")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "确认点" }).click();

  await page.getByRole("button", { name: "开始跟踪" }).click();
  const degraded = page.getByRole("button", { name: "确认小位移降级模式" });
  if (await degraded.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await degraded.click();
    await page.getByRole("button", { name: "开始跟踪" }).click();
  }
  await expect(page.getByTestId("frame-progress")).toContainText("输入/已处理 10/10", { timeout: 60_000 });

  const reviewButton = page.getByRole("button", { name: /复核 p-001/ }).first();
  await expect(reviewButton).toBeVisible();
  const reviewRow = reviewButton.locator("xpath=ancestor::tr");
  const reviewedFrame = await reviewRow.getAttribute("data-frame");
  expect(reviewedFrame).not.toBeNull();
  await reviewButton.click();
  const reviewedRow = page.locator(`tr[data-point-id="p-001"][data-frame="${reviewedFrame}"]`);
  await expect(reviewedRow.locator(".state-reviewed")).toHaveText("已复核");
  await expect(reviewedRow.getByText("已复核", { exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: "报告" }).click();
  const dialog = page.getByRole("dialog", { name: "报告中心" });
  await expect(dialog).toContainText("10/10");
  await expect(dialog.locator('[data-chart-id="fixed-topology"] svg')).toBeVisible();
  await dialog.getByRole("button", { name: "点质量" }).click();
  await expect(dialog.locator('[data-chart-id$="-trajectory"] svg')).toBeVisible();
  await expect(dialog.locator('[data-chart-id$="-confidence"] svg')).toBeVisible();
  if (process.env.REPORT_QA_SCREENSHOT) await dialog.screenshot({ path: process.env.REPORT_QA_SCREENSHOT });
  if (process.env.REPORT_QA_PDF) {
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "PDF", exact: true }).click();
    const download = await downloadPromise;
    await download.saveAs(process.env.REPORT_QA_PDF);
  }
});
