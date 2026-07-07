/**
 * Single-column layout collapse for tailored job PDFs (WS1-T4).
 *
 * The default RxResume "onyx" layout puts skills/certifications/languages into
 * a sidebar (a two-column page). Multi-column PDFs are the canonical cause of
 * ATS parse failure — linear-reading parsers (Workday, Taleo) scramble or drop
 * the sidebar, and skills is the most keyword-dense, ATS-critical section.
 *
 * This helper collapses every page to a single column: it appends the sidebar
 * sections to the end of the main column (preserving a sane top-to-bottom
 * reading order — main content first, then the former sidebar), clears the
 * sidebar, and sets fullWidth so the renderer uses the whole page width.
 *
 * Applied ONLY to tailored job PDFs, behind the `tailoredPdfSingleColumn`
 * setting — never to the user's editable base/design resume. Pure: mutates the
 * passed working copy in place (callers already work on a clone).
 */

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

export function collapseToSingleColumn(resumeData: RecordLike): void {
  const metadata = asRecord(resumeData.metadata);
  const layout = asRecord(metadata?.layout);
  if (!layout || !Array.isArray(layout.pages)) return;

  for (const rawPage of layout.pages) {
    const page = asRecord(rawPage);
    if (!page) continue;

    const main = Array.isArray(page.main) ? (page.main as string[]) : [];
    const sidebar = Array.isArray(page.sidebar)
      ? (page.sidebar as string[])
      : [];

    // Append sidebar sections that aren't already in main (dedup), preserving
    // main-first order. Skills etc. land after the main content but still in a
    // single linear column the parser can read top-to-bottom.
    const seen = new Set(main);
    const merged = [...main];
    for (const section of sidebar) {
      if (!seen.has(section)) {
        merged.push(section);
        seen.add(section);
      }
    }

    page.main = merged;
    page.sidebar = [];
    page.fullWidth = true;
  }
}
