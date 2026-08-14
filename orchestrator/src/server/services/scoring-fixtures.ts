/**
 * Shared fixtures for scoring accuracy checks — used by both the fast
 * deterministic regression suite (scorer.accuracy.test.ts) and the live
 * semantic eval (pipeline/scoring-eval.ts).
 *
 * The profile shape mirrors designResumeToProfile()'s output
 * (design-resume/index.ts) — a generic, multi-tenant-safe "Jane Doe" backend
 * engineer, not any real candidate's data. Experience/summary text uses the
 * same HTML subset the resume-import prompt allows (<p>, <ul>, <li>,
 * <strong>, <em>) so these fixtures double as the regression case for the
 * "raw HTML reached the scoring LLM" incident.
 */

import type { Job } from "@shared/types";
import { createJob } from "@shared/testing/factories";

export function buildFixtureProfile(
  overrides: Partial<{
    experienceCount: number;
    projectCount: number;
  }> = {},
): Record<string, unknown> {
  const experienceCount = overrides.experienceCount ?? 3;
  const projectCount = overrides.projectCount ?? 2;

  const allExperience = [
    {
      id: "exp-1",
      company: "Northwind Systems",
      position: "Senior Backend Engineer",
      location: "Remote",
      date: "2021 - Present",
      summary:
        "<p>Own the payments processing service handling 40M+ requests/day.</p><ul><li>Migrated the core API from Python 2 to Python 3 with zero downtime</li><li>Designed a Kubernetes-based autoscaling pipeline cutting infra cost 30%</li><li>Led on-call rotation for a 6-person distributed systems team</li></ul>",
      visible: true,
    },
    {
      id: "exp-2",
      company: "Bluefield Data",
      position: "Backend Engineer",
      location: "Berlin, Germany",
      date: "2018 - 2021",
      summary:
        "<p>Built the event-streaming ingestion layer on <strong>Kafka</strong> and <strong>Postgres</strong>.</p><ul><li>Reduced p99 query latency from 900ms to 120ms</li><li>Wrote the on-call runbooks still used by the team today</li></ul>",
      visible: true,
    },
    {
      id: "exp-3",
      company: "Fernwood Labs",
      position: "Junior Software Engineer",
      location: "Munich, Germany",
      date: "2016 - 2018",
      summary:
        "<p>Maintained internal tooling in <em>Django</em> and <em>Celery</em>.</p>",
      visible: true,
    },
    {
      id: "exp-4",
      company: "Pinecrest Analytics",
      position: "Software Engineering Intern",
      location: "Remote",
      date: "2015 - 2016",
      summary: "<p>Built internal dashboards in Flask.</p>",
      visible: true,
    },
    {
      id: "exp-5",
      company: "Cedarline Tech",
      position: "QA Intern",
      location: "Remote",
      date: "2014 - 2015",
      summary: "<p>Automated regression test suites.</p>",
      visible: true,
    },
    {
      id: "exp-6",
      company: "Should Never Appear Co",
      position: "This item is beyond the 5-item cap",
      location: "Nowhere",
      date: "2013 - 2014",
      summary: "<p>If this text reaches the prompt, the cap regressed.</p>",
      visible: true,
    },
  ];

  const allProjects = [
    {
      id: "proj-1",
      name: "Open-source rate limiter",
      description:
        "<p>Distributed token-bucket rate limiter used by three internal services.</p>",
      summary:
        "<p>Distributed token-bucket rate limiter used by three internal services.</p>",
      date: "2022",
      visible: true,
      keywords: [],
      url: "",
    },
    {
      id: "proj-2",
      name: "Postgres query planner visualizer",
      description: "<p>CLI tool that renders EXPLAIN ANALYZE output as a tree.</p>",
      summary: "<p>CLI tool that renders EXPLAIN ANALYZE output as a tree.</p>",
      date: "2021",
      visible: true,
      keywords: [],
      url: "",
    },
    {
      id: "proj-3",
      name: "Should never appear project A",
      description: "<p>Beyond the 6-item cap.</p>",
      summary: "<p>Beyond the 6-item cap.</p>",
      date: "2020",
      visible: true,
      keywords: [],
      url: "",
    },
    {
      id: "proj-4",
      name: "Should never appear project B",
      description: "<p>Beyond the 6-item cap.</p>",
      summary: "<p>Beyond the 6-item cap.</p>",
      date: "2020",
      visible: true,
      keywords: [],
      url: "",
    },
    {
      id: "proj-5",
      name: "Should never appear project C",
      description: "<p>Beyond the 6-item cap.</p>",
      summary: "<p>Beyond the 6-item cap.</p>",
      date: "2020",
      visible: true,
      keywords: [],
      url: "",
    },
    {
      id: "proj-6",
      name: "Should never appear project D",
      description: "<p>Beyond the 6-item cap.</p>",
      summary: "<p>Beyond the 6-item cap.</p>",
      date: "2020",
      visible: true,
      keywords: [],
      url: "",
    },
    {
      id: "proj-7",
      name: "Should never appear project E",
      description: "<p>Beyond the 6-item cap.</p>",
      summary: "<p>Beyond the 6-item cap.</p>",
      date: "2020",
      visible: true,
      keywords: [],
      url: "",
    },
  ];

  return {
    basics: {
      name: "Jane Doe",
      label: "Senior Backend Engineer | Distributed Systems · Kubernetes · Postgres",
      headline: "Senior Backend Engineer | Distributed Systems · Kubernetes · Postgres",
      summary:
        "<p>Backend engineer with 8+ years building high-throughput distributed systems in <strong>Python</strong> and <strong>Go</strong>. Deep experience with <em>Kubernetes</em>, <em>Postgres</em>, and event-driven architectures at scale.</p>",
      location: { address: "Munich, Germany" },
    },
    sections: {
      skills: {
        id: "skills",
        visible: true,
        name: "Skills",
        items: [
          {
            id: "skill-1",
            name: "Languages",
            description: "",
            level: 5,
            keywords: ["Python", "Go", "SQL"],
            visible: true,
          },
          {
            id: "skill-2",
            name: "Infrastructure",
            description: "",
            level: 5,
            keywords: ["Kubernetes", "Docker", "Terraform"],
            visible: true,
          },
          {
            id: "skill-3",
            name: "Data",
            description: "",
            level: 4,
            keywords: ["Postgres", "Kafka", "Redis"],
            visible: true,
          },
        ],
      },
      experience: {
        id: "experience",
        visible: true,
        name: "Experience",
        items: allExperience.slice(0, experienceCount),
      },
      projects: {
        id: "projects",
        visible: true,
        name: "Projects",
        items: allProjects.slice(0, projectCount),
      },
      education: {
        id: "education",
        visible: true,
        name: "Education",
        items: [
          {
            id: "edu-1",
            school: "State Technical University",
            degree: "B.Sc.",
            area: "Computer Science",
            date: "2016",
            visible: true,
          },
        ],
      },
    },
  };
}

