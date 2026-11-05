import React, { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { dateFieldPlaceholder, formatDateField, parseDateField } from "@/lib/dates";

/** Calendar arrow keys can change the value several times before the popup closes. */
const CALENDAR_COMMIT_DELAY_MS = 600;

interface DateInputProps {
  /** `YYYY-MM-DD`, or empty */
  value: string;
  /** Whenever the text is a real date or empty, so half-typed text never reaches the caller */
  onChange: (iso: string) => void;
  /** The user finished: left the field, pressed Enter or picked in the calendar */
  onCommit?: (iso: string) => void;
  /** The field's classes (borders, colors); the calendar button is placed inside it */
  className?: string;
}

/**
 * A date field in the format chosen in Settings. `<input type="date">` always follows the webview's
 * language, so it's a text field, with a hidden native input only for its calendar popup (the popup
 * itself stays in the webview's language).
 */
export const DateInput: React.FC<DateInputProps> = ({ value, onChange, onCommit, className = "" }) => {
  const shown = formatDateField(value);
  const [text, setText] = useState(shown);
  const focusedRef = useRef(false);
  const valueAtFocusRef = useRef(value);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!focusedRef.current) setText(shown);
  }, [shown]);

  // A pending calendar commit is dropped on unmount: the caller already has the value from `onChange`
  useEffect(
    () => () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    },
    []
  );

  const handleTextChange = (next: string) => {
    setText(next);
    const iso = parseDateField(next);
    if (iso !== null && iso !== value) onChange(iso);
  };

  const handleBlur = () => {
    focusedRef.current = false;
    // Text that isn't a date goes back to what the field had before this edit
    const iso = parseDateField(text) ?? valueAtFocusRef.current;
    if (iso !== value) onChange(iso);
    setText(formatDateField(iso));
    onCommit?.(iso);
  };

  const handleCalendarChange = (iso: string) => {
    onChange(iso);
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      onCommit?.(iso);
    }, CALENDAR_COMMIT_DELAY_MS);
  };

  return (
    <div className="relative w-full min-w-0">
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={dateFieldPlaceholder()}
        onFocus={() => {
          focusedRef.current = true;
          valueAtFocusRef.current = value;
        }}
        onChange={(e) => handleTextChange(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={`${className} pr-7`}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => pickerRef.current?.showPicker()}
        title="Pick a date"
        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-text-primary transition"
      >
        <CalendarDays className="w-3.5 h-3.5" />
      </button>
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value}
        onChange={(e) => handleCalendarChange(e.target.value)}
        className="absolute right-0 bottom-0 w-0 h-0 opacity-0 pointer-events-none"
      />
    </div>
  );
};
