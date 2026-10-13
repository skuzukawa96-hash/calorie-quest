import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { playCrunch, playDone } from "../lib/sfx";
import { SNACK_ICONS } from "../lib/snackIcons";
import { DEFAULT_TASK_ICON, TASK_ICONS } from "../lib/taskIcons";
import { DoneButton, EatButton } from "./IconButtons";
import { iconLabel, ItemIcon } from "./ItemIcon";
import { SNACK_MAX_KCAL, SNACK_WORDS, TASK_MAX_KCAL, TASK_WORDS, type BookItem, type BookWords } from "./ItemBook";

/**
 * What the form adds: snacks to the goals (＋ 目標追加 of 目標のお菓子) or 課題 (＋ 課題追加 of 目標の課題,
 * ダイエット機能). The button before 追加 does it now without adding it anywhere: eats the snack, or
 * does the 課題.
 */
export interface GoalKind {
  words: BookWords;
  icons: string[];
  defaultIcon: string;
  maxKcal: number;
  addToBook: (name: string, calories: number, icon: string) => Promise<BookItem>;
  setGoal: (id: number, goal: boolean) => Promise<unknown>;
  /** eats / does one of the list, as itself */
  doItem: (id: number) => Promise<unknown>;
  /** eats / does one the list has not, adding it nowhere */
  doOneOff: (name: string, calories: number, icon: string) => Promise<unknown>;
  /** 食べました / 達成しました */
  didVerb: string;
  /** the tooltip of the button that does it now */
  doLabel: string;
  doButton: (props: { label: string; disabled: boolean; onClick: () => void }) => ReactNode;
  sound: () => void;
}

export const SNACK_GOALS: GoalKind = {
  words: SNACK_WORDS,
  icons: SNACK_ICONS,
  defaultIcon: "🍰",
  maxKcal: SNACK_MAX_KCAL,
  addToBook: api.addSnack,
  setGoal: api.setGoalSnack,
  doItem: api.logSnackEaten,
  doOneOff: api.logOneOffSnack,
  didVerb: "食べました",
  doLabel: "図鑑と目標に追加せず消費する",
  doButton: (p) => <EatButton affordable {...p} />,
  sound: playCrunch,
};

export const TASK_GOALS: GoalKind = {
  words: TASK_WORDS,
  icons: TASK_ICONS,
  defaultIcon: DEFAULT_TASK_ICON,
  maxKcal: TASK_MAX_KCAL,
  addToBook: api.addTask,
  setGoal: api.setGoalTask,
  doItem: api.logTaskDone,
  doOneOff: api.logOneOffTask,
  didVerb: "達成しました",
  doLabel: "課題一覧と目標に追加せず達成する",
  doButton: (p) => <DoneButton {...p} />,
  sound: playDone,
};

interface Props {
  kind: GoalKind;
  /** the whole list (the snack book or the 課題一覧), searched as the name is typed */
  items: BookItem[];
  goalIds: Set<number>;
  /** called after a goal was added or one eaten or done, so the home screen reloads */
  onAdded: () => void;
  onClose: () => void;
  toast: (msg: string) => void;
}

const MAX_SUGGESTIONS = 8;

/**
 * Folds what is compared so "ぽっぷ", "ﾎﾟｯﾌﾟ" and "ポップ" all find ポップコーン: NFKC for
 * half-width kana and letters, hiragana turned into katakana, case ignored.
 */
