/**
 * LS-1: blackhole の受け口（K3/3 `nir1-d2a-activation-proposal/3`。NC-1 の lane）。
 *
 * Main が持つ `127.0.0.1` の ephemeral port の TCP listener。default session の
 * proxy（SOCKS5）の宛先で、受けた bytes は読み出して捨て（`resume()` だけ。検査、
 * 保存、log、書込みに渡さない）、返事をしない。有限にする（K1b の共通の規則）:
 * 同時の接続数は 256 以下、1 接続の保持は 5 秒以下、上限を超える接続は受けた直後に
 * 切断する（待ち行列を持たない）。
 *
 * - accept した socket の `error`（ECONNRESET など。Chromium は TURN／SOCKS の job の
 *   取消しや `pc.close()` で接続を即座に落とすので RST は通常の動作）は握りつぶして
 *   `destroy` する。handler がないと Node で未処理例外になる。
 * - server の `error`（EMFILE などの一時的な accept の失敗を含む）も握りつぶして継続する。
 *   listen の完了前の `error` だけは start の失敗として reject する（FC-1 の `NC-LISTEN`）。
 * - listener は製品のコードから明示的に閉じない。process の終了で OS に閉じさせる
 *   （`before-quit` から終了までの間に port が空く窓を作らない）。実際に閉じたことは
 *   `onClosed` で呼出し側に知らせる（通常の終了と消失の区別は呼出し側）。再 bind はしない。
 * - 二度目の start は拒否する（listen の失敗後の再試行もしない）。
 *
 * この file は `node:net` だけに依存し、electron に依存しない。
 */
import net from "node:net";

/** LS-1 の上界: 同時の接続数。確認済みの上限で、緩めるには新しい draftRef が要る。 */
export const LS1_MAX_CONCURRENT_CONNECTIONS = 256;

/** LS-1 の上界: 1 接続の保持（ms）。確認済みの上限で、緩めるには新しい draftRef が要る。 */
export const LS1_MAX_HOLD_MS = 5000;

const LISTEN_HOST = "127.0.0.1";

export interface BlackholeListenerOptions {
  /** 同時の接続数。確認済みの上限（256）を超える値は上限に丸める。試験が小さい値を使うための引数。 */
  maxConnections?: number;
  /** 1 接続の保持（ms）。確認済みの上限（5000）を超える値は上限に丸める。同上。 */
  holdMs?: number;
  /** server が閉じたときに 1 度呼ばれる。 */
  onClosed?: () => void;
}

export interface BlackholeListener {
  /** `127.0.0.1` の ephemeral port。 */
  readonly port: number;
  /** 試験が listener の状態を観測・操作するための server。製品のコードは閉じない。 */
  readonly server: net.Server;
  /** 保持している接続の数。 */
  activeConnections(): number;
}

let startedOnce = false;

function clampToCeiling(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return ceiling;
  }
  return Math.min(Math.floor(value), ceiling);
}

/** listener を 1 度だけ起動する。失敗したら reject（FC-1 の `NC-LISTEN`）。 */
export function startBlackholeListener(
  options: BlackholeListenerOptions = {},
): Promise<BlackholeListener> {
  if (startedOnce) {
    return Promise.reject(new Error("blackhole listener already started"));
  }
  startedOnce = true;

  const maxConnections = clampToCeiling(
    options.maxConnections,
    LS1_MAX_CONCURRENT_CONNECTIONS,
  );
  const holdMs = clampToCeiling(options.holdMs, LS1_MAX_HOLD_MS);
  const onClosed = options.onClosed;
  const active = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    // error handler を最初に付ける（ECONNRESET などで未処理例外にしない）。
    socket.on("error", () => {
      socket.destroy();
    });
    try {
      if (active.size >= maxConnections) {
        socket.destroy();
        return;
      }
      active.add(socket);
      const hold = setTimeout(() => {
        socket.destroy();
      }, holdMs);
      hold.unref();
      socket.once("close", () => {
        clearTimeout(hold);
        active.delete(socket);
      });
      // 受けた bytes は読み出して捨てる。data の listener は付けない（どこにも渡さない）。
      socket.resume();
    } catch {
      socket.destroy();
    }
  });

  if (onClosed !== undefined) {
    server.on("close", () => {
      onClosed();
    });
  }

  return new Promise<BlackholeListener>((resolve, reject) => {
    let listening = false;
    server.on("error", (error: Error) => {
      // listen の完了前は start の失敗。完了後は握りつぶして継続する。
      if (!listening) reject(error);
    });
    server.listen({ host: LISTEN_HOST, port: 0 }, () => {
      listening = true;
      const address = server.address();
      if (address === null || typeof address === "string") {
        // 起こらない。起動前の失敗として扱い、process は終了する（明示的に閉じない）。
        reject(new Error("blackhole listener has no port"));
        return;
      }
      server.unref();
      resolve({
        port: address.port,
        server,
        activeConnections: () => active.size,
      });
    });
  });
}
