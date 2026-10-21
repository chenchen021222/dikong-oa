export declare function initDb(): Promise<void>

export declare function queryAll(sql: string, params?: unknown[]): Promise<unknown[]>

export declare function handle(
  dbPath: string,
  method: string,
  pathname: string,
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<{ code: number; data: unknown }>

export declare const DEFAULT_DB_PATH: string