function fold(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/** Rows whose name contains the typed text anywhere ("コーン" finds ポップコーン), best first. */
function suggest(items: BookItem[], typed: string): BookItem[] {
  const q = fold(typed.trim());
  if (!q) return [];
  return items
    .map((s) => ({ s, at: fold(s.name).indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || a.s.name.length - b.s.name.length || a.s.calories - b.s.calories)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.s);
}

/** The name with the typed part in bold, when folding kept the name's length (it nearly always does). */
function marked(name: string, typed: string): ReactNode {
  const q = fold(typed.trim());
  const f = fold(name);
  const at = f.indexOf(q);
  if (!q || at < 0 || f.length !== name.length) return name;
  return (
    <>
      {name.slice(0, at)}
      <b>{name.slice(at, at + q.length)}</b>
      {name.slice(at + q.length)}
    </>
  );
}

/**
 * ＋ 目標追加 (＋ 課題追加): one line of 名前 / カロリー / アイコン / 🍴 (💪) / 追加. Typing a name lists
 * the rows of the book (the 課題一覧) that contain it, like a browser's search history; picking one
 * fills in its name, kcal and icon and 追加 makes it a goal. One the list does not have is registered
 * in it and made a goal in one go. The knife and fork (the arm) eats (does) it now instead and adds
 * it to neither, so a snack eaten once does not pile up in the book (one the list has is eaten or
 * done as itself).
 */
export default function GoalAdder({ kind, items, goalIds, onAdded, onClose, toast }: Props) {
  const { words } = kind;
  const [name, setName] = useState("");
  const [calories, setCalories] = useState("");
  const [icon, setIcon] = useState(kind.defaultIcon);
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [iconsOpen, setIconsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const iconBox = useRef<HTMLDivElement>(null);

  useEffect(() => nameInput.current?.focus(), []);

  // The icon grid closes when anything else is clicked.
  useEffect(() => {
    if (!iconsOpen) return;
    const away = (e: MouseEvent) => {
      if (!iconBox.current?.contains(e.target as Node)) setIconsOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [iconsOpen]);

  const suggestions = useMemo(() => suggest(items, name), [items, name]);
  const showList = listOpen && suggestions.length > 0;

  // A name the list already has is that row, whether it was picked from the list or typed out;
  // the same name with other kcal or icon would only make a confusing twin, so it is refused.
  const kcal = Number(calories);
  const sameName = items.find((s) => s.name === name.trim());
  const existing = sameName && sameName.calories === kcal && sameName.icon === icon ? sameName : null;
  const clash = sameName && !existing ? sameName : null;
  const alreadyGoal = existing ? goalIds.has(existing.id) : false;
  const filled = name.trim() !== "" && Number.isInteger(kcal) && kcal >= 1 && kcal <= kind.maxKcal;
  const valid = filled && !clash && !alreadyGoal;

  const pick = (s: BookItem) => {
    setName(s.name);
    setCalories(String(s.calories));
    setIcon(s.icon);
    setListOpen(false);
    setActive(-1);
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      if (existing) {
        await kind.setGoal(existing.id, true);
        toast(`${iconLabel(existing.icon, existing.name)} を目標に追加しました`);
      } else {
        const s = await kind.addToBook(name.trim(), kcal, icon);
        await kind.setGoal(s.id, true);
        toast(`${iconLabel(s.icon, s.name)}（${words.kcal(s.calories)}）を${words.book}に登録して、目標に追加しました`);
      }
      onAdded();
      onClose();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Eating (doing) adds nothing, so a name the list has with other kcal or a goal already set is no hindrance.
  const doNow = async () => {
    if (!filled || busy) return;
    setBusy(true);
    try {
      if (existing) {
        await kind.doItem(existing.id);
        toast(`${iconLabel(existing.icon, existing.name)}（${words.kcal(existing.calories)}）を${kind.didVerb}。取り消しはお菓子図鑑から`);
      } else {
        await kind.doOneOff(name.trim(), kcal, icon);
        toast(
          `${iconLabel(icon, name.trim())}（${words.kcal(kcal)}）を${kind.didVerb}（${words.book}と目標には追加していません）。取り消しはお菓子図鑑から`,
        );
      }
      kind.sound();
      onAdded();
      onClose();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setListOpen(true);
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setListOpen(true);
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && showList && active >= 0) {
      e.preventDefault();
      pick(suggestions[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (showList) setListOpen(false);
      else onClose();
    }
  };

  const note = clash
    ? `${words.book}に同じ名前の「${iconLabel(clash.icon, clash.name)}」（${words.kcal(clash.calories)}）があります。候補から選ぶか、名前を変えてください`
    : alreadyGoal
      ? `この${words.what}はもう目標に入っています`
      : existing
        ? `${words.book}の${words.what}を目標に追加します`
        : name.trim()
          ? `${words.book}にない${words.what}は、${words.book}にも登録されます`
          : "";

  return (
    <form
      className="goal-adder"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="goal-adder-row">
        <div className="goal-adder-name">
          <input
            ref={nameInput}
            className="goal-adder-input"
            value={name}
            placeholder="名前"
            maxLength={40}
            role="combobox"
            aria-label={`${words.what}の名前`}
            aria-expanded={showList}
            aria-controls="goal-suggest"
            aria-autocomplete="list"
            onChange={(e) => {
              setName(e.target.value);
              setListOpen(true);
              setActive(-1);
            }}
            onFocus={() => setListOpen(true)}
            onBlur={() => setListOpen(false)}
            onKeyDown={onNameKey}
          />
          {showList && (
            <ul className="goal-suggest" id="goal-suggest" role="listbox" aria-label={`${words.book}の${words.what}`}>
              {suggestions.map((s, i) => (
                <li
                  key={s.id}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "active" : ""}
                  // Keep the focus in the name field, so the list does not close before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(s)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                >
                  <span className="goal-suggest-icon">
                    <ItemIcon icon={s.icon} />
                  </span>
                  <span className="goal-suggest-name">{marked(s.name, name)}</span>
                  {goalIds.has(s.id) && <span className="goal-suggest-goal">★ 目標中</span>}
                  <span className="goal-suggest-kcal">{words.kcal(s.calories)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="goal-adder-kcal">
          <input
            className="goal-adder-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={kind.maxKcal}
            value={calories}
            placeholder="カロリー"
            aria-label="カロリー"
            onChange={(e) => setCalories(e.target.value)}
          />
          <span>kcal</span>
        </label>
        <div className="goal-adder-icon" ref={iconBox}>
          <button
            type="button"
            className="goal-adder-icon-btn"
            aria-label="アイコンを選ぶ"
            aria-expanded={iconsOpen}
            onClick={() => setIconsOpen((o) => !o)}
          >
            <ItemIcon icon={icon} />
            <span className="goal-adder-caret">▾</span>
          </button>
          {iconsOpen && (
            <div className="goal-icon-grid" role="listbox" aria-label="アイコン">
              {kind.icons.map((i) => (
                <button
                  type="button"
                  key={i}
                  role="option"
                  aria-selected={i === icon}
                  className={i === icon ? "active" : ""}
                  onClick={() => {
                    setIcon(i);
                    setIconsOpen(false);
                  }}
                >
                  <ItemIcon icon={i} />
                </button>
              ))}
            </div>
          )}
        </div>
        {kind.doButton({ label: kind.doLabel, disabled: busy || !filled, onClick: () => void doNow() })}
        <button type="submit" className="btn btn-primary goal-adder-submit" disabled={busy || !valid}>
          追加
        </button>
      </div>
      {note && <div className={"goal-adder-note" + (clash || alreadyGoal ? " warn" : "")}>{note}</div>}
    </form>
  );
}
