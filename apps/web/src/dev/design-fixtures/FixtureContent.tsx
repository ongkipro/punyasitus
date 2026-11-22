import * as React from "react";
import { PlusIcon, SearchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyStatePanel,
  ErrorStatePanel,
  LoadingStatePanel,
  PermissionDeniedPanel,
  StaleConflictBanner,
} from "@/components/admin/StatePanels";
import type { FixtureState, SurfaceFixtureData } from "./data";

export interface FixtureContentProps {
  data: SurfaceFixtureData;
  state: FixtureState;
}

export function FixtureContent({ data, state }: FixtureContentProps) {
  const [query, setQuery] = React.useState("");

  const filteredRows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter(
      (r) =>
        r.primary.toLowerCase().includes(q) ||
        r.secondary.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.statusLabel.toLowerCase().includes(q),
    );
  }, [data.rows, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            {data.pageTitle}
          </h1>
          <p className="text-sm text-muted-foreground">{data.pageSubtitle}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            className="min-h-11 md:min-h-9"
            data-testid="primary-cta"
          >
            {(data.primaryActionLabel.startsWith("Tambah") ||
              data.primaryActionLabel.startsWith("Buat")) && (
              <PlusIcon className="size-4" aria-hidden="true" />
            )}
            <span>{data.primaryActionLabel}</span>
          </Button>
        </div>
      </div>

      {state === "conflict" && <StaleConflictBanner />}

      {state === "loading" && <LoadingStatePanel />}

      {state === "empty-first-run" && <EmptyStatePanel variant="first-run" />}

      {state === "empty-filtered" && <EmptyStatePanel variant="filtered" />}

      {state === "error" && <ErrorStatePanel />}

      {state === "permission-denied" && <PermissionDeniedPanel />}

      {(state === "ready" || state === "conflict") && (
        <>
          <section aria-label="Ringkasan metrik" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {data.kpis.map((kpi) => (
              <Card key={kpi.label} size="sm">
                <CardHeader>
                  <CardDescription className="text-xs font-medium text-muted-foreground">
                    {kpi.label}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-1">
                  <p className="text-2xl font-bold tracking-[-0.02em] text-foreground tabular-nums">
                    {kpi.value}
                  </p>
                  <p className="text-xs text-muted-foreground">{kpi.note}</p>
                </CardContent>
              </Card>
            ))}
          </section>

          <Card>
            <CardHeader className="border-b border-border">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <CardTitle>{data.tableTitle}</CardTitle>
                  <CardDescription>{data.tableDescription}</CardDescription>
                </div>
                <div className="relative w-full sm:w-64">
                  <SearchIcon
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <label htmlFor="fixture-search" className="sr-only">
                    {data.searchPlaceholder}
                  </label>
                  <Input
                    id="fixture-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={data.searchPlaceholder}
                    className="pl-9"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {filteredRows.length === 0 ? (
                <div className="p-4">
                  <EmptyStatePanel
                    variant="filtered"
                    actionLabel="Hapus pencarian"
                    actionHref="#reset"
                  />
                </div>
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden md:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{data.columns[0]}</TableHead>
                          <TableHead>{data.columns[1]}</TableHead>
                          <TableHead>{data.columns[2]}</TableHead>
                          <TableHead className="text-right">{data.columns[3]}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredRows.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>
                              <div className="font-medium text-foreground">{row.primary}</div>
                              <div className="font-mono text-xs text-muted-foreground">
                                {row.secondary}
                              </div>
                            </TableCell>
                            <TableCell>{row.category}</TableCell>
                            <TableCell>
                              <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground tabular-nums">
                              {row.meta}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile stacked list (zero horizontal table overflow) */}
                  <ul className="divide-y divide-border md:hidden">
                    {filteredRows.map((row) => (
                      <li key={row.id} className="space-y-1.5 px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {row.primary}
                            </p>
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {row.secondary}
                            </p>
                          </div>
                          <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="truncate">{row.category}</span>
                          <span className="shrink-0 tabular-nums">{row.meta}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
