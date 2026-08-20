/**
 * Rejection Insights
 * Breaks down applications that were declined: how many, at which stage,
 * on what date, and (when known) why — plus which applications have gone
 * quiet long enough to be worth a follow-up or a write-off.
 */

import { STAGE_LABELS, type StageEvent } from "@shared/types.js";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChartContainer } from "@/components/ui/chart";
import { formatTimestamp } from "@/lib/utils";

type JobForRejectionInsights = {
  id: string;
  title: string;
  employer: string;
  appliedAt: string | null;
  events: StageEvent[];
};

type StageBucket = {
  stage: string;
  label: string;
  count: number;
};

type ReasonBucket = {
  reason: string;
  count: number;
};

type RejectionRow = {
  jobId: string;
  title: string;
  employer: string;
  occurredAt: number;
  stageLabel: string;
  reason: string;
};

const NOT_SPECIFIED = "Not specified";
/** The email auto-router stamps this literal string as a placeholder, not an actual reason. */
const AUTO_DETECTED_PLACEHOLDER = "rejected";
/** Applied this long ago with zero stage activity and no outcome — likely ghosted. */
const NO_RESPONSE_THRESHOLD_DAYS = 21;

const chartConfig = {
  count: {
    label: "Declines",
    color: "var(--chart-5)",
  },
};

const stageLabelForRejection = (fromStage: StageEvent["fromStage"]) =>
  `After ${STAGE_LABELS[fromStage ?? "applied"]}`;

const findLatestOutcomeEvent = (events: StageEvent[]) =>
  [...events].reverse().find((event) => event.outcome != null) ?? null;

const buildInsights = (jobs: JobForRejectionInsights[]) => {
  const now = Date.now();
  const appliedJobs = jobs.filter((job) => job.appliedAt);

  let rejectedCount = 0;
  let withdrawnCount = 0;
  let noResponseCount = 0;
  const stageCounts = new Map<string, StageBucket>();
  const reasonCounts = new Map<string, number>();
  const rows: RejectionRow[] = [];

  for (const job of appliedJobs) {
    const outcomeEvent = findLatestOutcomeEvent(job.events);

    if (outcomeEvent?.outcome === "withdrawn") {
      withdrawnCount++;
      continue;
    }

    if (outcomeEvent?.outcome === "rejected") {
      rejectedCount++;

      const stageKey = outcomeEvent.fromStage ?? "applied";
      const stageLabel = stageLabelForRejection(outcomeEvent.fromStage);
      const bucket = stageCounts.get(stageKey) ?? {
        stage: stageKey,
        label: stageLabel,
        count: 0,
      };
      bucket.count++;
      stageCounts.set(stageKey, bucket);

      const rawReason = outcomeEvent.metadata?.reasonCode?.trim();
      const reason =
        !rawReason || rawReason === AUTO_DETECTED_PLACEHOLDER
          ? NOT_SPECIFIED
          : rawReason;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);

      rows.push({
        jobId: job.id,
        title: job.title,
        employer: job.employer,
        occurredAt: outcomeEvent.occurredAt,
        stageLabel,
        reason,
      });
      continue;
    }

    if (!outcomeEvent && job.events.length === 0 && job.appliedAt) {
      const ageDays = (now - new Date(job.appliedAt).getTime()) / 86_400_000;
      if (ageDays >= NO_RESPONSE_THRESHOLD_DAYS) {
        noResponseCount++;
      }
    }
  }

  const appliedCount = appliedJobs.length;
  const activeCount = Math.max(
    0,
    appliedCount - rejectedCount - withdrawnCount,
  );

  return {
    appliedCount,
    rejectedCount,
    withdrawnCount,
    activeCount,
    noResponseCount,
    rejectionRate: appliedCount > 0 ? (rejectedCount / appliedCount) * 100 : 0,
    stageData: Array.from(stageCounts.values()).sort(
      (a, b) => b.count - a.count,
    ),
    reasonData: Array.from(reasonCounts.entries())
      .map(([reason, count]): ReasonBucket => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    recentRows: rows
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, 15),
  };
};

