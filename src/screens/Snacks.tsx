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

export default function Snacks({ dash, onChanged, toast }: Props) {
  const [snacks, setSnacks] = useState<Snack[]>(dash.snacks);
  const [log, setLog] = useState<ConsumptionEntry[]>([]);
  const [name, setName] = useState("");
  const [calories, setCalories] = useState("");
  const [icon, setIcon] = useState("🍰");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [s, l] = await Promise.all([api.listSnacks(), api.getTodayConsumption()]);
    setSnacks(s);
    setLog(l);
  }, []);

  useEffect(() => {
    reload().catch((e) => toast(String(e)));
  }, [reload, toast]);

  const goalId = dash.goalSnack?.id ?? null;
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
        <div className="savings">
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
          <h2>お菓子図鑑</h2>
          <div className="muted">目標にすると「あと何問で食べられるか」がホームに表示されます</div>
        </div>
        <div className="snack-grid">
          {snacks.map((s) => {
            const isGoal = s.id === goalId;
            const affordable = budget >= s.calories;
            return (
              <div key={s.id} className={"snack-card " + (isGoal ? "goal" : "")}>
                <div className="snack-icon">{s.icon}</div>
                <div className="snack-name">{s.name}</div>
                <div className="snack-kcal">{s.calories} kcal</div>
                <div className="snack-actions">
                  <button
                    className={"btn-small " + (isGoal ? "active" : "")}
                    disabled={busy}
                    onClick={() => run(async () => { await api.setGoalSnack(isGoal ? null : s.id); })}
                  >
                    {isGoal ? "★ 目標中" : "目標にする"}
                  </button>
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
                      🎟 引換券で食べる
                    </button>
                  )}
                  {!s.isBuiltin && (
                    <button className="btn-link danger" disabled={busy} onClick={() => run(async () => { await api.deleteSnack(s.id); })}>
                      削除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
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
