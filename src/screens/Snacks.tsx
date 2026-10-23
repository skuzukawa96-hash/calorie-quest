import { useCallback, useEffect, useState } from "react";
import { DoneButton, EatButton, Heart, SwitchViewButton, UndoButton } from "../components/IconButtons";
import { iconLabel, ItemIcon } from "../components/ItemIcon";
import { AddCard, BookCard, SNACK_MAX_KCAL, SNACK_WORDS, TASK_MAX_KCAL, TASK_WORDS } from "../components/ItemBook";
import { api } from "../lib/api";
import { SNACK_ICONS } from "../lib/snackIcons";
import { DEFAULT_TASK_ICON, TASK_ICONS } from "../lib/taskIcons";
import { playCrunch, playDone } from "../lib/sfx";
import { useDietView } from "../lib/dietView";
import { usePhoneWidth } from "../lib/touch";
import { remainingKcal, type ConsumptionEntry, type Dashboard, type Snack, type Task, type TaskEntry } from "../types";

interface Props {
  dash: Dashboard;
  onChanged: () => void;
  /** お菓子引換券 in use: each snack shows a 引換券 button (the home's goals show them too) */
  ticketMode: boolean;
  onTicketMode: (on: boolean) => void;
  toast: (msg: string) => void;
}

/**
 * The snacks, or (ダイエット機能) the 課題 in their place: the day's history in the 家計簿 and the
 * list under it switch together, and the choice is kept for the next time.
 */
type Book = "snacks" | "tasks";
const BOOK_KEY = "cq-snacks-book";

function loadBook(): Book {
  try {
    return localStorage.getItem(BOOK_KEY) === "tasks" ? "tasks" : "snacks";
  } catch {
    return "snacks";
  }
}

/** A row of today's log: a snack eaten (kcal spent) or a 課題 done (kcal earned, ダイエット機能). */
interface LogEntry {
  kind: "snack" | "task";
  id: number;
  name: string;
  icon: string;
  calories: number;
  at: string;
  withTicket: boolean;
}

function eatenLog(eaten: ConsumptionEntry[]): LogEntry[] {
  return eaten.map((e) => ({
    kind: "snack",
    id: e.id,
    name: e.snackName,
    icon: e.snackIcon,
    calories: e.calories,
    at: e.eatenAt,
    withTicket: e.withTicket,
  }));
}

function doneLog(done: TaskEntry[]): LogEntry[] {
  return done.map((e) => ({
    kind: "task",
    id: e.id,
    name: e.taskName,
    icon: e.taskIcon,
    calories: e.calories,
    at: e.doneAt,
    withTicket: false,
  }));
}

/** The same snack eaten (or 課題 done) again and again in a day, kept as one row: 飴一粒 ×8 −240 kcal. */
interface LogStack {
  key: string;
  /** in the order eaten or done */
  entries: LogEntry[];
}

/**
 * The day's log with each snack's records stacked: the same name, icon and calories (and whether a
 * ticket paid for it) are the same snack, and a 課題 stacks the same way. A stack is placed by the
 * time of its last record, the time it shows (when it was last eaten or done), newest first as the
 * log is.
 */
