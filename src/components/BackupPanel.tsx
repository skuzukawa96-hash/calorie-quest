import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BackupInfo, BackupList } from "../types";
import { DeleteButton } from "./IconButtons";

/** 2026-10-12T15:30:00 → 2026/10/12 15:30 */
function when(at: string): string {
  return `${at.slice(0, 10).replace(/-/g, "/")} ${at.slice(11, 16)}`;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 💾 バックアップ (記録): the whole record saved into a file of Documents\CalorieQuest\backups, and
 * put back from one of them, asked first. Putting one back keeps what is there in a backup of its
 * own first, then reloads the app on the record brought back. × deletes one, asked first. The
 * newest shows; the others are folded under a line that opens them.
 */
export default function BackupPanel({ toast }: { toast: (msg: string) => void }) {
  const [list, setList] = useState<BackupList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** the backup whose この時点に戻す or × waits for a yes */
  const [asking, setAsking] = useState<{ name: string; to: "restore" | "delete" } | null>(null);
  /** the backups before the newest, folded at first */
  const [all, setAll] = useState(false);

  const load = useCallback(() => {
    api
      .listBackups()
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const b = await api.createBackup();
      toast(`💾 バックアップを保存しました（${when(b.madeAt)}）`);
      load();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (b: BackupInfo) => {
    setBusy(true);
    try {
      await api.restoreBackup(b.name);
      toast(`💾 ${when(b.madeAt)} の時点に戻しました。読み込み直します…`);
      // Every screen starts again on the record brought back.
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      toast(String(e));
      setBusy(false);
      setAsking(null);
      load();
    }
  };

  const remove = async (b: BackupInfo) => {
    setBusy(true);
    try {
      await api.deleteBackup(b.name);
      toast(`🗑 ${when(b.madeAt)} のバックアップを削除しました`);
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
      setAsking(null);
      load();
    }
  };

  const backups = list?.backups ?? [];
  const older = backups.length - 1;
  const row = (b: BackupInfo) => (
    <li key={b.name}>
      <span className="backup-when">{when(b.madeAt)}</span>
      {b.beforeRestore && (
        <span className="pill backup-auto" title="「この時点に戻す」の直前に、そのときのデータを自動で保存したもの">
          戻す前の自動保存
        </span>
      )}
      <span className="muted small">{size(b.bytes)}</span>
      {asking?.name === b.name ? (
        <span className="backup-ask">
          {asking.to === "restore" ? (
            <>
              <span>この時点のデータに戻しますか？（今のデータは、戻す前に自動でバックアップします）</span>
              <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void restore(b)}>
                戻す
              </button>
            </>
          ) : (
            <>
              <span>このバックアップを削除しますか？（元に戻せません）</span>
              <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove(b)}>
                削除する
              </button>
            </>
          )}
          <button className="btn-link" disabled={busy} onClick={() => setAsking(null)}>
            やめる
          </button>
        </span>
      ) : (
        <span className="backup-row-actions">
          <button className="btn btn-small" disabled={busy} onClick={() => setAsking({ name: b.name, to: "restore" })}>
            この時点に戻す
          </button>
          <DeleteButton
            label="このバックアップを削除"
            disabled={busy}
            onClick={() => setAsking({ name: b.name, to: "delete" })}
          />
        </span>
      )}
    </li>
  );

  return (
    <section className="card backup">
      <h2>💾 バックアップ</h2>
      <p className="muted small">
        学習履歴・カロリー・レシピ・お菓子図鑑・お気に入り・試験など、すべてのデータを1つのファイルに保存します。PCの故障や入れ直しに備えて、ときどき保存しておくと安心です（保存したファイルを USB メモリなどに写しておけば、別のPCでも戻せます）。
      </p>
      {error ? (
        <p className="muted">{error}</p>
      ) : (
        <>
          <div className="row backup-actions">
            <button className="btn btn-primary" disabled={busy || !list} onClick={() => void save()}>
              💾 今のデータをバックアップ
            </button>
            {list && (
              <button className="btn-link" onClick={() => void api.openBackupFolder().catch((e) => toast(String(e)))}>
                保存先のフォルダを開く
              </button>
            )}
          </div>
          {list && <div className="muted small backup-folder">保存先: {list.folder}</div>}
          {list && backups.length === 0 && <p className="muted">まだバックアップはありません。</p>}
          {backups.length > 0 && <ul className="backup-list">{row(backups[0])}</ul>}
          {older > 0 && (
            <>
              <button className="backup-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>
                <span className="backup-more-caret" aria-hidden="true">
                  {all ? "▾" : "▸"}
                </span>
                それより前のバックアップ（{older}件）
              </button>
              {all && <ul className="backup-list backup-older">{backups.slice(1).map(row)}</ul>}
            </>
          )}
        </>
      )}
    </section>
  );
}
