import { describe, expect, it } from "vitest";
import { getDisplayStatusToken, statusTokens } from "./constants";

describe("getDisplayStatusToken", () => {
  it("falls back to the status token when there is no outcome", () => {
    const token = getDisplayStatusToken({ status: "in_progress", outcome: null });
    expect(token).toEqual(statusTokens.in_progress);
    expect(token.label).toBe("In Progress");
  });

  it("shows a declined token for a rejected job even though status stays in_progress", () => {
    const token = getDisplayStatusToken({
      status: "in_progress",
      outcome: "rejected",
    });
    expect(token.label).toBe("Declined");
  });

  it("shows a withdrawn token for a withdrawn application", () => {
    const token = getDisplayStatusToken({
      status: "in_progress",
      outcome: "withdrawn",
    });
    expect(token.label).toBe("Withdrawn");
  });

  it("shows a hired token for an accepted offer", () => {
    const token = getDisplayStatusToken({
      status: "in_progress",
      outcome: "offer_accepted",
    });
    expect(token.label).toBe("Hired");
  });
});