function stackLog(log: LogEntry[]): LogStack[] {
  const byKey = new Map<string, LogEntry[]>();
  for (const e of log) {
    const key = [e.kind, e.name, e.icon, e.calories, e.withTicket].join("|");
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  const inOrder = (a: LogEntry, b: LogEntry) => a.at.localeCompare(b.at) || a.id - b.id;
  return [...byKey]
    .map(([key, entries]) => ({ key, entries: entries.slice().sort(inOrder) }))
    .sort((a, b) => inOrder(b.entries[b.entries.length - 1], a.entries[a.entries.length - 1]));
}

/** What a row of the log did to the day: −50 kcal eaten, 🎟 引換券, +30 kcal done. */
function logKcal(e: LogEntry, calories = e.calories): string {
  if (e.withTicket) return "🎟 引換券";
  return e.kind === "task" ? `+${calories} kcal` : `−${calories} kcal`;
}

/** One record of today's log: what was eaten or done, its calories (or the ticket) and when, with its undo. */
function LogRow({ e, busy, onUndo }: { e: LogEntry; busy: boolean; onUndo: () => void }) {
  return (
    <div className="log-row">
      <span className="log-icon">
        <ItemIcon icon={e.icon} />
      </span>
      <span className="log-name">{e.name}</span>
      <span className={"log-kcal" + (e.kind === "task" ? " earned" : "")}>{logKcal(e)}</span>
      <span className="muted small">{e.at.slice(11, 16)}</span>
      <UndoButton disabled={busy} onClick={onUndo} />
    </div>
  );
}

export default function Snacks({ dash, onChanged, ticketMode, onTicketMode, toast }: Props) {
  const [snacks, setSnacks] = useState<Snack[]>(dash.snacks);
  const [tasks, setTasks] = useState<Task[]>(dash.tasks);
  const [eaten, setEaten] = useState<ConsumptionEntry[]>([]);
  const [done, setDone] = useState<TaskEntry[]>([]);
  const [busy, setBusy] = useState(false);
  /** the stack of today's log opened to undo its records one by one */
  const [openStack, setOpenStack] = useState<string | null>(null);
  const [book, setBook] = useState<Book>(loadBook);
  const phone = usePhoneWidth();

  const reload = useCallback(async () => {
    const [s, e, t, d] = await Promise.all([api.listSnacks(), api.getTodayConsumption(), api.listTasks(), api.getTodayTasks()]);
    setSnacks(s);
    setEaten(e);
    setTasks(t);
    setDone(d);
  }, []);

  // Again on a new day (the app left open past midnight): the log is today's.
  const day = dash.today.date;
  useEffect(() => {
    reload().catch((e) => toast(String(e)));
  }, [reload, toast, day]);

  const diet = dash.user.dietMode;
  const dietView = useDietView();
  // The 課題一覧 is there only with ダイエット機能 on; turned off, the card is the snacks' again. A
  // phone follows the top bar's お菓子 / 課題 switch, a PC the ⇄ of the headings.
  const showTasks = diet && (phone ? dietView === "tasks" : book === "tasks");
  const switchBook = () => {
    const next: Book = showTasks ? "snacks" : "tasks";
    setBook(next);
    try {
      localStorage.setItem(BOOK_KEY, next);
    } catch {
      /* ignore */
    }
  };
  // Before the history's heading and the list's (on the left, so it stays put as the heading
  // changes): either switches both.
  const switcher = diet && !phone && (
    <SwitchViewButton
      label={showTasks ? "お菓子（食べた記録と図鑑）に切り替える" : "課題（達成した記録と課題一覧）に切り替える"}
      onClick={switchBook}
    />
  );
  const { today, savings } = dash;
  const budget = remainingKcal(today);
  const tickets = savings.snackTickets;
  const showTickets = ticketMode && tickets > 0;
  const log = showTasks ? doneLog(done) : eatenLog(eaten);

  const run = (fn: () => Promise<void>) => {
    void (async () => {
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
    })();
  };

  const undo = (e: LogEntry) =>
    run(async () => {
      await (e.kind === "task" ? api.deleteTaskDone(e.id) : api.deleteConsumption(e.id));
    });

  return (
    <div className="screen snacks">
      <section className="card ledger">
        <div className="section-head">
          <h2>カロリー家計簿（今日）</h2>
          <div className="ledger-totals">
            <span>獲得 <b>{today.kcalEarned}</b></span>
            <span>食べた <b>{today.kcalConsumed}</b></span>
            {today.carriedKcal < 0 && (
              <span className="negative" title="前日までに食べすぎた分。今日の残りから引かれます">
                持ち越し <b>{today.carriedKcal}</b>
              </span>
            )}
            <span className={budget < 0 ? "negative" : "positive"}>
              残り <b>{budget}</b>
              <span className="ledger-unit"> kcal</span>
            </span>
          </div>
        </div>
        <div className="savings-box">
          <div className="savings-head">
            <span>
              🐷 貯蓄 <b>{savings.balance.toLocaleString()}</b> / {savings.perTicket.toLocaleString()} kcal
            </span>
            {tickets > 0 && (
              <button
                className={"badge ticket" + (ticketMode ? " active" : "")}
                aria-pressed={ticketMode}
                onClick={() => onTicketMode(!ticketMode)}
                title={
                  ticketMode
                    ? "もう一度押すと「引換券」ボタンを隠します"
                    : "押すと、図鑑のお菓子とホームの目標のお菓子に「引換券」ボタンが出ます"
                }
              >
                🎟 お菓子引換券 ×{tickets}
              </button>
            )}
          </div>
          <div className="savings-track">
            <div style={{ width: `${Math.min(100, (savings.balance / savings.perTicket) * 100)}%` }} />
          </div>
          {phone ? (
            <div className="muted small">
              使わなかったカロリーは明日の貯蓄に入り、{savings.perTicket.toLocaleString()} kcal でお菓子引換券1枚になります。
            </div>
          ) : (
            <div className="muted small">
              今日使わなかったカロリー（今は {Math.max(0, budget)} kcal）は、明日になると貯蓄に入ります。マイナスで終わった日は、そのマイナスが次の日に持ち越されます。
              {savings.perTicket.toLocaleString()} kcal たまるごとに、好きなお菓子をカロリーを使わずに1つ食べられる引換券になります。
            </div>
          )}
        </div>
        {diet && (
          <div className="log-head title-with-switch">
            {switcher}
            <h3>{showTasks ? "今日達成した課題" : "今日食べたお菓子"}</h3>
          </div>
        )}
        {log.length === 0 ? (
          <div className="muted">
            {showTasks
              ? "まだ課題を達成していません。やったら課題一覧の力こぶのボタンで記録しましょう。"
              : "まだ何も食べていません。食べたら図鑑のナイフとフォークのボタンで記録しましょう。"}
          </div>
        ) : (
          <ul className="log-list">
            {stackLog(log).map(({ key, entries }) => {
              const first = entries[0];
              const last = entries[entries.length - 1];
              if (entries.length === 1) {
                return (
                  <li key={key}>
                    <LogRow e={first} busy={busy} onUndo={() => undo(first)} />
                  </li>
                );
              }
              // A stack: one row with the count, the calories of them all and the time of the last;
              // its undo opens the records one by one, each undone on its own.
              const open = openStack === key;
              const total = entries.reduce((n, e) => n + e.calories, 0);
              return (
                <li key={key} className={"log-stack" + (open ? " open" : "")}>
                  <div className="log-row">
                    <span className="log-icon">
                      <ItemIcon icon={first.icon} />
                    </span>
                    <span className="log-name">
                      {first.name} <b className="log-count">×{entries.length}</b>
                    </span>
                    <span className={"log-kcal" + (first.kind === "task" ? " earned" : "")}>{logKcal(first, total)}</span>
                    <span className="muted small">{last.at.slice(11, 16)}</span>
                    <UndoButton
                      label={open ? "一覧を閉じる" : "1つずつ取り消す（一覧を開く）"}
                      expanded={open}
                      disabled={busy}
                      onClick={() => setOpenStack(open ? null : key)}
                    />
                  </div>
                  {open && (
                    <ul className="log-stack-list">
                      {entries.map((e) => (
                        <li key={e.id}>
                          <LogRow e={e} busy={busy} onUndo={() => undo(e)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* keyed, so each list keeps its own order and forms when the card switches */}
      {showTasks ? (
        <>
          <BookCard
            key="tasks"
            title={
              <>
                課題一覧 <span className="snack-count">{tasks.length}件</span>
              </>
            }
            switcher={switcher}
            intro={
              phone ? (
                <>
                  <span className="inline-heart">
                    <Heart on={false} />
                  </span>{" "}
                  で目標に入れる・力こぶで達成を記録・⋯ で直す・消す（取り消しは上の家計簿から）
                </>
              ) : (
                <>
                  💪 を押すと達成になり、書いてあるカロリーがもらえます（遊び方モードの倍率は掛かりません。取り消しは上の家計簿から）。
                  <span className="inline-heart">
                    <Heart on={false} />
                  </span>{" "}
                  を押すと目標になり、ホームの「目標の課題」からも達成を記録できます。鉛筆で修正したり、× で削除したりもできます。
                </>
              )
            }
            items={tasks}
            words={TASK_WORDS}
            icons={TASK_ICONS}
            maxKcal={TASK_MAX_KCAL}
            sortStorage="cq-task-sort"
            countOf={(t) => t.doneCount}
            goalIds={new Set(dash.goalTasks.map((g) => g.id))}
            listClass="task-list"
            busy={busy}
            run={run}
            toast={toast}
            setGoal={api.setGoalTask}
            update={api.updateTask}
            remove={api.deleteTask}
            actions={(t) => (
              <DoneButton
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.logTaskDone(t.id);
                    playDone();
                    toast(`💪 ${iconLabel(t.icon, t.name)} を達成しました（+${t.calories} kcal）`);
                  })
                }
              />
            )}
          />
          <AddCard
            key="add-task"
            title="課題を登録する"
            words={TASK_WORDS}
            icons={TASK_ICONS}
            defaultIcon={DEFAULT_TASK_ICON}
            maxKcal={TASK_MAX_KCAL}
            placeholder="例: 腹筋 20回、お風呂掃除、漢字ドリル 1ページ"
            busy={busy}
            run={run}
            toast={toast}
            add={api.addTask}
          />
        </>
      ) : (
        <>
          <BookCard
            key="snacks"
            title={
              <>
                お菓子図鑑 <span className="snack-count">{snacks.length}種</span>
              </>
            }
            switcher={switcher}
            intro={
              phone ? (
                <>
                  <span className="inline-heart">
                    <Heart on={false} />
                  </span>{" "}
                  で目標に入れる・⋯ で直す・消す。グレーのナイフとフォークは今日の残りを超えるお菓子（押せば記録はできます）
                </>
              ) : (
                <>
                  <span className="inline-heart">
                    <Heart on={false} />
                  </span>{" "}
                  を押すと目標になり、ホームに「あと何問で食べられるか」が表示されます（いくつでも登録できます）。鉛筆で名前・カロリー・アイコンを修正したり、× で削除したりもできます。
                </>
              )
            }
            note={
              showTickets && <p className="ticket-note">🎟 引換券を使うお菓子の「引換券」を押してください。カロリーを使わずに食べられます。</p>
            }
            items={snacks}
            words={SNACK_WORDS}
            icons={SNACK_ICONS}
            maxKcal={SNACK_MAX_KCAL}
            sortStorage="cq-snack-sort"
            countOf={(s) => s.eatenCount}
            goalIds={new Set(dash.goalSnacks.map((g) => g.id))}
            listClass={showTickets ? "with-tickets" : ""}
            busy={busy}
            run={run}
            toast={toast}
            setGoal={api.setGoalSnack}
            update={api.updateSnack}
            remove={api.deleteSnack}
            actions={(s) => (
              <>
                <EatButton
                  affordable={budget >= s.calories}
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api.logSnackEaten(s.id);
                      playCrunch();
                      toast(`${s.icon} ${s.name}（${s.calories} kcal）を記録しました`);
                    })
                  }
                />
                {showTickets && (
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
              </>
            )}
          />
          <AddCard
            key="add-snack"
            title="お菓子を登録する"
            words={SNACK_WORDS}
            icons={SNACK_ICONS}
            defaultIcon="🍰"
            maxKcal={SNACK_MAX_KCAL}
            placeholder="例: 近所のケーキ屋のショートケーキ"
            busy={busy}
            run={run}
            toast={toast}
            add={api.addSnack}
          />
        </>
      )}
    </div>
  );
}
