// Minimal, non-executing shell command-line tokenizer.
// parseCommandLine(src, {cwd}) -> {ok, commands: [{argv, env, cwd, stdin, raw}]}
import path from 'node:path';

class ParseError extends Error {}

const STOP = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', '{', '}', '!', 'time', 'if', 'while', 'until', 'fi', 'done', 'esac']);
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseCommandLine(src, opts = {}) {
  try {
    return { ok: true, commands: parseScript(String(src), opts.cwd) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, commands: [] };
    throw e;
  }
}

function resolveCwd(base, target) {
  if (path.isAbsolute(target) || !base) return target;
  return path.resolve(base, target);
}

// Index of the ')' matching an already-consumed '(' (depth 1 at `from`).
function findSubstEnd(src, from) {
  const n = src.length;
  let depth = 1;
  let j = from;
  const pending = [];
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") {
      const e = src.indexOf("'", j + 1);
      if (e < 0) throw new ParseError('unterminated quote');
      j = e + 1; continue;
    }
    if (c === '"') {
      j++;
      for (;;) {
        if (j >= n) throw new ParseError('unterminated quote');
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '(') { j = findSubstEnd(src, j + 2) + 1; continue; }
        j++;
      }
      continue;
    }
    if (c === '`') {
      j++;
      while (j < n && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      if (j >= n) throw new ParseError('unterminated backtick');
      j++; continue;
    }
    if (c === '<' && src[j + 1] === '<' && src[j + 2] === '<') { j += 3; continue; }
    if (c === '<' && src[j + 1] === '<') {
      j += 2;
      let strip = false;
      if (src[j] === '-') { strip = true; j++; }
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      while (j < n && !STOP.has(src[j])) {
        const ch = src[j];
        if (ch === "'" || ch === '"') {
          const e = src.indexOf(ch, j + 1);
          if (e < 0) throw new ParseError('unterminated quote');
          delim += src.slice(j + 1, e); j = e + 1;
        } else if (ch === '\\') { delim += src[j + 1] ?? ''; j += 2; }
        else { delim += ch; j++; }
      }
      pending.push({ delim, strip });
      continue;
    }
    if (c === '\n' && pending.length) {
      j++;
      for (const { delim, strip } of pending) {
        for (;;) {
          if (j >= n) throw new ParseError('unterminated heredoc');
          let e = src.indexOf('\n', j);
          if (e < 0) e = n;
          const line = src.slice(j, e);
          j = Math.min(e + 1, n);
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      pending.length = 0;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
    j++;
  }
  throw new ParseError('unterminated substitution');
}

function parseScript(src, startCwd) {
  const n = src.length;
  const commands = [];
  const pending = [];
  let i = 0;
  let cwd = startCwd;
  let cur = null;
  let curStart = 0;
  let timeOpts = false;
  const cwdStack = [];

  const ensure = () => {
    if (!cur) {
      cur = { argv: [], env: {}, cwd: undefined, stdin: undefined, raw: '' };
      curStart = i;
    }
    return cur;
  };

  const flush = (end) => {
    if (cur && cur.argv.length) {
      cur.cwd = cwd;
      cur.raw = src.slice(curStart, end).trim();
      commands.push(cur);
      if (cur.argv[0] === 'cd' && cur.argv.length > 1 && cur.argv[1] !== '-') {
        cwd = cur.argv[1] === '' ? undefined : resolveCwd(cwd, cur.argv[1]);
      }
    }
    cur = null;
    timeOpts = false;
  };

  const substValue = (inner) => {
    const sub = parseScript(inner, cwd);
    commands.push(...sub);
    const first = sub[0];
    if (first && first.argv[0] === 'cat' && first.stdin !== undefined) {
      return first.stdin.replace(/\n+$/, '');
    }
    return '';
  };

  // At src[i] === '$' && src[i+1] === '('.
  const readDollarParen = () => {
    const end = findSubstEnd(src, i + 2);
    if (src[i + 2] === '(') { i = end + 1; return ''; } // arithmetic
    const inner = src.slice(i + 2, end);
    i = end + 1;
    return substValue(inner);
  };

  const readBacktick = () => {
    let j = i + 1;
    let inner = '';
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\' && j + 1 < n) { inner += src[j + 1]; j += 2; }
      else inner += src[j++];
    }
    if (j >= n) throw new ParseError('unterminated backtick');
    i = j + 1;
    return substValue(inner);
  };

  const readWord = () => {
    let out = '';
    let quoted = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        if (i + 1 >= n) { i++; break; }
        if (src[i + 1] !== '\n') { out += src[i + 1]; quoted = true; }
        i += 2; continue;
      }
      if (c === "'") {
        const e = src.indexOf("'", i + 1);
        if (e < 0) throw new ParseError('unterminated quote');
        out += src.slice(i + 1, e); i = e + 1; quoted = true; continue;
      }
      if (c === '"') {
        quoted = true; i++;
        for (;;) {
          if (i >= n) throw new ParseError('unterminated quote');
          const d = src[i];
          if (d === '"') { i++; break; }
          if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
            if (src[i + 1] !== '\n') out += src[i + 1];
            i += 2; continue;
          }
          if (d === '$' && src[i + 1] === '(') { out += readDollarParen(); continue; }
          if (d === '`') { out += readBacktick(); continue; }
          out += d; i++;
        }
        continue;
      }
      if (c === '$' && src[i + 1] === "'") {
        let j = i + 2;
        const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
        for (;;) {
          if (j >= n) throw new ParseError('unterminated quote');
          if (src[j] === "'") break;
          if (src[j] === '\\' && j + 1 < n) { out += map[src[j + 1]] ?? src[j + 1]; j += 2; }
          else out += src[j++];
        }
        i = j + 1; quoted = true; continue;
      }
      if (c === '$' && src[i + 1] === '(') { out += readDollarParen(); continue; }
      if (c === '`') { out += readBacktick(); continue; }
      if (STOP.has(c)) break;
      out += c; i++;
    }
    return { value: out, quoted };
  };

  const skipBlanks = () => { while (src[i] === ' ' || src[i] === '\t') i++; };

  const readHeredocBody = (delim, strip) => {
    const lines = [];
    for (;;) {
      if (i >= n) throw new ParseError('unterminated heredoc');
      let e = src.indexOf('\n', i);
      if (e < 0) e = n;
      const line = src.slice(i, e);
      i = Math.min(e + 1, n);
      const cmp = strip ? line.replace(/^\t+/, '') : line;
      if (cmp === delim) return lines.length ? lines.join('\n') + '\n' : '';
      lines.push(cmp);
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      flush(i); i++;
      for (const p of pending) p.cmd.stdin = readHeredocBody(p.delim, p.strip);
      pending.length = 0;
      continue;
    }
    if (c === '(') { flush(i); cwdStack.push(cwd); i++; continue; }
    if (c === ')') { flush(i); if (cwdStack.length) cwd = cwdStack.pop(); i++; continue; }
    if (c === ';') { flush(i); i++; continue; }
    if (c === '&' && src[i + 1] !== '>') { flush(i); i += src[i + 1] === '&' ? 2 : 1; continue; }
    if (c === '|') { flush(i); i += src[i + 1] === '|' || src[i + 1] === '&' ? 2 : 1; continue; }
    if (c >= '0' && c <= '9') {
      const m = /^\d+(?=[<>])/.exec(src.slice(i, i + 12));
      if (m) { i += m[0].length; continue; }
    }
    if (c === '&' || c === '<' || c === '>') {
      if (c === '<' && src.startsWith('<<<', i)) {
        i += 3; skipBlanks();
        const cmd = ensure();
        cmd.stdin = readWord().value + '\n';
        continue;
      }
      if (c === '<' && src[i + 1] === '<') {
        i += 2;
        let strip = false;
        if (src[i] === '-') { strip = true; i++; }
        skipBlanks();
        const cmd = ensure();
        pending.push({ cmd, delim: readWord().value, strip });
        continue;
      }
      i++;
      while (src[i] === '>' || src[i] === '<' || src[i] === '|' || src[i] === '&') i++;
      skipBlanks();
      ensure();
      readWord();
      continue;
    }
    const cmd = ensure();
    const start = i;
    const { value, quoted } = readWord();
    if (!cmd.argv.length && ENV_RE.test(src.slice(start))) {
      const name = ENV_RE.exec(src.slice(start))[0].slice(0, -1);
      cmd.env[name] = value.slice(name.length + 1);
    } else if (!cmd.argv.length && !quoted && KEYWORDS.has(value)) {
      timeOpts = value === 'time';
    } else if (!cmd.argv.length && timeOpts && !quoted && value.startsWith('-')) {
      // option of `time` (e.g. -p)
    } else if (value !== '' || quoted) {
      cmd.argv.push(value);
    }
  }
  flush(n);
  return commands;
}
