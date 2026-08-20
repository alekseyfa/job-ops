import {
  createJob as createBaseJob,
  createStageEvent,
} from "@shared/testing/factories.js";
import type { StageEvent } from "@shared/types.js";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RejectionInsights } from "./RejectionInsights";

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("recharts", () => ({
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Bar: () => null,
  Cell: () => null,
  LabelList: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("react-router-dom", () => ({
  Link: ({
    children,
    to,
  }: {
    children: React.ReactNode;
    to: string;
  }) => <a href={to}>{children}</a>,
}));

type JobWithEvents = {
  id: string;
  title: string;
  employer: string;
  appliedAt: string | null;
  events: StageEvent[];
};

const createJob = (overrides: Partial<JobWithEvents>): JobWithEvents => {
  const base = createBaseJob(overrides);
  return {
    id: base.id,
    title: base.title,
    employer: base.employer,
    appliedAt: overrides.appliedAt ?? null,
    events: overrides.events ?? [],
  };
};

const rejectedEvent = (
  overrides: Partial<StageEvent> = {},
): StageEvent =>
  createStageEvent({
    id: "event-rejected",
    applicationId: "job-1",
    toStage: "closed",
    fromStage: "technical_interview",
    occurredAt: 1_704_844_800,
    outcome: "rejected",
    metadata: { reasonCode: "Skills" },
    ...overrides,
  });

describe("RejectionInsights", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the empty state when nothing has been declined yet", () => {
    render(
      <RejectionInsights
        jobs={[createJob({ id: "job-1", appliedAt: "2026-01-01T00:00:00Z" })]}
        error={null}
      />,
    );

    expect(
      screen.getByText(/no declines logged yet/i),
    ).toBeInTheDocument();
  });

  it("counts declines by stage reached and by reason", () => {
    const jobs = [
      createJob({
        id: "job-1",
        appliedAt: "2026-01-01T00:00:00Z",
        events: [rejectedEvent({ id: "e1", applicationId: "job-1" })],
      }),
      createJob({
        id: "job-2",
        title: "Frontend Engineer",
        appliedAt: "2026-01-02T00:00:00Z",
        events: [
          rejectedEvent({
            id: "e2",
            applicationId: "job-2",
            fromStage: "recruiter_screen",
            occurredAt: 1_704_844_700,
            metadata: { reasonCode: "Visa" },
          }),
        ],
      }),
      createJob({
        id: "job-3",
        appliedAt: "2026-01-03T00:00:00Z",
        events: [
          createStageEvent({
            id: "e3",
            applicationId: "job-3",
            toStage: "closed",
            occurredAt: 1_704_844_900,
            outcome: "withdrawn",
          }),
        ],
      }),
      createJob({ id: "job-4", appliedAt: "2026-01-04T00:00:00Z" }),
    ];

    render(<RejectionInsights jobs={jobs} error={null} />);

    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2 (50%)")).toBeInTheDocument();
    expect(screen.getByText("After Technical Interview")).toBeInTheDocument();
    expect(screen.getByText("After Recruiter Screen")).toBeInTheDocument();
    // "Skills"/"Visa" legitimately appear twice: once in the reason
    // breakdown, once in the recent-declines table row.
    expect(screen.getAllByText("Skills").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Visa").length).toBeGreaterThan(0);

    const jobLink = screen.getByRole("link", { name: "Backend Engineer" });
    expect(jobLink).toHaveAttribute("href", "/job/job-1");
  });

  it("folds the auto-detected email placeholder reason into 'Not specified'", () => {
    const jobs = [
      createJob({
        id: "job-1",
        appliedAt: "2026-01-01T00:00:00Z",
        events: [
          rejectedEvent({
            id: "e1",
            applicationId: "job-1",
            metadata: { reasonCode: "rejected" },
          }),
        ],
      }),
    ];

    render(<RejectionInsights jobs={jobs} error={null} />);

    expect(screen.getAllByText("Not specified").length).toBeGreaterThan(0);
  });

  it("counts applied jobs with no activity for 21+ days as no response", () => {
    const jobs = [
      createJob({ id: "job-1", appliedAt: "2026-01-01T00:00:00Z" }), // 24 days ago
      createJob({ id: "job-2", appliedAt: "2026-01-20T00:00:00Z" }), // 5 days ago
    ];

    render(<RejectionInsights jobs={jobs} error={null} />);

    expect(screen.getByText("No Response")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays the error state instead of the breakdown", () => {
    render(<RejectionInsights jobs={[]} error="Failed to load" />);

    expect(screen.getByText("Failed to load")).toBeInTheDocument();
  });
});
