import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { playCrunch } from "../lib/sfx";
import type { ConsumptionEntry, Dashboard, Snack } from "../types";

interface Props {
  dash: Dashboard;
  onChanged: () => void;
  toast: (msg: string) => void;
}

const ICONS = ["🍪", "🍫", "🍰", "🍦", "🍩", "🍮", "🍡", "🍘", "🍬", "🍭", "🧁", "🥐", "🍞", "🍓", "🍎", "🥨", "🍿", "🧃", "☕", "🍵"];

type SortKey = "calories" | "added" | "name" | "icon" | "eaten";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Each order starts in the direction people usually want it, and flips on a second click. */
const SORTS: Array<{ key: SortKey; label: string; first: SortDir; dirs: Record<SortDir, string> }> = [
  { key: "calories", label: "カロリー", first: "asc", dirs: { asc: "低い順", desc: "高い順" } },
  { key: "added", label: "追加", first: "desc", dirs: { desc: "新しい順", asc: "古い順" } },
  { key: "name", label: "名前", first: "asc", dirs: { asc: "あ→ん", desc: "ん→あ" } },
  { key: "icon", label: "アイコン", first: "asc", dirs: { asc: "種類ごと", desc: "種類ごと（逆）" } },
  { key: "eaten", label: "よく食べる", first: "desc", dirs: { desc: "多い順", asc: "少ない順" } },
];
const SORT_STORAGE = "cq-snack-sort";
const DEFAULT_SORT: SortState = { key: "calories", dir: "asc" };

function loadSort(): SortState {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_STORAGE) ?? "null") as SortState | null;
    if (v && SORTS.some((s) => s.key === v.key) && (v.dir === "asc" || v.dir === "desc")) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_SORT;
}

function saveSort(sort: SortState) {
  try {
    localStorage.setItem(SORT_STORAGE, JSON.stringify(sort));
  } catch {
    /* ignore */
  }
}

const collator = new Intl.Collator("ja");

/** Icons in the order of the picker, so "アイコン順" groups them the way they are offered. */
function iconRank(icon: string): number {
  const i = ICONS.indexOf(icon);
  return i < 0 ? ICONS.length : i;
}

function compare(key: SortKey, a: Snack, b: Snack): number {
  switch (key) {
    case "calories":
      return a.calories - b.calories;
    case "added":
      // Ids grow as snacks are added; the built-in ones come first.
      return a.id - b.id;
    case "name":
      return collator.compare(a.name, b.name);
    case "icon":
      return iconRank(a.icon) - iconRank(b.icon) || a.icon.localeCompare(b.icon);
    case "eaten":
      return a.eatenCount - b.eatenCount;
  }
}

/** Ties fall back to calories and then the order added, always ascending, so rows stay put. */
function sortSnacks(snacks: Snack[], { key, dir }: SortState): Snack[] {
  const sign = dir === "asc" ? 1 : -1;
  return snacks.slice().sort((a, b) => sign * compare(key, a, b) || a.calories - b.calories || a.id - b.id);
}

