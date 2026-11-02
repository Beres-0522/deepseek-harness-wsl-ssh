// Minimal glob matcher supporting **, *, ?, [abc], [a-z] and {a,b}.

function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const body = pattern.slice(open + 1, close);
  const parts = splitTopLevel(body);
  const out = [];
  for (const part of parts) {
    for (const t of expandBraces(head + part + tail)) out.push(t);
  }
  return out;
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function classToRegex(text, i) {
  // text[i] === '['; find closing ']'
  let j = i + 1;
  let body = "";
  if (text[j] === "!" || text[j] === "^") {
    body += "^";
    j++;
  }
  let first = true;
  while (j < text.length && (text[j] !== "]" || first)) {
    if (text[j] === "\\") {
      j++;
      body += text[j] ?? "";
      j++;
    } else {
      body += text[j].replace(/[\\\]]/g, "\\$&");
      j++;
    }
    first = false;
  }
  if (j >= text.length) return { regex: "\\[", next: i + 1 }; // unmatched -> literal
  return { regex: `[${body}]`, next: j + 1 };
}

function globSegmentToRegex(segment) {
  let re = "";
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      const parsed = classToRegex(segment, i);
      re += parsed.regex;
      i = parsed.next;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return re;
}

export function globToRegExp(pattern) {
  const segments = expandBraces(pattern);
  const regexes = segments.map((seg) => {
    let re = "^";
    const parts = seg.split("/");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === "**") {
        if (i === parts.length - 1) re += ".*";
        else re += "(?:[^/]+/)*";
      } else {
        re += globSegmentToRegex(part);
        if (i < parts.length - 1) re += "/";
      }
    }
    return new RegExp(`${re}$`);
  });
  return (rel) => regexes.some((rx) => rx.test(rel));
}

export function globHasDoubleStar(pattern) {
  return expandBraces(pattern).some((p) => p.split("/").some((s) => s === "**"));
}

export function globDepth(pattern) {
  // Depth of deepest literal directory segment (for find -maxdepth optimization).
  const parts = expandBraces(pattern)[0].split("/").filter(Boolean);
  return Math.max(parts.length, 1);
}
