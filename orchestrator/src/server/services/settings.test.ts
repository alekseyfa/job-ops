import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/repositories/settings", () => ({
  getAllSettings: vi.fn(),
}));

vi.mock("./design-resume", () => ({
  getCurrentDesignResumeOrNullOnLegacy: vi.fn(),
  designResumeToProfile: vi.fn(),
}));

vi.mock("./envSettings", () => ({
  getEnvSettingsData: vi.fn(),
  getOriginalEnvValue: vi.fn(),
}));

vi.mock("./profile", () => ({
  getProfile: vi.fn(),
}));

vi.mock("./resumeProjects", () => ({
  extractProjectsFromProfile: vi.fn(),
  resolveResumeProjectsSettings: vi.fn(),
}));

vi.mock("./rxresume", () => ({
  extractProjectsFromResume: vi.fn(),
  getResume: vi.fn(),
  RxResumeAuthConfigError: class RxResumeAuthConfigError extends Error {},
}));

import { getAllSettings } from "@server/repositories/settings";
import {
  designResumeToProfile,
  getCurrentDesignResumeOrNullOnLegacy,
} from "./design-resume";
import { getEnvSettingsData } from "./envSettings";
import { getProfile } from "./profile";
import {
  extractProjectsFromProfile,
  resolveResumeProjectsSettings,
} from "./resumeProjects";
import { extractProjectsFromResume } from "./rxresume";
import { getEffectiveSettings } from "./settings";

describe("getEffectiveSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue({});
    vi.mocked(getCurrentDesignResumeOrNullOnLegacy).mockResolvedValue({
      id: "primary",
      resumeJson: {},
    } as never);
    vi.mocked(designResumeToProfile).mockResolvedValue({
      basics: { name: "Local User" },
      sections: { projects: { items: [] } },
    } as never);
    vi.mocked(getEnvSettingsData).mockResolvedValue({} as never);
    vi.mocked(getProfile).mockResolvedValue({} as never);
    vi.mocked(extractProjectsFromProfile).mockReturnValue({
      catalog: [{ id: "local-project", label: "Local project" }],
      selectionItems: [],
    } as never);
    vi.mocked(extractProjectsFromResume).mockImplementation(() => {
      throw new Error("should not use RxResume extractor for local profile");
    });
    vi.mocked(resolveResumeProjectsSettings).mockImplementation(
      ({ catalog }) =>
        ({
          profileProjects: catalog,
          resumeProjects: {
            lockedProjectIds: [],
            aiSelectableProjectIds: [],
            maxProjects: 3,
          },
          defaultResumeProjects: {
            lockedProjectIds: [],
            aiSelectableProjectIds: [],
            maxProjects: 3,
          },
          overrideResumeProjects: null,
        }) as never,
    );
  });

  it("uses extractProjectsFromProfile for a local Design Resume projection", async () => {
    const settings = await getEffectiveSettings();

    expect(extractProjectsFromProfile).toHaveBeenCalledTimes(1);
    expect(extractProjectsFromResume).not.toHaveBeenCalled();
    expect(settings.profileProjects).toEqual([
      { id: "local-project", label: "Local project" },
    ]);
  });

  it("falls back when no compatible local Design Resume is available", async () => {
    vi.mocked(getCurrentDesignResumeOrNullOnLegacy).mockResolvedValue(null);

    await expect(getEffectiveSettings()).resolves.toBeTruthy();
    expect(designResumeToProfile).not.toHaveBeenCalled();
  });

  it("resolves the Phase-1 flags with conservative (feature-off) defaults", async () => {
    const settings = await getEffectiveSettings();

    // Every risky WS1/WS3 feature must be OFF by default so the foundation
    // commit changes no behavior.
    expect(settings.tailoredPdfSingleColumn.value).toBe(false);
    expect(settings.tailorExperienceBullets.value).toBe(false);
    expect(settings.atsCoverageReportEnabled.value).toBe(false);
    expect(settings.screeningDraftEnabled.value).toBe(false);
    expect(settings.maxResumePages.value).toBe(1);
    expect(settings.tailoringPromptVersion.value).toBe(1);
    expect(settings.selectionMode.value).toBe("threshold");
  });

  it("round-trips a stored override for the new flags", async () => {
    vi.mocked(getAllSettings).mockResolvedValue({
      tailorExperienceBullets: "1",
      selectionMode: "rank",
    } as never);

    const settings = await getEffectiveSettings();

    expect(settings.tailorExperienceBullets.value).toBe(true);
    expect(settings.tailorExperienceBullets.override).toBe(true);
    expect(settings.selectionMode.value).toBe("rank");
  });
});
