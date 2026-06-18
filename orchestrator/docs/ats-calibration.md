# ATS Coverage Calibration (manual)

The "ATS coverage %" surfaced on the Telegram job card (and stored in
`jobs.tailoring_report`) is an **internal heuristic**, not a real ATS score.

## Why it is only a proxy

`computeAtsCoverage` works on text extracted from the rendered PDF with
`pdf-parse`. `pdf-parse` reconstructs reading order with its **own** rules,
which do **not** match how Workday, Taleo, Greenhouse, iCIMS, or Lever parse a
resume. A clean `pdf-parse` round-trip does **not** prove a real ATS parses the
resume correctly, and a messy one does not prove it fails. The number is useful
as a **relative** signal (did this tailoring raise coverage vs the base resume?
did a layout change drop the Skills header?), not as an absolute guarantee.

## Manual ground-truth procedure

Run this when you change the renderer, the single-column collapse, or the
coverage algorithm — and record the results so we know the drift.

1. Pick **5 neutral (JD, resume) pairs** (generic roles; no production-user
   data — e.g. "Backend Engineer", "Data Analyst").
2. Generate the tailored PDF for each (enable `atsCoverageReportEnabled` and,
   if testing it, `tailoredPdfSingleColumn` / `tailorExperienceBullets`).
3. Submit each tailored PDF to **1–2 real ATS parsers**:
   - A Greenhouse/Lever sandbox application (inspect the parsed candidate
     record: did name/email/skills/experience land in the right fields?), or
   - An open-source / trial resume parser (Affinda, Sovren, RChilli trial).
4. For each pair, tabulate: our `coveragePct`, our `sectionsDetected`, and the
   external parser's field-extraction result.
5. Note acceptable drift. If our number is high but the real parser drops the
   Skills section, that is a calibration miss — investigate the layout, not the
   keyword math.

## Guardrails

- Never present coverage % to a user as a guaranteed ATS pass-rate.
- Keep this step **manual / not CI-gated** — it needs real ATS access.
- The honest product claim is "we test the actual rendered resume and never
  fabricate skills", not "we beat ATS X".
