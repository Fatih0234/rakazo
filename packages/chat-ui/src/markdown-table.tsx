import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExtractedTable, HastNode, TableAlign, TableSortDirection } from "./table-utils.js";
import {
  columnMinWidths,
  extractTable,
  isNumericColumn,
  nextSort,
  sortRows,
  TABLE_PAGE_SIZE,
  tableToCsv,
  tableToTsv,
} from "./table-utils.js";

/**
 * Renders a GFM markdown table as an interactive data card. Extraction is
 * lossy on purpose — inline markup inside cells flattens to text — and a
 * table that yields no columns falls back to the default <table>.
 */
export function MarkdownTable({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const extracted = useMemo(() => extractTable(node), [node]);
  if (!extracted) return <table>{children}</table>;
  return <TableCard table={extracted} />;
}

type SortState = { column: number; direction: TableSortDirection } | null;

export function TableCard({ table }: { table: ExtractedTable }) {
  const { columns, aligns, rows } = table;
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

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

  useEffect(() => setPage(0), [rows, sort]);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const toggleSort = (column: number) => setSort((current) => nextSort(current, column));

  const copyRows = () => {
    navigator.clipboard
      .writeText(tableToTsv(columns, rows))
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const downloadCsv = () => {
    const blob = new Blob([tableToCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
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
        title="Previous page"
        disabled={safePage === 0}
        onClick={() => setPage(safePage - 1)}
      >
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        className="rk-table-tool"
        aria-label="Next page"
        title="Next page"
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
        title="Copy rows"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button
        type="button"
        className="rk-table-tool"
        onClick={downloadCsv}
        aria-label="Download CSV"
        title="Download CSV"
      >
        <DownloadIcon />
      </button>
      {mode === "card" ? (
        <button
          type="button"
          className="rk-table-tool"
          onClick={() => setExpanded(true)}
          aria-label="Expand table"
          title="Expand table"
        >
          <ExpandIcon />
        </button>
      ) : (
        <button
          type="button"
          className="rk-table-tool"
          onClick={() => setExpanded(false)}
          aria-label="Close table"
          title="Close table"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );

  return (
    <div className="rk-table-card" data-testid="table-card">
      {tools("card")}
      <div className="rk-table-scroll">{tableView}</div>
      {pager}
      {expanded
        ? createPortal(
            <div className="rk-table-overlay">
              <div className="rk-table-dialog" role="dialog" aria-modal="true" aria-label="Table">
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
}

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
  const alignClass = (index: number) => {
    const align = numericColumns.has(index) ? "right" : aligns[index];
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
                aria-sort={direction ? (direction === "asc" ? "ascending" : "descending") : "none"}
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
              {columns.map((_, columnIndex) => (
                <td
                  key={columnIndex}
                  style={{ minWidth: minWidths[columnIndex] }}
                  className={alignClass(columnIndex)}
                >
                  {row[columnIndex] ?? ""}
                </td>
              ))}
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

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="9"
        y="9"
        width="12"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12.5 9.5 18 20 6"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
        d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"
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
