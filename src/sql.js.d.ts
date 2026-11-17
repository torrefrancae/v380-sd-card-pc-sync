declare module "sql.js" {
  interface SqlDatabase {
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    close(): void;
  }
  interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlDatabase;
  }
  function initSqlJs(config?: { wasmBinary?: Uint8Array }): Promise<SqlJsStatic>;
  export default initSqlJs;
}
