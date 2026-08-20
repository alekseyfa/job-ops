import { createJob } from "@shared/testing/factories.js";
import type { JobListItem } from "@shared/types.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobRowContent } from "./JobRowContent";

const toListItem = (overrides: Partial<JobListItem> = {}): JobListItem =>
  createJob(overrides) as unknown as JobListItem;

describe("JobRowContent", () => {
  it("shows the plain status label when there is no outcome yet", () => {
    render(
      <JobRowContent job={toListItem({ status: "in_progress", outcome: null })} />,
    );

    expect(screen.getByTitle("In Progress")).toBeInTheDocument();
  });

  it("shows a declined label instead of In Progress once the job is rejected", () => {
    render(
      <JobRowContent
        job={toListItem({ status: "in_progress", outcome: "rejected" })}
      />,
    );

    expect(screen.getByTitle("Declined")).toBeInTheDocument();
    expect(screen.queryByTitle("In Progress")).not.toBeInTheDocument();
  });

  it("shows a withdrawn label for a withdrawn application", () => {
    render(
      <JobRowContent
        job={toListItem({ status: "in_progress", outcome: "withdrawn" })}
      />,
    );

    expect(screen.getByTitle("Withdrawn")).toBeInTheDocument();
  });
});
