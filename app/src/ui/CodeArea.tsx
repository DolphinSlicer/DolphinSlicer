// A G-code text box with syntax highlighting: a colored copy of the text under a transparent textarea.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useRef } from 'react';

type Kind = 'cmd' | 'macro' | 'param' | 'var' | 'comment' | 'kw';

/** Placeholders and expressions of OrcaSlicer's G-code macros, e.g. [layer_z] or {if x}…{endif}. */
function placeholderEnd(line: string, i: number): number {
  const close = line[i] === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i; j < line.length; j++) {
    if (line[j] === line[i]) depth++;
    else if (line[j] === close && --depth === 0) return j + 1;
  }
  return line.length;
}

/** Splits one line into colored runs. */
export function tokenizeLine(line: string): [text: string, kind: Kind | null][] {
  const out: [string, Kind | null][] = [];
  const push = (text: string, kind: Kind | null) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[1] === kind) last[0] += text;
    else out.push([text, kind]);
  };
  let i = 0;
  let first = true; // the next word is the command
  while (i < line.length) {
    const c = line[i]!;
    if (c === ';') {
      push(line.slice(i), 'comment');
      break;
    }
    if (c === '[' || c === '{') {
      const end = placeholderEnd(line, i);
      const text = line.slice(i, end);
      push(text, 'var');
      // A command can follow {if …}, {else} or {endif} on the same line.
      if (!/^\{\s*(if|elsif|else|endif|unless)\b/.test(text)) first = false;
      i = end;
      continue;
    }
    if (/\s/.test(c)) {
      push(c, null);
      i++;
      continue;
    }
    const word = /^[^\s;[{]+/.exec(line.slice(i))![0];
    if (first) {
      push(word, /^[GMT]\d+(\.\d+)?$/i.test(word) ? 'cmd' : 'macro');
      first = false;
    } else {
      // X10, S[temp], or KEY=value (Klipper macros)
      const m = /^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/.exec(word) ?? /^([A-Za-z])(.*)$/.exec(word);
      if (m) {
        push(m[1]!, 'param');
        push(m[2]!, null);
      } else push(word, null);
    }
    i += word.length;
  }
  return out;
}

function highlight(text: string): ReactNode[] {
  return text.split('\n').flatMap((line, n) => [
    ...(n ? ['\n'] : []),
    ...tokenizeLine(line).map(([s, k], i) =>
      k ? (
        <span key={`${n}.${i}`} className={`hl-${k}`}>
          {s}
        </span>
      ) : (
        s
      ),
    ),
  ]);
}

export function CodeArea({
  value,
  onChange,
  onBlur,
  rows,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  rows: number;
}) {
  const under = useRef<HTMLPreElement>(null);
  return (
    <div className="code-area">
      {/* The trailing space keeps the last empty line as tall as in the textarea. */}
      <pre ref={under} aria-hidden="true">
        {highlight(value)}{' '}
      </pre>
      <textarea
        className="code"
        rows={rows}
        value={value}
        spellCheck={false}
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onScroll={(e) => {
          if (under.current) {
            under.current.scrollTop = e.currentTarget.scrollTop;
            under.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
      />
    </div>
  );
}
