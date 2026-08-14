/**
 * Live semantic eval for the scoring pipeline — the second tier of the
 * scoring accuracy test strategy (see CLAUDE.md → "Scoring Accuracy Tests").
 *
 * scorer.accuracy.test.ts (fast, mocked LLM) guards the PROMPT — that HTML
 * never reaches it, that resume content isn't silently dropped. It cannot
 * catch the underlying complaint this suite exists for: "the job list is
 * inaccurate and the score is far from real." That's a property of what the
 * actually-configured LLM does with a well-formed prompt, and the only way
 * to check it is to run the real scoring path against real inputs with a
 * known expected outcome.
 *
 * This script runs scoreJobSuitability() for real — real settings, real
 * configured LLM (whatever's set in Settings/.env, local or cloud) — against
 * three fixture cases with an unambiguous expected direction, and reports
 * PASS/FAIL. It requires a working LLM connection and is NOT part of the
 * fast Docker test gate; run it manually after changing scorer.ts, the
 * scoringPromptTemplate, or the resume→profile mapping in design-resume.
 *
 * Usage: npm run eval:scoring
 */

import "../config/env";
import { closeDb } from "../db/index";
import { runWithRequestContext } from "../infra/request-context";
import { scoreJobSuitability } from "../services/scorer";
import {
  buildDealbreakerJob,
  buildFixtureProfile,
  buildMismatchJob,
  buildStrongMatchJob,
} from "../services/scoring-fixtures";
import { DEFAULT_TENANT_ID } from "../tenancy/constants";

// This exact phrasing is the fingerprint of the incident that motivated this
// eval: a rich, fully-populated resume being scored as though it were empty
// (because raw HTML reached the prompt). A well-behaved model should never
// hedge like this against buildFixtureProfile() — regardless of how well the
// job itself matches.
const INCOMPLETE_PROFILE_LANGUAGE =
  /profile is incomplete|lacks a complete profile|candidate profile is incomplete|insufficient (information|profile)|cannot (assess|determine|evaluate) (the )?(fit|match)/i;

type Verdict = { label: string; pass: boolean; detail: string };

type EvalCase = {
  name: string;
  run: () => Promise<{ score: number; reason: string; dealBreakers: string[] }>;
  checks: (result: { score: number; reason: string; dealBreakers: string[] }) => Verdict[];
};

const CASES: EvalCase[] = [
  {
    name: "Strong match — Senior Backend Engineer job vs. a matching resume",
    run: async () => {
      const result = await scoreJobSuitability(
        buildStrongMatchJob(),
        buildFixtureProfile(),
      );
      return {
        score: result.score,
        reason: result.reason,
        dealBreakers: result.matchAnalysis?.dealBreakers ?? [],
      };
    },
    checks: (r) => [
      {
        label: "score >= 55 (real skill/experience overlap should score well)",
        pass: r.score >= 55,
        detail: `score=${r.score}`,
      },
      {
        label: "reason does not hedge that the profile looks incomplete",
        pass: !INCOMPLETE_PROFILE_LANGUAGE.test(r.reason),
        detail: `reason="${r.reason}"`,
      },
    ],
  },
  {
    name: "Clear mismatch — Executive Pastry Chef job vs. a backend engineer resume",
    run: async () => {
      const result = await scoreJobSuitability(
        buildMismatchJob(),
        buildFixtureProfile(),
      );
      return {
        score: result.score,
        reason: result.reason,
        dealBreakers: result.matchAnalysis?.dealBreakers ?? [],
      };
    },
    checks: (r) => [
      {
        label: "score <= 40 (zero domain overlap should score low)",
        pass: r.score <= 40,
        detail: `score=${r.score}`,
      },
      {
        label: "reason does not hedge that the profile looks incomplete",
        pass: !INCOMPLETE_PROFILE_LANGUAGE.test(r.reason),
        detail: `reason="${r.reason}"`,
      },
    ],
  },
  {
    name: "Hard dealbreaker — security-clearance job vs. a resume without one",
    run: async () => {
      const result = await scoreJobSuitability(
        buildDealbreakerJob(),
        buildFixtureProfile(),
      );
      return {
        score: result.score,
        reason: result.reason,
        dealBreakers: result.matchAnalysis?.dealBreakers ?? [],
      };
    },
    checks: (r) => [
      {
        label: "score <= 50 (unresolved hard requirement caps the score)",
        pass: r.score <= 50,
        detail: `score=${r.score}`,
      },
      {
        label: "dealBreakers array is non-empty (model must surface the blocker)",
        pass: r.dealBreakers.length > 0,
        detail: `dealBreakers=${JSON.stringify(r.dealBreakers)}`,
      },
    ],
  },
];

async function main() {
  console.log("=".repeat(70));
  console.log("🎯 Scoring Accuracy Eval");
  console.log("   Exercising the real configured LLM against fixed cases.");
  console.log("=".repeat(70));

  let anyFailed = false;

  for (const testCase of CASES) {
    console.log(`\n▶ ${testCase.name}`);
    const started = Date.now();
    try {
      const result = await testCase.run();
      const elapsedMs = Date.now() - started;
      const verdicts = testCase.checks(result);

      for (const verdict of verdicts) {
        const icon = verdict.pass ? "✅" : "❌";
        console.log(`  ${icon} ${verdict.label}`);
        console.log(`     ${verdict.detail}`);
        if (!verdict.pass) anyFailed = true;
      }
      console.log(`  ⏱  ${elapsedMs}ms`);
    } catch (error) {
      anyFailed = true;
      console.log(
        `  ❌ threw instead of returning a score: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(anyFailed ? "❌ Scoring eval FAILED" : "✅ Scoring eval passed");
  console.log(
    "   Note: this calls a real LLM — an occasional single-case flake on a\n" +
      "   weak local model is not automatically a regression. A *repeated*\n" +
      "   failure, or any 'profile is incomplete' hedge, is.",
  );
  console.log("=".repeat(70));

  closeDb();
  process.exit(anyFailed ? 1 : 0);
}

runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, main).catch((error) => {
  console.error("Fatal error:", error);
  closeDb();
  process.exit(1);
});
