/**
 * node:sqlite 极薄适配层。
 * 刻意不引入 better-sqlite3 —— 本机无 MSVC，任何需要 node-gyp 的原生模块都装不上。
 * 若 Electron 运行时未提供 node:sqlite，openDatabase 会抛出可读错误，由上层降级。
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface StatementLike {
  all(...params: SqlValue[]): Record<string, unknown>[];
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  function(name: string, options: { deterministic: boolean }, fn: (...args: SqlValue[]) => SqlValue): void;
  close(): void;
}

export class SqliteUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `当前 Electron 运行时没有 node:sqlite（${cause instanceof Error ? cause.message : String(cause)}）。` +
        '需要 Electron 33+ 内置 Node 22.5+ 的运行时。',
    );
    this.name = 'SqliteUnavailableError';
  }
}

export function openDatabase(file: string): SqliteHandle {
  let mod: { DatabaseSync: new (path: string) => SqliteHandle };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('node:sqlite') as typeof mod;
  } catch (err) {
    throw new SqliteUnavailableError(err);
  }
  if (typeof mod?.DatabaseSync !== 'function') throw new SqliteUnavailableError('DatabaseSync 缺失');
  return new mod.DatabaseSync(file);
}