export default function Snacks({ dash, onChanged, toast }: Props) {
  const [snacks, setSnacks] = useState<Snack[]>(dash.snacks);
  const [log, setLog] = useState<ConsumptionEntry[]>([]);
  const [name, setName] = useState("");
  const [calories, setCalories] = useState("");
  const [icon, setIcon] = useState("🍰");
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<SortState>(loadSort);

  const reload = useCallback(async () => {
    const [s, l] = await Promise.all([api.listSnacks(), api.getTodayConsumption()]);
    setSnacks(s);
    setLog(l);
  }, []);

  useEffect(() => {
    reload().catch((e) => toast(String(e)));
  }, [reload, toast]);

  const goalIds = new Set(dash.goalSnacks.map((g) => g.id));
  const { today, savings } = dash;
  const budget = today.kcalEarned - today.kcalConsumed;
  const tickets = savings.snackTickets;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseSort = (key: SortKey) => {
    const next: SortState =
      sort.key === key
        ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: SORTS.find((s) => s.key === key)!.first };
    setSort(next);
    saveSort(next);
  };
  const sortInfo = SORTS.find((s) => s.key === sort.key)!;
  const shown = sortSnacks(snacks, sort);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const kcal = Number(calories);
    void run(async () => {
      const s = await api.addSnack(name, kcal, icon);
      toast(`${s.icon} ${s.name} を図鑑に追加しました`);
      setName("");
      setCalories("");
    });
  };

  return (
    <div className="screen snacks">
      <section className="card ledger">
        <div className="section-head">
          <h2>カロリー家計簿（今日）</h2>
          <div className="ledger-totals">
            <span>獲得 <b>{today.kcalEarned}</b></span>
            <span>食べた <b>{today.kcalConsumed}</b></span>
            <span className={budget < 0 ? "negative" : "positive"}>
              残り <b>{budget}</b> kcal
            </span>
          </div>
        </div>
        <div className="savings-box">
          <div className="savings-head">
            <span>
              🐷 貯蓄 <b>{savings.balance.toLocaleString()}</b> / {savings.perTicket.toLocaleString()} kcal
            </span>
            {tickets > 0 && <span className="badge ticket">🎟 お菓子引換券 ×{tickets}</span>}
          </div>
          <div className="savings-track">
            <div style={{ width: `${Math.min(100, (savings.balance / savings.perTicket) * 100)}%` }} />
          </div>
          <div className="muted small">
            今日使わなかったカロリー（今は {Math.max(0, budget)} kcal）は、明日になると貯蓄に入ります。
            {savings.perTicket.toLocaleString()} kcal たまるごとに、好きなお菓子をカロリーを使わずに1つ食べられる引換券になります。
          </div>
        </div>
        {log.length === 0 ? (
          <div className="muted">まだ何も食べていません。食べたら図鑑の「食べた！」で記録しましょう。</div>
        ) : (
          <ul className="log-list">
            {log.map((e) => (
              <li key={e.id}>
                <span className="log-icon">{e.snackIcon}</span>
                <span className="log-name">{e.snackName}</span>
                <span className="log-kcal">{e.withTicket ? "🎟 引換券" : `−${e.calories} kcal`}</span>
                <span className="muted small">{e.eatenAt.slice(11, 16)}</span>
                <button className="btn-link" disabled={busy} onClick={() => run(async () => { await api.deleteConsumption(e.id); })}>
                  取り消す
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>
            お菓子図鑑 <span className="snack-count">{snacks.length}種</span>
          </h2>
          <div className="sort-bar" role="group" aria-label="並び替え">
            <span className="muted small">並び替え</span>
            <div className="segmented">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  className={sort.key === s.key ? "active" : ""}
                  title={sort.key === s.key ? "もう一度押すと逆順" : `${s.label}順（${s.dirs[s.first]}）`}
                  onClick={() => chooseSort(s.key)}
                >
                  {s.label}
                  {sort.key === s.key && (sort.dir === "asc" ? " ↑" : " ↓")}
                </button>
              ))}
            </div>
            <button className="btn-link sort-dir" title="逆順にする" onClick={() => chooseSort(sort.key)}>
              {sortInfo.dirs[sort.dir]}
            </button>
          </div>
        </div>
        <p className="muted small">☆ を押すと目標になり、ホームに「あと何問で食べられるか」が表示されます（いくつでも登録できます）。</p>
        <ul className={"snack-list" + (tickets > 0 ? " with-tickets" : "")}>
          {shown.map((s) => {
            const isGoal = goalIds.has(s.id);
            const affordable = budget >= s.calories;
            return (
              <li key={s.id} className={"snack-row" + (isGoal ? " goal" : "")}>
                <button
                  className={"snack-star" + (isGoal ? " on" : "")}
                  disabled={busy}
                  aria-pressed={isGoal}
                  aria-label={isGoal ? "目標から外す" : "目標にする"}
                  title={isGoal ? "目標から外します" : "目標にします（いくつでも登録できます）"}
                  onClick={() => run(async () => { await api.setGoalSnack(s.id, !isGoal); })}
                >
                  {isGoal ? "★" : "☆"}
                </button>
                <span className="snack-row-icon">{s.icon}</span>
                <span className="snack-row-name" title={s.name}>
                  {s.name}
                  {!s.isBuiltin && <span className="pill snack-mine">自作</span>}
                </span>
                <span className="snack-row-count" title="これまでに食べた回数">
                  {s.eatenCount > 0 || sort.key === "eaten" ? `${s.eatenCount}回` : ""}
                </span>
                <span className="snack-row-kcal">{s.calories} kcal</span>
                <span className="snack-row-actions">
                  <button
                    className={"btn-small eat " + (affordable ? "" : "over")}
                    disabled={busy}
                    title={affordable ? "今日の予算内です" : "今日の予算を超えます（記録は可能）"}
                    onClick={() =>
                      run(async () => {
                        await api.logSnackEaten(s.id);
                        playCrunch();
                        toast(`${s.icon} ${s.name}（${s.calories} kcal）を記録しました`);
                      })
                    }
                  >
                    食べた！
                  </button>
                  {tickets > 0 && (
                    <button
                      className="btn-small ticket"
                      disabled={busy}
                      title="お菓子引換券を1枚使って、カロリーを使わずに食べます"
                      onClick={() =>
                        run(async () => {
                          await api.eatWithTicket(s.id);
                          playCrunch();
                          toast(`🎟 引換券で ${s.icon} ${s.name} を食べました（カロリーは使っていません）`);
                        })
                      }
                    >
                      🎟 引換券
                    </button>
                  )}
                  {!s.isBuiltin && (
                    <button className="btn-link danger" disabled={busy} onClick={() => run(async () => { await api.deleteSnack(s.id); })}>
                      削除
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <h2>お菓子を登録する</h2>
        <form className="add-form" onSubmit={add}>
          <div className="icon-picker">
            {ICONS.map((i) => (
              <button type="button" key={i} className={icon === i ? "active" : ""} onClick={() => setIcon(i)}>
                {i}
              </button>
            ))}
          </div>
          <div className="row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 近所のケーキ屋のショートケーキ" maxLength={40} />
            <input value={calories} onChange={(e) => setCalories(e.target.value)} placeholder="kcal" type="number" min={1} max={5000} style={{ width: 110 }} />
            <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || !calories}>
              {icon} 追加
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
