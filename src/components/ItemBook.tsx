import { useState, type ReactNode } from "react";
import { usePhoneWidth } from "../lib/touch";
import { DeleteButton, EditButton, GoalButton, MoreButton } from "./IconButtons";
import { iconLabel, ItemIcon } from "./ItemIcon";

/**
 * The お菓子図鑑 and the 課題一覧 (ダイエット機能) are the same kind of list: a name, kcal and icon a
 * row, made a goal with ♡, corrected with the pencil and taken out with ×, in the order picked.
 * They differ in what a row's own buttons do (eat / done) and in a few words.
 */
export interface BookItem {
  id: number;
  name: string;
  calories: number;
  icon: string;
}

/** The words that differ between the snack book and the 課題一覧. */
export interface BookWords {
  /** お菓子 / 課題 */
  what: string;
  /** 図鑑 / 課題一覧 */
  book: string;
  /** the order by how often: よく食べる / よくやる */
  countSort: string;
  /** これまでに食べた回数 / これまでにやった回数 */
  countTitle: string;
  /** a kcal figure as the list shows it: "50 kcal" (spent) / "+30 kcal" (earned) */
  kcal: (n: number) => string;
}

export const SNACK_WORDS: BookWords = {
  what: "お菓子",
  book: "図鑑",
  countSort: "よく食べる",
  countTitle: "これまでに食べた回数",
  kcal: (n) => `${n} kcal`,
};

export const TASK_WORDS: BookWords = {
  what: "課題",
  book: "課題一覧",
  countSort: "よくやる",
  countTitle: "これまでにやった回数",
  kcal: (n) => `+${n} kcal`,
};

/** The most kcal a snack may have (commands::checked_snack) and a 課題 may pay (diet::TASK_MAX_KCAL). */
export const SNACK_MAX_KCAL = 5000;
export const TASK_MAX_KCAL = 1000;

type SortKey = "calories" | "added" | "name" | "icon" | "count";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Each order starts in the direction people usually want it, and flips on a second click. */
function sortsOf(words: BookWords): Array<{ key: SortKey; label: string; first: SortDir; dirs: Record<SortDir, string> }> {
  return [
    { key: "calories", label: "カロリー", first: "asc", dirs: { asc: "低い順", desc: "高い順" } },
    { key: "added", label: "追加", first: "desc", dirs: { desc: "新しい順", asc: "古い順" } },
    { key: "name", label: "名前", first: "asc", dirs: { asc: "あ→ん", desc: "ん→あ" } },
    { key: "icon", label: "アイコン", first: "asc", dirs: { asc: "種類ごと", desc: "種類ごと（逆）" } },
    { key: "count", label: words.countSort, first: "desc", dirs: { desc: "多い順", asc: "少ない順" } },
  ];
}
const SORT_KEYS: SortKey[] = ["calories", "added", "name", "icon", "count"];
const DEFAULT_SORT: SortState = { key: "calories", dir: "asc" };

function loadSort(storage: string): SortState {
  try {
    const v = JSON.parse(localStorage.getItem(storage) ?? "null") as { key: string; dir: string } | null;
    // The snack book kept "eaten" for よく食べる before the 課題一覧 shared the list.
    const key = v?.key === "eaten" ? "count" : v?.key;
    if (v && SORT_KEYS.includes(key as SortKey) && (v.dir === "asc" || v.dir === "desc")) return { key: key as SortKey, dir: v.dir };
  } catch {
    /* ignore */
  }
  return DEFAULT_SORT;
}

function saveSort(storage: string, sort: SortState) {
  try {
    localStorage.setItem(storage, JSON.stringify(sort));
  } catch {
    /* ignore */
  }
}

const collator = new Intl.Collator("ja");

