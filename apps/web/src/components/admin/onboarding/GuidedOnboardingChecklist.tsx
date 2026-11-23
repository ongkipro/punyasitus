import * as React from "react";
import {
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  EyeOffIcon,
  ListChecksIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import {
  completeGuidedChecklistStep,
  createInitialGuidedChecklistState,
  dismissAllGuidedChecklist,
  dismissGuidedChecklistStep,
  evaluateGuidedOnboardingChecklist,
  parseGuidedChecklistState,
  resetGuidedChecklistStep,
  restoreGuidedChecklist,
  serializeGuidedChecklistState,
  type GuidedOnboardingChecklistState,
  type GuidedOnboardingFacts,
  type GuidedOnboardingStepId,
} from "@punyasitus/core/presets/checklist";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface GuidedOnboardingChecklistProps {
  readonly facts: GuidedOnboardingFacts;
  readonly initialState?: GuidedOnboardingChecklistState;
  /** Optional localStorage key storing ONLY step IDs and timestamps (zero PII/secrets). */
  readonly storageKey?: string;
  /** Optional server-backed persistence callback fired on every step state change. */
  readonly onChange?: (nextState: GuidedOnboardingChecklistState) => void;
  /** Alias for `onChange`. */
  readonly onStateChange?: (nextState: GuidedOnboardingChecklistState) => void;
  readonly readOnly?: boolean;
}

export function GuidedOnboardingChecklist({
  facts,
  initialState,
  storageKey,
  onChange,
  onStateChange,
  readOnly = false,
}: GuidedOnboardingChecklistProps) {
  // Always match SSR initial HTML on first client render to prevent React hydration mismatch;
  // persisted localStorage state is synchronized immediately post-mount in useEffect below.
  const [state, setState] = React.useState<GuidedOnboardingChecklistState>(
    () => initialState ?? createInitialGuidedChecklistState(),
  );

  React.useEffect(() => {
    if (typeof window === "undefined" || !storageKey || initialState) return;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        setState(parseGuidedChecklistState(saved));
      }
    } catch {
      // Ignore storage access errors in restricted contexts
    }
  }, [storageKey, initialState]);

  const commitState = React.useCallback(
    (next: GuidedOnboardingChecklistState) => {
      setState(next);
      if (typeof window !== "undefined" && storageKey) {
        try {
          window.localStorage.setItem(storageKey, serializeGuidedChecklistState(next));
        } catch {
          // Ignore quota or storage restriction errors
        }
      }
      onChange?.(next);
      onStateChange?.(next);
    },
    [storageKey, onChange, onStateChange],
  );

  const summary = React.useMemo(
    () => evaluateGuidedOnboardingChecklist(facts, state),
    [facts, state],
  );

  const handleComplete = (stepId: GuidedOnboardingStepId) => {
    if (readOnly) return;
    commitState(completeGuidedChecklistStep(state, stepId));
  };

  const handleDismissStep = (stepId: GuidedOnboardingStepId) => {
    if (readOnly) return;
    commitState(dismissGuidedChecklistStep(state, stepId));
  };

  const handleRestoreStep = (stepId: GuidedOnboardingStepId) => {
    if (readOnly) return;
    commitState(resetGuidedChecklistStep(state, stepId));
  };

  const handleDismissAll = () => {
    if (readOnly) return;
    commitState(dismissAllGuidedChecklist(state));
  };

  const handleRestoreAll = () => {
    if (readOnly) return;
    commitState(restoreGuidedChecklist(state));
  };

  if (!summary.isVisible) {
    return (
      <div
        data-testid="guided-checklist-dismissed-bar"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <ListChecksIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>
            Daftar persiapan situs disembunyikan (
            <span className="font-medium text-foreground tabular-nums">
              {summary.completedCount}/{summary.totalCount}
            </span>{" "}
            selesai).
          </span>
        </div>
        {!readOnly && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={handleRestoreAll}
            data-testid="guided-checklist-restore-all"
          >
            <RotateCcwIcon className="size-3.5" aria-hidden="true" />
            <span>Tampilkan daftar persiapan</span>
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card data-testid="guided-onboarding-checklist">
      <CardHeader className="border-b border-border">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2">
              <ListChecksIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>Persiapan Situs Siap Tayang</span>
            </CardTitle>
            <Badge
              variant={summary.allResolved ? "success" : "secondary"}
              className="tabular-nums"
              data-testid="guided-checklist-progress-badge"
            >
              {summary.completedCount} dari {summary.totalCount} selesai
            </Badge>
          </div>
          <CardDescription>
            Selesaikan 5 langkah inti berikut atau lewati langkah yang ingin dikerjakan nanti.
          </CardDescription>
        </div>

        {!readOnly && (
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 text-muted-foreground md:min-h-8"
              onClick={handleDismissAll}
              data-testid="guided-checklist-dismiss-all"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Sembunyikan</span>
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Progres kesiapan awal</span>
            <span className="font-semibold text-foreground tabular-nums">
              {summary.percentComplete}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={summary.percentComplete}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progres persiapan situs"
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${summary.percentComplete}%` }}
            />
          </div>
        </div>

        <ol className="divide-y divide-border rounded-md border border-border bg-card">
          {summary.steps.map((step) => {
            const isCompleted = step.status === "completed";
            const isDismissed = step.status === "dismissed";

            return (
              <li
                key={step.id}
                data-testid={`guided-step-${step.id}`}
                data-step-status={step.status}
                className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 shrink-0" aria-hidden="true">
                    {isCompleted ? (
                      <CheckCircle2Icon className="size-5 text-primary" />
                    ) : isDismissed ? (
                      <EyeOffIcon className="size-5 text-muted-foreground" />
                    ) : (
                      <CircleIcon className="size-5 text-muted-foreground" />
                    )}
                  </span>

                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          isCompleted
                            ? "text-sm font-semibold text-foreground line-through decoration-muted-foreground/60"
                            : isDismissed
                              ? "text-sm font-medium text-muted-foreground"
                              : "text-sm font-semibold text-foreground"
                        }
                      >
                        {step.order}. {step.label}
                      </span>
                      {isCompleted && <Badge variant="success">Selesai</Badge>}
                      {isDismissed && <Badge variant="outline">Dilewati</Badge>}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {step.description}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                  {!isCompleted && !isDismissed && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      render={<a href={step.actionHref} />}
                      data-testid={`guided-step-link-${step.id}`}
                    >
                      <span>{step.actionLabel}</span>
                      <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}

                  {!readOnly && !isCompleted && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      onClick={() => handleComplete(step.id)}
                      data-testid={`guided-step-complete-${step.id}`}
                    >
                      <CheckIcon className="size-3.5" aria-hidden="true" />
                      <span>Tandai selesai</span>
                    </Button>
                  )}

                  {!readOnly && step.status === "pending" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11 text-muted-foreground md:min-h-8"
                      onClick={() => handleDismissStep(step.id)}
                      data-testid={`guided-step-dismiss-${step.id}`}
                    >
                      <span>Lewati</span>
                    </Button>
                  )}

                  {!readOnly && (isDismissed || (isCompleted && !step.completedByFacts)) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11 text-muted-foreground md:min-h-8"
                      onClick={() => handleRestoreStep(step.id)}
                      data-testid={`guided-step-reset-${step.id}`}
                    >
                      <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                      <span>Buka lagi</span>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
