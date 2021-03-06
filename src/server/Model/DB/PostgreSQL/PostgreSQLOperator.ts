import * as pg from 'pg';
import DBOperator from '../DBOperator';

/**
 * PostgreSQLOperator クラス
 */
class PostgreSQLOperator extends DBOperator {
    protected static pool: pg.Pool | null = null;

    constructor() {
        super();

        // bigInt を number で返すように変換する
        pg.types.setTypeParser(20, (val) => { return parseInt(val, 10); });
    }

    /**
     * get Pool
     * @return Pool
     */
    public getPool(): pg.Pool {
        if (PostgreSQLOperator.pool === null) {
            const config = this.config.getConfig().postgresql;
            if (typeof config.idleTimeoutMillis === 'undefined') { config.idleTimeoutMillis = 5000; }
            PostgreSQLOperator.pool = new pg.Pool(config);
        }

        return PostgreSQLOperator.pool;
    }

    /**
     * ping
     * @return Promise<void>
     */
    public async ping(): Promise<void> {
        await this.runQuery('select 1;');
    }

    /**
     * end
     * @return Promise<void>
     */
    public async end(): Promise<void> {
        const pool = this.getPool();
        const client = await pool.connect();

        return new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
            // dummy query
            // これがないと drain を取りこぼしてしまう
            client.query('select 1;', (err) => {
                if (err) { reject(err); }
            });

            client.on('drain', () => {
                client.release();
                pool.end();
                client.on('end', () => {
                    PostgreSQLOperator.pool = null;
                    resolve();
                });
            });
        });

    }

    /**
     * query を実行する
     * @param query
     * @return Promise<T>
     */
    public async runQuery<T>(query: string, values?: any): Promise<T> {
        const client = await this.getPool().connect();

        let result: pg.QueryResult;
        try {
            result = typeof values === 'undefined' ? await client.query(query) : await client.query(query, values);
            client.release();
        } catch (err) {
            client.release();
            throw err;
        }

        return <T> (<any> result.rows);
    }

    /**
     * insert with insertId
     * @param query
     * @param value
     * @return Promise<number> insertId
     */
    public async runInsert(query: string, values?: any): Promise<number> {
        const client = await this.getPool().connect();

        let result: pg.QueryResult;
        try {
            result = typeof values === 'undefined' ? await client.query(query) : await client.query(query, values);
            client.release();
        } catch (err) {
            client.release();
            throw err;
        }

        if (result.rows.length >= 1 && typeof result.rows[0].id !== 'undefined') {

            return <number> result.rows[0].id;
        } else {
            this.log.system.warn('insert id is not found.');

            return 0;
        }
    }

    /**
     * values 文字列を生成する
     * @param start: number
     * @param end: number
     */
    public createValueStr(start: number, end: number): string {
        let str = '';

        if (start > end) {
            throw new Error('createValueStr args error');
        }

        for (let i = start; i <= end; i++) {
            if (i === end) {
                str += `$${ i }`;
            } else {
                str += `$${ i }, `;
            }
        }

        return str;
    }

    /**
     * get upsert type
     * @return replace | conflict
     */
    public getUpsertType(): 'replace' | 'conflict' {
        return 'conflict';
    }

    /**
     * create limit and offset str
     * @param limit: number
     * @param offset: number
     */
    public createLimitStr(limit: number, offset?: number): string {
        if (typeof offset === 'undefined') {
            return `limit ${ limit}`;
        } else {
            return `limit ${ limit } offset ${ offset }`;
        }
    }

    /**
     * returning
     * @return string
     */
    public getReturningStr(): string {
        return 'returning id';
    }

    /**
     * トランザクション処理
     * @param callback: transaction で実行する処理
     * @return Promise<void>
     */
    public async runTransaction(
        callback: (
            exec: (query: string, values?: any) => Promise<void>,
        ) => Promise<void>,
    ): Promise<void> {
        return new Promise<void>(async(resolve: () => void, reject: (error: Error) => void) => {
            this.getPool().connect(async(cerror: Error, client: pg.PoolClient, done: () => void) => {
                if (cerror) {
                    this.log.system.error('connect error');
                    this.log.system.error(cerror.message);
                    reject(cerror);

                    return;
                }

                const failed = async(err: Error) => {
                    await client.query('rollback')
                    .catch ((e) => {
                        this.log.system.fatal('rollback error');
                        this.log.system.fatal(e);
                    });

                    done();
                    this.log.system.error(err.message);
                    reject(err);
                };

                // transaction 開始
                try {
                    await client.query('begin');
                } catch (err) {
                    this.log.system.error('transaction begin error');
                    await failed(err);

                    return;
                }

                // callback
                try {
                    await callback(async(query: string, values?: any) => {
                        await client.query(query, values);
                    });
                } catch (err) {
                    this.log.system.error('transaction callback error');
                    await failed(err);
                }

                // commit
                try {
                    await client.query('commit');
                } catch (err) {
                    this.log.system.error('transaction commit error');
                    await failed(err);

                    return;
                }

                done();
                resolve();
            });
        });
    }

    /**
     * テーブルが存在するか
     * @param table name
     * @return boolean
     */
    public async exists(tableName: string): Promise<boolean> {
        const result = <any[]> await this.runQuery(`select relname from pg_class where relkind = 'r' and relname ilike '${ tableName }';`);

        return result.length !== 0;
    }
}

export default PostgreSQLOperator;