/** A job that should score well against buildFixtureProfile()'s skill set. */
export function buildStrongMatchJob(overrides: Partial<Job> = {}): Job {
  return createJob({
    id: "eval-strong-match",
    title: "Senior Backend Engineer",
    employer: "Riverton Cloud",
    location: "Remote",
    salary: "€80,000 - €100,000",
    jobDescription:
      "We're hiring a Senior Backend Engineer to own our core distributed systems. " +
      "You'll work daily with Python, Kubernetes, and Postgres, designing high-throughput " +
      "services and mentoring the team on distributed systems fundamentals. 5+ years of " +
      "backend engineering experience required. Fully remote, no relocation needed.",
    ...overrides,
  });
}

/** A job in a completely unrelated domain — should score poorly. */
export function buildMismatchJob(overrides: Partial<Job> = {}): Job {
  return createJob({
    id: "eval-mismatch",
    title: "Executive Pastry Chef",
    employer: "Le Bernardin Munich",
    location: "Munich, Germany",
    salary: "€45,000 - €55,000",
    jobDescription:
      "We are seeking an Executive Pastry Chef to lead our dessert program. " +
      "Requires 10+ years of professional pastry experience, a culinary degree, " +
      "and hands-on experience with chocolate work, laminated doughs, and plated desserts. " +
      "On-site, six days a week.",
    ...overrides,
  });
}

/** A job with a clear, unresolvable hard requirement — should cap low. */
export function buildDealbreakerJob(overrides: Partial<Job> = {}): Job {
  return createJob({
    id: "eval-dealbreaker",
    title: "Backend Engineer (Active Security Clearance Required)",
    employer: "Federal Systems Group",
    location: "Washington, DC, USA",
    salary: "$140,000 - $160,000",
    jobDescription:
      "Backend Engineer role requiring an ACTIVE US GOVERNMENT SECURITY CLEARANCE " +
      "(Top Secret/SCI) as a condition of employment — this is a hard, non-negotiable " +
      "requirement, no exceptions, no sponsorship path. Must be a US citizen residing " +
      "in the Washington DC area, on-site five days a week. Python and Kubernetes " +
      "experience required.",
    ...overrides,
  });
}