/** Ties fall back to calories and then the order added, always ascending, so rows stay put. */
function sortItems<T extends BookItem>(items: T[], { key, dir }: SortState, icons: string[], countOf: (item: T) => number): T[] {
  // Icons in the order of the picker, so "アイコン順" groups them the way they are offered.
  const iconRank = (icon: string) => {
    const i = icons.indexOf(icon);
    return i < 0 ? icons.length : i;
  };
  const compare = (a: T, b: T): number => {
    switch (key) {
      case "calories":
        return a.calories - b.calories;
      case "added":
        // Ids grow as rows are added; the first ones come first.
        return a.id - b.id;
      case "name":
        return collator.compare(a.name, b.name);
      case "icon":
        return iconRank(a.icon) - iconRank(b.icon) || a.icon.localeCompare(b.icon);
      case "count":
        return countOf(a) - countOf(b);
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return items.slice().sort((a, b) => sign * compare(a, b) || a.calories - b.calories || a.id - b.id);
}

interface BookCardProps<T extends BookItem> {
  title: ReactNode;
  /** before the heading (on its left): the ⇄ that switches the お菓子図鑑 and the 課題一覧 */
  switcher?: ReactNode;
  /** how the list is used, under the heading */
  intro: ReactNode;
  /** a note above the rows (the snack book's 引換券) */
  note?: ReactNode;
  items: T[];
  words: BookWords;
  icons: string[];
  maxKcal: number;
  /** where the order picked is kept (localStorage) */
  sortStorage: string;
  countOf: (item: T) => number;
  goalIds: Set<number>;
  /** extra classes for the list */
  listClass?: string;
  busy: boolean;
  /** runs a change, then reloads the screen (with its busy state and its toast on a failure) */
  run: (fn: () => Promise<void>) => void;
  toast: (msg: string) => void;
  setGoal: (id: number, goal: boolean) => Promise<unknown>;
  update: (id: number, name: string, calories: number, icon: string) => Promise<BookItem>;
  remove: (id: number) => Promise<unknown>;
  /** a row's own buttons, before the pencil: eat (and the ticket) / done */
  actions: (item: T) => ReactNode;
}

/** The list as a card: the heading with the orders, then a row each, a row opening its edit form or its delete question below it. */
export function BookCard<T extends BookItem>({
  title,
  switcher,
  intro,
  note,
  items,
  words,
  icons,
  maxKcal,
  sortStorage,
  countOf,
  goalIds,
  listClass = "",
  busy,
  run,
  toast,
  setGoal,
  update,
  remove,
  actions,
}: BookCardProps<T>) {
  const [sort, setSort] = useState<SortState>(() => loadSort(sortStorage));
  /** the row being corrected, with what the form says so far */
  const [editing, setEditing] = useState<{ id: number; name: string; calories: string; icon: string } | null>(null);
  /** the row whose × asks "削除する / やめる" */
  const [deleting, setDeleting] = useState<number | null>(null);
  /** a phone: the row whose ⋯ has its pencil and × out under it */
  const [menu, setMenu] = useState<number | null>(null);
  const phone = usePhoneWidth();
  const startEdit = (s: T) => {
    setMenu(null);
    setDeleting(null);
    setEditing(editing?.id === s.id ? null : { id: s.id, name: s.name, calories: String(s.calories), icon: s.icon });
  };
  const startDelete = (id: number) => {
    setMenu(null);
    setEditing(null);
    setDeleting(deleting === id ? null : id);
  };

  const sorts = sortsOf(words);
  const chooseSort = (key: SortKey) => {
    const next: SortState =
      sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: sorts.find((s) => s.key === key)!.first };
    setSort(next);
    saveSort(sortStorage, next);
  };
  const shown = sortItems(items, sort, icons, countOf);

  const saveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { id, name, calories, icon } = editing;
    run(async () => {
      const s = await update(id, name, Number(calories), icon);
      toast(`${iconLabel(s.icon, s.name)}（${words.kcal(s.calories)}）に修正しました`);
      setEditing(null);
    });
  };

  return (
    <section className="card">
      <div className="section-head">
        <div className="title-with-switch">
          {switcher}
          <h2>{title}</h2>
        </div>
        {phone ? (
          // a phone picks the order and its direction from one list, beside the heading
          <label className="sort-select">
            <select
              aria-label="並び替え"
              value={`${sort.key}:${sort.dir}`}
              onChange={(e) => {
                const [key, dir] = e.target.value.split(":") as [SortKey, SortDir];
                setSort({ key, dir });
                saveSort(sortStorage, { key, dir });
              }}
            >
              {sorts.flatMap((s) =>
                ([s.first, s.first === "asc" ? "desc" : "asc"] as SortDir[]).map((dir) => (
                  <option key={`${s.key}:${dir}`} value={`${s.key}:${dir}`}>
                    {s.label}・{s.dirs[dir]}
                  </option>
                )),
              )}
            </select>
          </label>
        ) : (
          <div className="sort-bar" role="group" aria-label="並び替え">
            <span className="muted small">並び替え</span>
            <div className="segmented">
              {sorts.map((s) => {
                const on = sort.key === s.key;
                const flipped = sort.dir === "asc" ? "desc" : "asc";
                return (
                  <button
                    key={s.key}
                    className={on ? "active" : ""}
                    title={on ? `${s.dirs[sort.dir]}（もう一度押すと${s.dirs[flipped]}）` : `${s.label}順（${s.dirs[s.first]}）`}
                    onClick={() => chooseSort(s.key)}
                  >
                    {s.label}
                    {on && (sort.dir === "asc" ? " ↑" : " ↓")}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <p className="muted small">{intro}</p>
      {note}
      <ul className={"snack-list " + listClass}>
        {shown.map((s) => {
          const isGoal = goalIds.has(s.id);
          const edit = editing?.id === s.id ? editing : null;
          const count = countOf(s);
          return [
            <li key={s.id} className={"snack-row" + (isGoal ? " goal" : "") + (edit ? " editing" : "")}>
              <GoalButton on={isGoal} disabled={busy} onClick={() => run(async () => { await setGoal(s.id, !isGoal); })} />
              <span className="snack-row-icon">
                <ItemIcon icon={s.icon} />
              </span>
              <span className="snack-row-name" title={s.name}>
                {s.name}
              </span>
              <span className="snack-row-count" title={words.countTitle}>
                {count > 0 || sort.key === "count" ? `${count}回` : ""}
              </span>
              <span className="snack-row-kcal">{words.kcal(s.calories)}</span>
              <span className="snack-row-actions">
                {actions(s)}
                {phone ? (
                  <MoreButton
                    label="修正・削除"
                    open={menu === s.id}
                    disabled={busy}
                    onClick={() => setMenu(menu === s.id ? null : s.id)}
                  />
                ) : (
                  <>
                    <EditButton label="名前・カロリー・アイコンを修正" disabled={busy} onClick={() => startEdit(s)} />
                    <DeleteButton label={`${words.book}から削除`} disabled={busy} onClick={() => startDelete(s.id)} />
                  </>
                )}
              </span>
            </li>,
            phone && menu === s.id && (
              <li key={`${s.id}-menu`} className="snack-menu">
                <button className="btn-small" disabled={busy} onClick={() => startEdit(s)}>
                  ✎ 名前・カロリー・アイコンを直す
                </button>
                <button className="btn-small danger-text" disabled={busy} onClick={() => startDelete(s.id)}>
                  × 削除
                </button>
              </li>
            ),
            deleting === s.id && (
              <li key={`${s.id}-delete`} className="snack-confirm">
                <span>
                  <ItemIcon icon={s.icon} /> {s.name} を{words.book}から削除しますか？
                </span>
                <button
                  className="btn-small danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await remove(s.id);
                      setDeleting(null);
                      toast(`${iconLabel(s.icon, s.name)} を${words.book}から削除しました`);
                    })
                  }
                >
                  削除する
                </button>
                <button className="btn-small" disabled={busy} onClick={() => setDeleting(null)}>
                  やめる
                </button>
              </li>
            ),
            edit && (
              <li key={`${s.id}-edit`} className="snack-edit">
                <form onSubmit={saveEdit}>
                  <div className="icon-picker small">
                    {icons.includes(edit.icon) ? null : (
                      <button type="button" className="active" title="今のアイコン">
                        <ItemIcon icon={edit.icon} />
                      </button>
                    )}
                    {icons.map((i) => (
                      <button type="button" key={i} className={edit.icon === i ? "active" : ""} onClick={() => setEditing({ ...edit, icon: i })}>
                        <ItemIcon icon={i} />
                      </button>
                    ))}
                  </div>
                  <div className="row">
                    <input
                      value={edit.name}
                      onChange={(e) => setEditing({ ...edit, name: e.target.value })}
                      maxLength={40}
                      aria-label={`${words.what}の名前`}
                      autoFocus
                    />
                    <input
                      value={edit.calories}
                      onChange={(e) => setEditing({ ...edit, calories: e.target.value })}
                      type="number"
                      min={1}
                      max={maxKcal}
                      aria-label="カロリー"
                      className="snack-edit-kcal"
                    />
                    <span className="muted small">kcal</span>
                    <button className="btn btn-primary" type="submit" disabled={busy || !edit.name.trim() || !edit.calories}>
                      保存
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => setEditing(null)}>
                      やめる
                    </button>
                  </div>
                </form>
              </li>
            ),
          ];
        })}
      </ul>
    </section>
  );
}

/** お菓子を登録する / 課題を登録する: an icon to pick, then a name and its kcal. */
export function AddCard({
  title,
  words,
  icons,
  defaultIcon,
  maxKcal,
  placeholder,
  busy,
  run,
  toast,
  add,
}: {
  title: string;
  words: BookWords;
  icons: string[];
  defaultIcon: string;
  maxKcal: number;
  placeholder: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => void;
  toast: (msg: string) => void;
  add: (name: string, calories: number, icon: string) => Promise<BookItem>;
}) {
  const [name, setName] = useState("");
  const [calories, setCalories] = useState("");
  const [icon, setIcon] = useState(defaultIcon);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const s = await add(name, Number(calories), icon);
      toast(`${iconLabel(s.icon, s.name)} を${words.book}に追加しました`);
      setName("");
      setCalories("");
    });
  };
  return (
    <section className="card">
      <h2>{title}</h2>
      <form className="add-form" onSubmit={submit}>
        <div className="icon-picker">
          {icons.map((i) => (
            <button type="button" key={i} className={icon === i ? "active" : ""} onClick={() => setIcon(i)}>
              <ItemIcon icon={i} />
            </button>
          ))}
        </div>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={40} aria-label={`${words.what}の名前`} />
          <input
            value={calories}
            onChange={(e) => setCalories(e.target.value)}
            placeholder="kcal"
            type="number"
            min={1}
            max={maxKcal}
            aria-label="カロリー"
            style={{ width: 110 }}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || !calories}>
            <ItemIcon icon={icon} /> 追加
          </button>
        </div>
      </form>
    </section>
  );
}