const KpiTile: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div className="rounded-lg border border-border/50 bg-muted/10 px-3 py-2">
    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
    </div>
    <div className="mt-1 text-lg font-semibold">{value}</div>
  </div>
);

interface RejectionInsightsProps {
  jobs: JobForRejectionInsights[];
  error: string | null;
}

export function RejectionInsights({ jobs, error }: RejectionInsightsProps) {
  const insights = useMemo(() => buildInsights(jobs), [jobs]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rejection Insights</CardTitle>
        <CardDescription>
          How many applications were declined, at which stage, and why —
          useful for spotting where the CV or interview process is losing
          ground.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="px-4 py-6 text-sm text-destructive">{error}</div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <KpiTile label="Applied" value={String(insights.appliedCount)} />
              <KpiTile
                label="Declined"
                value={`${insights.rejectedCount} (${insights.rejectionRate.toFixed(0)}%)`}
              />
              <KpiTile
                label="Withdrawn"
                value={String(insights.withdrawnCount)}
              />
              <KpiTile label="Active" value={String(insights.activeCount)} />
              <KpiTile
                label="No Response"
                value={String(insights.noResponseCount)}
              />
            </div>

            {insights.rejectedCount === 0 ? (
              <div className="rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
                No declines logged yet. Mark a job as declined from its page,
                the queue, or the In Progress board to see the breakdown
                here.
              </div>
            ) : (
              <>
                <div>
                  <h4 className="mb-3 text-sm font-medium text-muted-foreground">
                    Declined by stage reached
                  </h4>
                  <ChartContainer
                    config={chartConfig}
                    className="aspect-auto h-[180px] w-full"
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={insights.stageData}
                        layout="vertical"
                        margin={{ left: 100, right: 20, top: 5, bottom: 5 }}
                      >
                        <CartesianGrid horizontal={false} />
                        <XAxis type="number" hide allowDecimals={false} />
                        <YAxis
                          dataKey="label"
                          type="category"
                          tickLine={false}
                          axisLine={false}
                          width={140}
                          tick={{ fontSize: 12 }}
                        />
                        <Tooltip
                          cursor={{ fill: "var(--chart-5)", opacity: 0.2 }}
                          content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const data = payload[0].payload as StageBucket;
                            return (
                              <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm">
                                <div className="font-medium">
                                  {data.label}
                                </div>
                                <div className="mt-1 text-muted-foreground">
                                  {data.count} decline
                                  {data.count === 1 ? "" : "s"}
                                </div>
                              </div>
                            );
                          }}
                        />
                        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                          {insights.stageData.map((entry) => (
                            <Cell key={entry.stage} fill="var(--chart-5)" />
                          ))}
                          <LabelList
                            dataKey="count"
                            position="right"
                            className="text-xs fill-foreground"
                          />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartContainer>
                </div>

                <div>
                  <h4 className="mb-3 text-sm font-medium text-muted-foreground">
                    Declined by reason
                  </h4>
                  <div className="space-y-1.5">
                    {insights.reasonData.map(({ reason, count }) => (
                      <div
                        key={reason}
                        className="flex items-center justify-between rounded-md border border-border/40 bg-muted/5 px-3 py-1.5 text-sm"
                      >
                        <span className="text-foreground/85">{reason}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="mb-3 text-sm font-medium text-muted-foreground">
                    Recent declines
                  </h4>
                  <div className="overflow-x-auto rounded-md border border-border/40">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">Date</th>
                          <th className="px-3 py-2 font-medium">Job</th>
                          <th className="px-3 py-2 font-medium">Stage</th>
                          <th className="px-3 py-2 font-medium">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {insights.recentRows.map((row) => (
                          <tr
                            key={`${row.jobId}-${row.occurredAt}`}
                            className="border-t border-border/30"
                          >
                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                              {formatTimestamp(row.occurredAt)}
                            </td>
                            <td className="px-3 py-2">
                              <Link
                                to={`/job/${row.jobId}`}
                                className="font-medium hover:underline"
                              >
                                {row.title}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {row.employer}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {row.stageLabel}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {row.reason}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
