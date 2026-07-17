import { describe, expect, it, vi } from 'vitest';

vi.mock('@raycast/api', () => ({
  getPreferenceValues: vi.fn(() => ({})),
}));
vi.mock('@raycast/utils', () => ({
  executeSQL: vi.fn(),
}));

import {
  escapeSqlLiteral,
  interactiveWhere,
  normalizeTimestamp,
  projectsQuery,
  searchAllThreadsQuery,
  threadTitle,
  threadsQuery,
} from '../src/lib/threads';

describe('thread query builders', () => {
  it('keeps automation and archived rows out of the interactive query', () => {
    const query = threadsQuery('Interactive');

    expect(query).toContain('archived = 0');
    expect(query).toContain("COALESCE(thread_source, '') != 'subagent'");
    expect(query).toContain("COALESCE(source, '') != 'exec'");
    expect(query).toContain("source NOT LIKE '{%'");
    expect(query).toMatch(/ORDER BY updated_at DESC\s+LIMIT 5000/);
    expect(query.indexOf('WHERE')).toBeLessThan(query.indexOf('ORDER BY'));
  });

  it('shares the corrected interactive filter constant', () => {
    expect(threadsQuery('Interactive')).toContain(interactiveWhere);
  });

  it.each([
    ['All', '1 = 1'],
    ['Archived', 'archived = 1'],
  ] as const)('builds the %s mode without interactive-only clauses', (mode, modeClause) => {
    const query = threadsQuery(mode);

    expect(query).toContain(modeClause);
    expect(query).not.toContain("COALESCE(thread_source, '') != 'subagent'");
    expect(query).not.toContain("COALESCE(source, '') != 'exec'");
    expect(query).toMatch(/ORDER BY updated_at DESC\s+LIMIT 5000/);
  });

  it('searches every user-visible thread field and applies the requested limit', () => {
    const query = searchAllThreadsQuery('日本語', 'Interactive', 37);

    for (const column of ['title', 'first_user_message', 'preview', 'cwd', 'git_branch', 'id']) {
      expect(query).toContain(`${column} LIKE '%日本語%'`);
    }
    expect(query).toContain(interactiveWhere);
    expect(query).toMatch(/ORDER BY updated_at DESC\s+LIMIT 37/);
  });

  it('does not add interactive filters to All mode searches', () => {
    const query = searchAllThreadsQuery('needle', 'All');

    expect(query).toContain('WHERE 1 = 1');
    expect(query).not.toContain("COALESCE(thread_source, '') != 'subagent'");
    expect(query).not.toContain("COALESCE(source, '') != 'exec'");
    expect(query).not.toContain("source NOT LIKE '{%'");
  });

  it('restricts Archived mode searches to archived rows', () => {
    const query = searchAllThreadsQuery('needle', 'Archived');

    expect(query).toContain('WHERE archived = 1');
    expect(query).not.toContain("COALESCE(thread_source, '') != 'subagent'");
  });

  it('escapes apostrophes in search terms without losing Japanese text', () => {
    const query = searchAllThreadsQuery("O'Brien の作業", 'All');

    expect(query).toContain("title LIKE '%O''Brien の作業%'");
    expect(query).not.toContain("%O'Brien の作業%");
  });

  it('excludes automation before grouping projects', () => {
    const query = projectsQuery();
    const whereEnd = query.indexOf('GROUP BY');

    expect(query).toContain("COALESCE(thread_source, '') != 'subagent'");
    expect(query).toContain("COALESCE(source, '') != 'exec'");
    expect(query).toContain("source NOT LIKE '{%'");
    expect(query).toContain('GROUP BY cwd');
    expect(query).toMatch(/ORDER BY last_used DESC\s+LIMIT 500/);
    for (const clause of [
      "COALESCE(thread_source, '') != 'subagent'",
      "COALESCE(source, '') != 'exec'",
      "source NOT LIKE '{%'",
    ]) {
      expect(query.indexOf(clause)).toBeLessThan(whereEnd);
    }
  });

  it('doubles single quotes for SQL literals', () => {
    expect(escapeSqlLiteral("日本語 'quoted' text")).toBe("日本語 ''quoted'' text");
  });
});

describe('thread title precedence', () => {
  const base = { id: 'thread-id', title: '', first_user_message: '', preview: '' };

  it('uses a nonempty trimmed title first', () => {
    expect(threadTitle({ ...base, title: '  手動タイトル  ', first_user_message: 'message', preview: 'preview' })).toBe(
      '手動タイトル',
    );
  });

  it('falls through an empty-string title to the first user message', () => {
    expect(threadTitle({ ...base, title: '', first_user_message: '  ユーザーの依頼  ', preview: 'preview' })).toBe(
      'ユーザーの依頼',
    );
  });

  it('falls through whitespace-only titles', () => {
    expect(threadTitle({ ...base, title: ' \n\t ', first_user_message: 'first message' })).toBe('first message');
  });

  it('truncates a first user message to approximately 80 characters', () => {
    const message = 'あ'.repeat(100);
    expect(threadTitle({ ...base, first_user_message: message })).toBe('あ'.repeat(80));
  });

  it('uses preview and then id when earlier candidates are empty', () => {
    expect(threadTitle({ ...base, preview: '  preview text  ' })).toBe('preview text');
    expect(threadTitle(base)).toBe('thread-id');
  });
});

describe('timestamp normalization', () => {
  it('converts Unix seconds to milliseconds', () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('leaves millisecond timestamps unchanged', () => {
    expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('accepts numeric strings containing Unix seconds', () => {
    expect(normalizeTimestamp('1700000000')).toBe(1_700_000_000_000);
  });
});
