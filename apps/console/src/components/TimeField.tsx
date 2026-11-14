import { useEffect, useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A time of day, typed. The partner of <DateField>: the browser's own time
 * control looks like a different product on every platform and reads in
 * the machine's locale ("09:00 AM"), where the console writes 24-hour
 * times everywhere else ("Every day at 09:00").
 *
 *   <Field label="Time">
 *     <TimeField value={time} onChange={setTime} />
 *   </Field>
 *
 * The value is `HH:MM`, the string a native time input holds, so it drops
 * in where one was. Typing is forgiving ("9", "9:5", "0930", "9.30", "9pm")
 * and is tidied when the field is left. Something that is not a time is
 * not taken: the field goes back to what it held and says why under it.
 * Up and down arrows step by a quarter of an hour.
 */

/** "9:5" → "09:05", "0930" → "09:30", "9pm" → "21:00"; null when it is not a time of day. */
export function readTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.h]?(\d{2}))?\s*(am|pm|a|p)?\s*$/i.exec(text) ?? /^\s*(\d{1,2})[:.](\d)\s*(am|pm|a|p)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  const half = m[3]?.toLowerCase();
  if (half) {
    if (h < 1 || h > 12) return null;
    if (half.startsWith("p") && h < 12) h += 12;
    if (half.startsWith("a") && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function step(value: string, minutes: number): string {
  const [h, m] = (readTime(value) ?? "09:00").split(":").map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  // Land on the quarter hour in the direction of travel.
  const snapped = minutes > 0 ? Math.floor(total / 15) * 15 : Math.ceil(total / 15) * 15;
  return `${String(Math.floor((snapped % 1440) / 60)).padStart(2, "0")}:${String(snapped % 60).padStart(2, "0")}`;
}

export function TimeField({
  value,
  onChange,
  placeholder = "09:00",
  disabled,
  className,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
}: {
  /** `HH:MM` (24-hour), or "" for none. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const shown = value.slice(0, 5);
  // What is being typed, while it is being typed. null: show the value.
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const problemId = useId();
  // A value changed from outside replaces whatever was half typed.
  useEffect(() => setDraft(null), [shown]);

  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text === "") {
      setProblem("");
      if (value !== "") onChange("");
      return;
    }
    const read = readTime(text);
    if (!read) {
      setProblem(`“${text}” is not a time of day. Write it like 09:00 or 17:30.`);
      return;
    }
    setProblem("");
    if (read !== shown) onChange(read);
  };

  return (
    <>
      <Input
        id={id}
        value={draft ?? shown}
        onChange={(e) => {
          setDraft(e.target.value);
          if (problem) setProblem("");
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Tidy what was typed; the form's own Enter still goes through.
            commit();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setDraft(null);
            setProblem("");
            onChange(step(draft ?? shown, e.key === "ArrowUp" ? 15 : -15));
          }
        }}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-invalid={invalid || problem !== "" || undefined}
        aria-describedby={[describedBy, problem ? problemId : null].filter(Boolean).join(" ") || undefined}
        className={cn("tabular-nums", className)}
      />
      {problem && (
        <p id={problemId} role="alert" className="mt-1.5 text-xs text-danger">
          {problem}
        </p>
      )}
    </>
  );
}
