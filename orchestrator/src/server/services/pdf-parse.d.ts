// Minimal type declaration for pdf-parse (no @types package published).
// We import the library entry directly (pdf-parse/lib/pdf-parse.js) to avoid
// the package's debug-mode test-fixture read that runs on the default import.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
  }
  function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
  export default pdfParse;
}
