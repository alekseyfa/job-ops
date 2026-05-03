/**
 * Changelog entries for the Telegram bot notification system.
 *
 * Each entry represents a release with user-facing changes.
 * Entries are sent to all authorized chats on bot startup
 * if they haven't been sent yet, then pinned for easy access.
 *
 * Guidelines for writing entries:
 * - Use simple, non-technical language
 * - Explain WHAT changed and HOW it helps
 * - Include a brief instruction if the user needs to do something
 * - Keep each item to 1-2 lines
 * - Use emojis for visual scanning
 */

export interface ChangelogEntry {
  /** Unique version identifier (semver-like, e.g. "1.2.0"). Must be monotonically increasing. */
  version: string;
  /** Release date in YYYY-MM-DD format */
  date: string;
  /** Items in this release */
  items: ChangelogItem[];
}

export interface ChangelogItem {
  /** Emoji + short title */
  title: string;
  /** 1-2 sentence plain-language description */
  description: string;
  /** Optional tip or instruction */
  tip?: string;
}

/**
 * Changelog entries, newest first.
 * Only add entries HERE when shipping user-visible changes.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.1.0",
    date: "2026-05-03",
    items: [
      {
        title: "📡 ATS Board Scanner",
        description:
          "Track company career pages directly from Greenhouse, Ashby, and Lever — completely free, no AI tokens used.",
        tip: 'Tap "📡 Boards" in the main menu to add companies like Stripe, Anthropic, or Netflix.',
      },
      {
        title: "📄 Smarter PDF Resumes",
        description:
          "Your resumes now pass ATS scanners more reliably. Special characters that used to confuse automated screening are automatically cleaned up.",
      },
    ],
  },
];

/**
 * Get the latest changelog version.
 */
export function getLatestChangelogVersion(): string {
  return CHANGELOG.length > 0 ? CHANGELOG[0].version : "0.0.0";
}

/**
 * Get all changelog entries newer than a given version.
 * Returns entries in newest-first order.
 */
export function getChangelogSince(
  sinceVersion: string | null,
): ChangelogEntry[] {
  if (!sinceVersion) return CHANGELOG;
  const sinceIndex = CHANGELOG.findIndex((e) => e.version === sinceVersion);
  if (sinceIndex === -1) return CHANGELOG; // Unknown version → send all
  return CHANGELOG.slice(0, sinceIndex);
}

/**
 * Format changelog entries into a single HTML message for Telegram.
 */
export function formatChangelogMessage(entries: ChangelogEntry[]): string {
  if (entries.length === 0) return "";

  const latestVersion = entries[0].version;
  const lines: string[] = [
    `<b>📢 What's New — v${latestVersion}</b>`,
    "",
  ];

  for (const entry of entries) {
    for (const item of entry.items) {
      lines.push(`<b>${item.title}</b>`);
      lines.push(item.description);
      if (item.tip) {
        lines.push(`💡 <i>${item.tip}</i>`);
      }
      lines.push("");
    }
  }

  lines.push("Questions? Send /menu to explore.");

  return lines.join("\n").trim();
}
