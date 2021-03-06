import { spawn } from 'child_process';
import * as events from 'events';
import * as fs from 'fs';
import * as mkdirp from 'mkdirp';
import * as path from 'path';
import Util from '../../../Util/Util';
import * as DBSchema from '../../DB/DBSchema';
import { EncodedDBInterface } from '../../DB/EncodedDB';
import Model from '../../Model';

interface ThumbnailRecordedProgram extends DBSchema.RecordedSchema {
    encodedId?: number;
}

interface ThumbnailManageModelInterface extends Model {
    addListener(callback: (id: number, thumbnailPath: string) => void): void;
    push(program: ThumbnailRecordedProgram): void;
}

/**
 * サムネイルを生成する
 */
class ThumbnailManageModel extends Model implements ThumbnailManageModelInterface {
    private encodedDB: EncodedDBInterface;
    private queue: ThumbnailRecordedProgram[] = [];
    private isRunning: boolean = false;
    private listener: events.EventEmitter = new events.EventEmitter();

    constructor(
        encodedDB: EncodedDBInterface,
    ) {
        super();

        this.encodedDB = encodedDB;
    }

    /**
     * サムネイル生成完了時に実行されるイベントに追加
     * @param callback ルール更新時に実行される
     */
    public addListener(callback: (id: number, thumbnailPath: string) => void): void {
        this.listener.on(ThumbnailManageModel.THUMBANIL_CREATE_EVENT, (id: number, thumbnailPath: string) => {
            try {
                callback(id, thumbnailPath);
            } catch (err) {
                this.log.system.error(<any> err);
            }
        });
    }

    /**
     * キューにプログラムを積む
     * @param program: ThumbnailRecordedProgram
     */
    public push(program: ThumbnailRecordedProgram): void {
        this.log.system.info(`push thumbnail: ${ program.id }`);

        // 同じ recorded id の program がないかチェックする
        for (const p of this.queue) {
            if (program.id === p.id) { return; }
        }

        this.queue.push(program);
        this.create();
    }

    /**
     * queue からプログラムを取り出してサムネイルを生成する
     */
    private async create(): Promise<void> {
        // 実行中なら return
        if (this.isRunning) { return; }
        this.isRunning = true; // ロック

        // プログラムが空なら終了
        const program = this.queue.shift();
        if (typeof program === 'undefined') {
            this.isRunning = false;

            return;
        }

        const config = this.config.getConfig();
        const thumbnailDir = Util.getThumbnailPath();
        const thumbnailPath = path.join(thumbnailDir, `${ program.id }.jpg`);
        const thumbnailSize = config.thumbnailSize || '480x270';
        const thumbnailPosition = config.thumbnailPosition || 5;
        const ffmpeg = Util.getFFmpegPath();

        // thumbnailDir の存在確認
        try {
            fs.statSync(thumbnailDir);
        } catch (err) {
            // ディレクトリが存在しなければ作成
            this.log.system.info(`mkdirp: ${ thumbnailDir }`);
            mkdirp.sync(thumbnailDir);
        }

        // ffmpeg の存在確認
        try {
            fs.statSync(ffmpeg);
        } catch (err) {
            this.log.system.error(`ffmpeg is not found: ${ ffmpeg }`);
            this.isRunning = false;

            return;
        }

        let filePath: string | null = null;
        if (typeof program.encodedId === 'undefined') {
            // ts file
            filePath = program.recPath;
        } else {
            // encoded file
            const encoded = await this.encodedDB.findId(program.encodedId);
            if (encoded !== null) {
                filePath = encoded.path;
            }
        }

        // filePath が null か
        if (filePath === null) {
            this.log.system.error(`thumbnail program path is null: ${ program.id }`);
            this.finalize();

            return;
        }

        // create thumbnail
        const cmd = (`-y -i %INPUT% -ss ${ thumbnailPosition } -vframes 1 -f image2 -s ${ thumbnailSize } ${ thumbnailPath }`).split(' ');
        for (let i = 0; i < cmd.length; i++) {
            cmd[i] = cmd[i].replace(/%INPUT%/, filePath);
        }

        const child = spawn(ffmpeg, cmd);

        // debug 用
        child.stderr.on('data', (data) => { this.log.system.debug(String(data)); });

        child.on('exit', (code) => {
            if (typeof program === 'undefined') {
                fs.unlink(thumbnailPath, (err) => {
                    this.log.system.error(`delete thumbnail, program is no found: ${ thumbnailPath }`);
                    if (err) {
                        this.log.system.error(`delete thumbnail failed: ${ thumbnailPath }`);
                        this.log.system.error(String(err));
                    }
                });
            } else {
                if (code !== 0) {
                    this.log.system.error(`create thumbnail failed: ${ program.id }`);
                } else {
                    this.log.system.info(`create thumbnail: ${ program.id }`);

                    // サムネイル生成完了を通知
                    this.eventsNotify(program.id, thumbnailPath);
                }
            }

            this.finalize();
        });

        child.on('error', (err) => {
            this.log.system.info('create thumbnail failed');
            this.log.system.info(String(err));
            this.finalize();
        });
    }

    /**
     * 終了時の必須処理
     */
    private finalize(): void {
        this.isRunning = false; // ロックを解除
        // queue の残りを処理する
        setTimeout(() => { this.create(); }, 0);
    }

    /**
     * サムネイル生成完了を通知
     * @param recordedId: recorded id
     * @param thumbnailPath: thumbnailPath
     */
    private eventsNotify(recordedId: number, thumbnailPath: string): void {
        this.listener.emit(ThumbnailManageModel.THUMBANIL_CREATE_EVENT, recordedId, thumbnailPath);
    }
}

namespace ThumbnailManageModel {
    export const THUMBANIL_CREATE_EVENT = 'createThumbnail';
}

export { ThumbnailRecordedProgram, ThumbnailManageModelInterface, ThumbnailManageModel };

