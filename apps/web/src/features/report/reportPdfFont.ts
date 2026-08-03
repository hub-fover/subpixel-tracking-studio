const FONT_FILE = "NotoSansSC-Variable.ttf";

export type ReportPdfError = Error & { code: string; recoverable: boolean };

function pdfError(code: string, message: string): ReportPdfError {
  return Object.assign(new Error(message), { code, recoverable: true });
}

export function validateTrueTypeFont(data: Uint8Array): Uint8Array {
  const trueType = data.length >= 12 && data[0] === 0x00 && data[1] === 0x01 && data[2] === 0x00 && data[3] === 0x00;
  if (!trueType) throw pdfError("report.pdf-font-invalid", "中文 PDF 字体不是 jsPDF 支持的 TrueType 字体");
  return data;
}

export function fontBytesToBase64(data: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < data.length; index += 0x8000) {
    binary += String.fromCharCode(...data.subarray(index, Math.min(index + 0x8000, data.length)));
  }
  return btoa(binary);
}

let cachedFont: Promise<Uint8Array> | undefined;

export function loadReportPdfFont(signal?: AbortSignal): Promise<Uint8Array> {
  if (cachedFont) return cachedFont;
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");
  const request = fetch(`${base}fonts/${FONT_FILE}`, { signal }).then(async response => {
    if (!response.ok) throw pdfError("report.pdf-font-unavailable", `中文 PDF 字体加载失败 (${response.status})`);
    return validateTrueTypeFont(new Uint8Array(await response.arrayBuffer()));
  });
  cachedFont = request.catch(error => {
    cachedFont = undefined;
    throw error;
  });
  return cachedFont;
}

export function resetReportPdfFontCache(): void {
  cachedFont = undefined;
}

export function validateUnicodePdf(data: Uint8Array): void {
  const binary = new TextDecoder("latin1").decode(data);
  if (!binary.includes("/FontFile2") || !binary.includes("/ToUnicode")) {
    throw pdfError("report.pdf-font-embedding-failed", "中文字体未正确嵌入 PDF，请重试字体加载");
  }
}

