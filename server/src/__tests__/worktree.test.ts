import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock getDb for unit tests
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

vi.mock('../db/connection.js', () => ({
  getDb: () => mockDb,
}));

describe('needsWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for explore mode', async () => {
    const { needsWorktree } = await import('../claude/worktree.js');
    const result = needsWorktree('session-1', '/tmp/fake-project', 'explore');
    expect(result).toBe(false);
  });

  it('returns false for non-git directory', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wt-test-'));
    try {
      const { needsWorktree } = await import('../claude/worktree.js');
      const result = needsWorktree('session-1', tmpDir, 'execute');
      expect(result).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns false when no other active write sessions exist', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wt-test-'));
    try {
      execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });

      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({ id: 'proj-1' }),
        all: vi.fn().mockReturnValue([]), // no other sessions
        run: vi.fn(),
      });

      const { needsWorktree } = await import('../claude/worktree.js');
      const result = needsWorktree('session-1', tmpDir, 'execute');
      expect(result).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns true when another active write session exists', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wt-test-'));
    try {
      execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });

      let callCount = 0;
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({ id: 'proj-1' }),
        all: vi.fn().mockImplementation(() => {
          // First call is from the test query, returns one other active session
          return [{ id: 'session-2' }];
        }),
        run: vi.fn(),
      });

      const { needsWorktree } = await import('../claude/worktree.js');
      const result = needsWorktree('session-1', tmpDir, 'execute');
      expect(result).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('worktree lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wt-lifecycle-'));
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
    writeFileSync(join(tmpDir, 'file.txt'), 'hello');
    execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and removes a worktree', async () => {
    const { createWorktree, removeWorktree } = await import('../claude/worktree.js');
    const sessionId = 'aaaabbbb-cccc-dddd-eeee-ffffgggg1234';

    const worktreePath = createWorktree(sessionId, tmpDir);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, 'file.txt'))).toBe(true);

    // Verify .gitignore was updated
    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.worktrees');

    // Verify session branch exists
    const branches = execSync('git branch', { cwd: tmpDir, encoding: 'utf-8' });
    expect(branches).toContain('session/aaaabbbb');

    // Remove it
    removeWorktree(sessionId, tmpDir);
    expect(existsSync(worktreePath)).toBe(false);

    // Branch should be cleaned up
    const branchesAfter = execSync('git branch', { cwd: tmpDir, encoding: 'utf-8' });
    expect(branchesAfter).not.toContain('session/aaaabbbb');
  });

  it('creates worktree with isolated file changes', async () => {
    const { createWorktree, removeWorktree } = await import('../claude/worktree.js');
    const sessionId = 'iso-test-session-1234-5678';

    const worktreePath = createWorktree(sessionId, tmpDir);

    // Write a file in the worktree
    writeFileSync(join(worktreePath, 'new-file.txt'), 'from worktree');

    // Verify the file does NOT appear in the main checkout
    expect(existsSync(join(tmpDir, 'new-file.txt'))).toBe(false);

    // Clean up
    removeWorktree(sessionId, tmpDir);
  });
});

describe('getSessionWorkPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns project path when no worktree exists', async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ worktree_path: null }),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    });

    const { getSessionWorkPath } = await import('../claude/worktree.js');
    const result = getSessionWorkPath('session-1', '/projects/myproject');
    expect(result).toBe('/projects/myproject');
  });

  it('returns worktree path when session has one and it exists', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wt-path-'));
    try {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({ worktree_path: tmpDir }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      });

      const { getSessionWorkPath } = await import('../claude/worktree.js');
      const result = getSessionWorkPath('session-1', '/projects/myproject');
      expect(result).toBe(tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
