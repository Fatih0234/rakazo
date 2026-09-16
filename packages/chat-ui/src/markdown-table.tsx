import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CopyIcon } from "./icons";
import type { ExtractedTable, HastNode, TableAlign, TableSortDirection } from "./table-utils";
import {
  columnMinWidths,
  extractTable,
  isNumericColumn,
  nextSort,
  sortRows,
  TABLE_PAGE_SIZE,
  tableToCsv,
  tableToTsv,
} from "./table-utils";

/**
 * Renders a GFM markdown table as an interactive data card. Extraction is
 * lossy on purpose — inline markup inside cells flattens to text — and a
 * table that yields no columns falls back to the default <table>.
 */
export const MarkdownTable = memo(function MarkdownTable({
  node,
  tableProps,
  children,
}: {
  node?: HastNode;
  tableProps?: ComponentPropsWithoutRef<"table">;
  children?: ReactNode;
}) {
  const extracted = useMemo(() => extractTable(node), [node]);
  if (!extracted) return <table {...tableProps}>{children}</table>;
  return <TableCard table={extracted} />;
});

type SortState = { column: number; direction: TableSortDirection } | null;

export const TableCard = memo(function TableCard({ table }: { table: ExtractedTable }) {
  const { columns, aligns, rows } = table;
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const numericColumns = useMemo(() => {
    const numeric = new Set<number>();
    columns.forEach((_, i) => {
      if (isNumericColumn(rows, i)) numeric.add(i);
    });
    return numeric;
  }, [columns, rows]);

  const minWidths = useMemo(() => columnMinWidths(columns, rows), [columns, rows]);
  const sortedRows = useMemo(
    () => (sort ? sortRows(rows, sort.column, sort.direction) : rows),
    [rows, sort],
  );

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / TABLE_PAGE_SIZE));
  const showPagination = sortedRows.length > TABLE_PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = showPagination
    ? sortedRows.slice(safePage * TABLE_PAGE_SIZE, (safePage + 1) * TABLE_PAGE_SIZE)
    : sortedRows;

  // Data and sort changes only clamp the page; an explicit sort click resets
  // to page 0 in the handler so the two coalesce into one commit.
  useEffect(() => setPage((p) => Math.min(p, pageCount - 1)), [pageCount]);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  useEffect(() => {
    if (!expanded) return;
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        // This overlay can render inside a Base UI dialog (artifact preview,
        // peer messages); stop propagation so one Escape doesn't close both.
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables.item(0);
      const last = focusables.item(focusables.length - 1);
      if (!first) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previousOverflow;
      expandButtonRef.current?.focus();
    };
  }, [expanded]);

  const toggleSort = (column: number) => {
    setSort((current) => nextSort(current, column));
    setPage(0);
  };

  const copyRows = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(tableToTsv(columns, sortedRows))
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const downloadCsv = () => {
    // BOM so spreadsheet apps decode UTF-8 correctly.
    const blob = new Blob([`\uFEFF${tableToCsv(columns, sortedRows)}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "table.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const tableView = (
    <TableView
      columns={columns}
      aligns={aligns}
      rows={pageRows}
      rowOffset={safePage * TABLE_PAGE_SIZE}
      numericColumns={numericColumns}
      minWidths={minWidths}
      sort={sort}
      onToggleSort={toggleSort}
    />
  );

  const pager = showPagination ? (
    <div className="rk-table-footer">
      <span className="rk-table-range">
        {safePage * TABLE_PAGE_SIZE + 1}–
        {Math.min((safePage + 1) * TABLE_PAGE_SIZE, sortedRows.length)} of {sortedRows.length} rows
      </span>
      <button
        type="button"
        className="rk-table-tool"
        aria-label="Previous page"
        disabled={safePage === 0}
        onClick={() => setPage(safePage - 1)}
      >
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        className="rk-table-tool"
        aria-label="Next page"
        disabled={safePage >= pageCount - 1}
        onClick={() => setPage(safePage + 1)}
      >
        <ChevronRightIcon />
      </button>
    </div>
  ) : (
    <div className="rk-table-footer">
      <span className="rk-table-range">
        {sortedRows.length} {sortedRows.length === 1 ? "row" : "rows"}
      </span>
    </div>
  );

  const tools = (mode: "card" | "dialog") => (
    <div className="rk-table-head">
      <button
        type="button"
        className="rk-table-tool"
        onClick={copyRows}
        aria-label={copied ? "Copied" : "Copy rows"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button
        type="button"
        className="rk-table-tool"
        onClick={downloadCsv}
        aria-label="Download CSV"
      >
        <DownloadIcon />
      </button>
      {mode === "card" ? (
        <button
          type="button"
          className="rk-table-tool"
          ref={expandButtonRef}
          onClick={() => setExpanded(true)}
          aria-label="Expand table"
        >
          <ExpandIcon />
        </button>
      ) : (
        <button
          type="button"
          className="rk-table-tool"
          onClick={() => setExpanded(false)}
          aria-label="Close table"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );

  return (
    <div className="rk-table-card rk-table-box" data-testid="table-card" inert={expanded}>
      {tools("card")}
      <div className="rk-table-scroll">{tableView}</div>
      {pager}
      {expanded
        ? createPortal(
            // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Escape and the Close button cover keyboard dismissal; the backdrop click is a pointer convenience.
            <div
              className="rk-table-overlay"
              onClick={(event) => {
                if (event.target === event.currentTarget) setExpanded(false);
              }}
            >
              <div
                className="rk-table-dialog rk-table-box"
                role="dialog"
                aria-modal="true"
                aria-label="Table"
                ref={dialogRef}
                tabIndex={-1}
              >
                {tools("dialog")}
                <div className="rk-table-scroll rk-table-dialog-scroll">{tableView}</div>
                {pager}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});

function TableView({
  columns,
  aligns,
  rows,
  rowOffset,
  numericColumns,
  minWidths,
  sort,
  onToggleSort,
}: {
  columns: string[];
  aligns: TableAlign[];
  rows: string[][];
  rowOffset: number;
  numericColumns: Set<number>;
  minWidths: Record<number, string>;
  sort: SortState;
  onToggleSort: (column: number) => void;
}) {
  // Numeric columns right-align unless the author declared an alignment.
  const alignClass = (index: number) => {
    const align = numericColumns.has(index) && aligns[index] === "left" ? "right" : aligns[index];
    return align && align !== "left" ? `rk-align-${align}` : undefined;
  };
  return (
    <table className="rk-table">
      <thead>
        <tr>
          <th className="rk-table-gutter" />
          {columns.map((column, i) => {
            const direction = sort?.column === i ? sort.direction : null;
            return (
              <th
                key={i}
                aria-sort={
                  direction ? (direction === "asc" ? "ascending" : "descending") : undefined
                }
                className={alignClass(i)}
              >
                <button
                  type="button"
                  className="rk-table-sort"
                  onClick={() => onToggleSort(i)}
                  aria-label={`Sort by ${column}`}
                >
                  <span className="rk-table-sort-label">{column}</span>
                  <SortIndicator direction={direction} />
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length + 1} className="rk-table-empty">
              No rows
            </td>
          </tr>
        ) : (
          rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="rk-table-gutter">{rowOffset + rowIndex + 1}</td>
              {columns.map((_, columnIndex) => {
                const value = row[columnIndex] ?? "";
                return (
                  <td
                    key={columnIndex}
                    style={{ minWidth: minWidths[columnIndex] }}
                    className={alignClass(columnIndex)}
                  >
                    <span className="rk-table-cell-text" title={value || undefined}>
                      {value}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function SortIndicator({ direction }: { direction: TableSortDirection | null }) {
  return (
    <span className="rk-table-sort-icon" aria-hidden="true">
      <ChevronUpIcon active={direction === "asc"} />
      <ChevronDownIcon active={direction === "desc"} />
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4v11m0 0 4-4m-4 4-4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 0 2 2h-3M3 16v3a2 2 0 0 0 2 2h3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronUpIcon({ active = false }: { active?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={active ? "rk-sort-on" : "rk-sort-off"}
    >
      <path
        d="m6 15 6-6 6 6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon({ active = false }: { active?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={active ? "rk-sort-on" : "rk-sort-off"}
    >
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m14 7-5 5 5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m10 7 5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
