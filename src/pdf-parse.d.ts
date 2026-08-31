// pdf-parse's index.js runs a self-test on import when `module.parent` is unset,
// which is always the case under ESM, so it must be imported by its lib path.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info?: Record<string, unknown>;
    metadata?: unknown;
    text: string;
    version: string;
  }

  export default function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
}
