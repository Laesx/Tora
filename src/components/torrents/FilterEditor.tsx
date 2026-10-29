import React, { useEffect, useRef, useState } from "react";
import { Code2, ListFilter, Plus, Trash2 } from "lucide-react";
import { QueryOp, QueryRow } from "../../types";
import { toraApi } from "../../api";
import { fieldInfo, QUERY_FIELDS, rowsToQuery } from "../../torrents";

interface FilterEditorProps {
  value: string;
  onChange: (query: string) => void;
  /** Reports whether the current text parses */
  onValidity?: (error: string | null) => void;
  /** Group suggestions for `group` rows */
  groups?: string[];
  compact?: boolean;
}

const OPS: { id: QueryOp; label: string }[] = [
  { id: "is", label: "is" },
  { id: "ge", label: "≥" },
  { id: "gt", label: ">" },
  { id: "le", label: "≤" },
  { id: "lt", label: "<" },
];

const inputClass =
  "px-2.5 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent";

const emptyRow = (): QueryRow => ({ field: "group", op: "is", value: "", negate: false });

/** Edits one torrent query either as condition rows or as text; both write the same query string. */
export const FilterEditor: React.FC<FilterEditorProps> = ({ value, onChange, onValidity, groups = [], compact }) => {
  const [mode, setMode] = useState<"form" | "text">("form");
  const [text, setText] = useState(value);
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [any, setAny] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last query string this editor produced, so echoes of our own onChange don't re-parse
  const emitted = useRef<string | null>(null);
  const listId = useRef(`tora-groups-${Math.random().toString(36).slice(2)}`).current;

  const parse = async (q: string, updateRows: boolean) => {
    try {
      const parsed = await toraApi.parseTorrentQuery(q);
      setError(null);
      onValidity?.(null);
      if (updateRows) {
        setRows(parsed.rows.length ? parsed.rows : [emptyRow()]);
        setAny(parsed.any);
      }
    } catch (e) {
      setError(String(e));
      onValidity?.(String(e));
    }
  };

  useEffect(() => {
    if (value === emitted.current) return;
    setText(value);
    void parse(value, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (q: string) => {
    emitted.current = q;
    onChange(q);
  };

  const updateRows = (next: QueryRow[], nextAny = any) => {
    setRows(next);
    const q = rowsToQuery(next, nextAny);
    setText(q);
    emit(q);
    void parse(q, false);
  };

  const switchMode = (m: "form" | "text") => {
    if (m === "form") void parse(text, true);
    setMode(m);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5 bg-bg-primary p-0.5 rounded-lg border border-border-subtle">
          <button
            type="button"
            onClick={() => switchMode("form")}
            className={`px-2 py-1 rounded-md text-[11px] flex items-center gap-1 ${mode === "form" ? "bg-bg-tertiary text-text-primary" : "text-text-muted"}`}
          >
            <ListFilter className="w-3 h-3" /> Conditions
          </button>
          <button
            type="button"
            onClick={() => switchMode("text")}
            className={`px-2 py-1 rounded-md text-[11px] flex items-center gap-1 ${mode === "text" ? "bg-bg-tertiary text-text-primary" : "text-text-muted"}`}
          >
            <Code2 className="w-3 h-3" /> Text
          </button>
        </div>
        {mode === "form" && rows.length > 1 && (
          <select
            value={any ? "any" : "all"}
            onChange={(e) => {
              const nextAny = e.target.value === "any";
              setAny(nextAny);
              updateRows(rows, nextAny);
            }}
            className={inputClass}
          >
            <option value="all">Match all</option>
            <option value="any">Match any</option>
          </select>
        )}
        {mode === "form" && !compact && (
          <code className="text-[10px] text-text-muted truncate" title={text}>
            {text}
          </code>
        )}
      </div>

      {mode === "text" ? (
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            emit(e.target.value);
            void parse(e.target.value, false);
          }}
          spellCheck={false}
          placeholder='group:Judas res>=1080p -dub codec:hevc seeds>5'
          className={`${inputClass} w-full font-mono`}
        />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, i) => {
            const info = fieldInfo(row.field);
            const set = (patch: Partial<QueryRow>) => updateRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
            return (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <select
                  value={row.negate ? "not" : "is"}
                  onChange={(e) => set({ negate: e.target.value === "not" })}
                  className={`${inputClass} w-[70px]`}
                >
                  <option value="is">If</option>
                  <option value="not">Not</option>
                </select>
                <select
                  value={row.field}
                  onChange={(e) => {
                    const next = fieldInfo(e.target.value);
                    set({
                      field: next.id,
                      op: "is",
                      value: next.options ? next.options[0].value : "",
                    });
                  }}
                  className={`${inputClass} w-[150px]`}
                >
                  {QUERY_FIELDS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
                {info.kind === "number" && (
                  <select
                    value={row.op}
                    onChange={(e) => set({ op: e.target.value as QueryOp })}
                    className={`${inputClass} w-[56px]`}
                  >
                    {OPS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                {info.options ? (
                  <select value={row.value} onChange={(e) => set({ value: e.target.value })} className={`${inputClass} w-[140px]`}>
                    {info.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={row.value}
                    onChange={(e) => set({ value: e.target.value })}
                    placeholder={info.placeholder}
                    list={row.field === "group" ? listId : undefined}
                    spellCheck={false}
                    className={`${inputClass} flex-1 min-w-[120px]`}
                  />
                )}
                <button
                  type="button"
                  onClick={() => updateRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [emptyRow()])}
                  className="p-1.5 rounded-lg text-text-muted hover:text-red-400 hover:bg-red-500/10"
                  title="Remove condition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setRows([...rows, emptyRow()])}
            className="flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <Plus className="w-3 h-3" /> Add condition
          </button>
          <datalist id={listId}>
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      )}
      {error && <div className="text-[11px] text-red-400">{error}</div>}
    </div>
  );
};
