import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types.js";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { renderWithQueryClient } from "../test/renderWithQueryClient";
import { InProgressBoardPage } from "./InProgressBoardPage";

vi.mock("../api", () => ({
  getJobs: vi.fn(),
  getJobStageEvents: vi.fn(),
  transitionJobStage: vi.fn(),
}));

vi.mock("../components/LogEventModal", () => ({
  LogEventModal: ({
    isOpen,
    initialStage,
    onLog,
  }: {
    isOpen: boolean;
    initialStage?: string;
    onLog: (values: { stage: string; title: string; date: string }) => void;
  }) =>
    isOpen ? (
      <div data-testid="log-event-modal" data-initial-stage={initialStage ?? ""}>
        <button
          type="button"
          onClick={() =>
            onLog({
              stage: "rejected",
              title: "Rejected",
              date: "2026-01-25T10:00",
            })
          }
        >
          Submit outcome
        </button>
      </div>
    ) : null,
}));

vi.mock("@/client/hooks/useQueryErrorToast", () => ({
  useQueryErrorToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

const renderBoard = () =>
  renderWithQueryClient(
    <MemoryRouter>
      <InProgressBoardPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getJobs).mockResolvedValue({
    jobs: [createJob({ id: "job-1", status: "in_progress" }) as Job],
    total: 1,
  } as any);
  vi.mocked(api.getJobStageEvents).mockResolvedValue([]);
});

describe("InProgressBoardPage", () => {
  it("opens the outcome modal instead of transitioning directly when a card is dropped on Closed", async () => {
    renderBoard();

    const card = await screen.findByText("Backend Engineer");
    const closedLane = screen.getByTestId("lane-closed");

    const dataTransfer = {} as DataTransfer;
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(closedLane, { dataTransfer });

    const modal = await screen.findByTestId("log-event-modal");
    expect(modal).toHaveAttribute("data-initial-stage", "rejected");
    expect(api.transitionJobStage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /submit outcome/i }));

    await waitFor(() =>
      expect(api.transitionJobStage).toHaveBeenCalledWith(
        "job-1",
        expect.objectContaining({ toStage: "closed", outcome: "rejected" }),
      ),
    );
  });
});
