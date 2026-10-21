import type { DatabaseSync } from 'node:sqlite'

export declare function openDb(dbPath: string): DatabaseSync

export declare function handle(
  dbPath: string,
  method: string,
  pathname: string,
  body: Record<string, unknown>,
  query: URLSearchParams,
): { code: number; data: unknown }

export declare const DEFAULT_DB_PATH: string
