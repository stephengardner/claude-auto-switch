import { describe, it, expect } from 'vitest';
import { renderTable } from './table.js';

describe('renderTable', () => {
  it('includes a header and aligns rows', () => {
    const out = renderTable(
      [
        { name: 'alpha', plan: 'max' },
        { name: 'b', plan: 'free' },
      ],
      [
        { key: 'name', header: 'ACCOUNT' },
        { key: 'plan', header: 'PLAN' },
      ],
    );
    const lines = out.split('\n');
    expect(lines[0]).toContain('ACCOUNT');
    expect(lines[0]).toContain('PLAN');
    expect(lines[1]).toContain('alpha');
    expect(lines[2]).toContain('free');
  });

  it('handles missing cells and no rows', () => {
    const out = renderTable([], [{ key: 'name', header: 'ACCOUNT' }]);
    expect(out).toBe('ACCOUNT');
  });
});
