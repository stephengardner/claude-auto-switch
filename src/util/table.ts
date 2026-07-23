export interface Column {
  key: string;
  header: string;
}

/** Render rows as a simple left-aligned, space-padded text table with a header. */
export function renderTable(rows: Array<Record<string, string>>, columns: Column[]): string {
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => (r[c.key] ?? '').length), 0),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  const header = line(columns.map((c) => c.header));
  const body = rows.map((r) => line(columns.map((c) => r[c.key] ?? '')));
  return [header, ...body].join('\n');
}
