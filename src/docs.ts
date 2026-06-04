import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

const LINKS_DIR = path.join(DATA_DIR, 'links');

// Coordination-state sections (Tasks/Claims/Git) sit near the top so an agent sees who
// holds what and what's in flight on every read. They're rewritten wholesale from the DB
// (like Participants), so they stay bounded — only the append-only Log grows.
const SECTIONS = ['Participants', 'Tasks', 'Claims', 'Git', 'Context', 'Open questions', 'Answers', 'Decisions', 'Log'];

// Token discipline for the Log section: keep it bounded both on disk and in compact reads.
const LOG_KEEP = 12; // recent Log entries surfaced in a compact doc_read
const LOG_MAX = 60; // recent Log entries retained in context.md; older ones rotate to the archive

const now = () => new Date().toISOString();
const hhmm = () => new Date().toISOString().slice(11, 16);

// A bare `## ` line inside section content would be mis-read as a section boundary by
// sectionBounds, splitting the doc and corrupting every later section read/write. Demote
// any h2 in stored user content to h3 (deeper headings don't collide with the `^##\s` scan).
// Idempotent: "### x" no longer matches `^(##)(\s)`.
function neutralizeHeadings(text: string): string {
  return text.replace(/^(##)(\s)/gm, '#$1$2');
}

export function linkDir(linkId: string): string {
  return path.join(LINKS_DIR, linkId);
}

export function docPath(linkId: string): string {
  return path.join(linkDir(linkId), 'context.md');
}

export function archivePath(linkId: string): string {
  return path.join(linkDir(linkId), 'context.archive.md');
}

function template(linkId: string, title?: string): string {
  return (
    `# sonar · ${linkId}${title ? ` — ${title}` : ''}\n\n` +
    `_Shared working doc. Both agents read this and append context, questions, answers, and decisions.\n` +
    `It is the source of truth so you and the other agent (and your human) can follow along.\n` +
    `Edit by hand any time; agents use the sonar \`doc_*\` tools._\n\n` +
    SECTIONS.map((s) => `## ${s}\n`).join('\n') +
    '\n'
  );
}

export function ensureDoc(linkId: string, title?: string): string {
  const p = docPath(linkId);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(linkDir(linkId), { recursive: true });
    fs.writeFileSync(p, template(linkId, title));
  }
  return p;
}

// Locate a `## section` block within doc lines: returns the header index `start`
// and `end` (index of the next `## ` header or EOF). `start` is -1 if not found.
function sectionBounds(lines: string[], section: string): { start: number; end: number } {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && lines[i].replace(/^##\s+/, '').trim().toLowerCase() === section.trim().toLowerCase()) {
      start = i;
      break;
    }
  }
  if (start === -1) return { start: -1, end: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// Split a Log section body (the text between its header and the next header) into
// individual entries on blank-line boundaries. Empty/whitespace-only blocks dropped.
function splitLogEntries(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

export function readDoc(linkId: string, opts?: { section?: string; compact?: boolean; title?: string }): string {
  ensureDoc(linkId, opts?.title);
  const full = fs.readFileSync(docPath(linkId), 'utf8');

  // No options → full document (back-compat: the REST endpoint and menu-bar viewer rely on this).
  if (!opts || (!opts.section && !opts.compact)) return full;

  const lines = full.split('\n');

  // Section-scoped read: just that `## Section` block (header + body to next `## ` or EOF).
  if (opts.section) {
    const { start, end } = sectionBounds(lines, opts.section);
    if (start === -1) {
      const names = [...full.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
      return `(no section "${opts.section}"; sections: ${names.join(', ') || '(none)'})`;
    }
    return lines.slice(start, end).join('\n').trimEnd() + '\n';
  }

  // Compact read: everything as-is, except the Log is trimmed to its last LOG_KEEP entries.
  const { start, end } = sectionBounds(lines, 'Log');
  if (start === -1) return full; // no Log section → nothing to trim
  const body = lines.slice(start + 1, end).join('\n');
  const entries = splitLogEntries(body);
  if (entries.length <= LOG_KEEP) return full; // already small enough

  const omitted = entries.length - LOG_KEEP;
  const kept = entries.slice(entries.length - LOG_KEEP);
  const marker = `_(${omitted} older Log entries archived — read doc_read(section="Log") or open context.archive.md)_`;
  const newSection = [lines[start], '', marker, '', kept.join('\n\n'), ''];
  const out = [...lines.slice(0, start), ...newSection, ...lines.slice(end)];
  return out.join('\n');
}

export function listSections(linkId: string): string[] {
  const text = readDoc(linkId);
  return [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
}

// Bound the on-disk Log: if it holds more than LOG_MAX entries, move the oldest
// overflow out of context.md and append it to context.archive.md. Best-effort —
// must never throw or leave the live doc wrong (archive write is wrapped in try/catch).
function rotateLog(linkId: string) {
  const p = docPath(linkId);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const { start, end } = sectionBounds(lines, 'Log');
  if (start === -1) return;

  const body = lines.slice(start + 1, end).join('\n');
  const entries = splitLogEntries(body);
  if (entries.length <= LOG_MAX) return;

  const archived = entries.slice(0, entries.length - LOG_MAX);
  const kept = entries.slice(entries.length - LOG_MAX);

  // Append the overflow to the archive first; only rewrite the live doc if that succeeds,
  // so a failed archive write never silently drops Log history.
  try {
    const ap = archivePath(linkId);
    const header = `# sonar · ${linkId} — archived Log\n\n`;
    const prefix = fs.existsSync(ap) ? '' : header;
    fs.appendFileSync(ap, prefix + archived.join('\n\n') + '\n\n');
  } catch {
    return; // leave the live doc intact; we'll rotate again on the next append
  }

  const newSection = [lines[start], '', kept.join('\n\n'), ''];
  const out = [...lines.slice(0, start), ...newSection, ...lines.slice(end)];
  fs.writeFileSync(p, out.join('\n'));
}

/** Append a block of text to the end of a `## section` (creating the section if missing). */
export function appendToSection(linkId: string, section: string, text: string, from?: string): { path: string } {
  ensureDoc(linkId);
  const p = docPath(linkId);
  const lines = fs.readFileSync(p, 'utf8').split('\n');

  let safe = neutralizeHeadings(text.trim());
  // The Log is entry-counted by blank-line boundaries (splitLogEntries) for rotation/compaction;
  // collapse internal blank lines so a multi-paragraph note still counts as ONE Log entry.
  if (section.trim().toLowerCase() === 'log') safe = safe.replace(/\n\s*\n+/g, '\n');
  const entry = (from ? `> ${from} · ${hhmm()}\n` : '') + safe + '\n';

  // find the section header line
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && lines[i].replace(/^##\s+/, '').trim().toLowerCase() === section.trim().toLowerCase()) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    // append a new section at the end
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`## ${section}`, '', entry.trimEnd(), '');
  } else {
    // find end of section (next ## header or EOF)
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    // trim trailing blank lines within the section, then insert
    let insertAt = end;
    while (insertAt - 1 > start && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, '', entry.trimEnd());
  }

  fs.writeFileSync(p, lines.join('\n'));

  // Only the Log grows unboundedly (chat echoes, worker checkpoints) — rotate just that one.
  if (section.trim().toLowerCase() === 'log') rotateLog(linkId);

  return { path: p };
}

/** Replace the entire body of a `## section` (creating it if missing). */
export function setSection(linkId: string, section: string, text: string): { path: string } {
  ensureDoc(linkId);
  const p = docPath(linkId);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && lines[i].replace(/^##\s+/, '').trim().toLowerCase() === section.trim().toLowerCase()) {
      start = i;
      break;
    }
  }
  const body = ['', neutralizeHeadings(text.trim()), ''];
  if (start === -1) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`## ${section}`, ...body);
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    lines.splice(start + 1, end - (start + 1), ...body);
  }
  fs.writeFileSync(p, lines.join('\n'));
  return { path: p };
}

export function removeDoc(linkId: string) {
  fs.rmSync(linkDir(linkId), { recursive: true, force: true });
}

export function appendLog(linkId: string, from: string, text: string) {
  appendToSection(linkId, 'Log', `**${from}** · ${hhmm()} — ${text}`);
}
