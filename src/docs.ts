import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

const LINKS_DIR = path.join(DATA_DIR, 'links');

const SECTIONS = ['Participants', 'Context', 'Open questions', 'Answers', 'Decisions', 'Log'];

const now = () => new Date().toISOString();
const hhmm = () => new Date().toISOString().slice(11, 16);

export function linkDir(linkId: string): string {
  return path.join(LINKS_DIR, linkId);
}

export function docPath(linkId: string): string {
  return path.join(linkDir(linkId), 'context.md');
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

export function readDoc(linkId: string, title?: string): string {
  ensureDoc(linkId, title);
  return fs.readFileSync(docPath(linkId), 'utf8');
}

export function listSections(linkId: string): string[] {
  const text = readDoc(linkId);
  return [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
}

/** Append a block of text to the end of a `## section` (creating the section if missing). */
export function appendToSection(linkId: string, section: string, text: string, from?: string): { path: string } {
  ensureDoc(linkId);
  const p = docPath(linkId);
  const lines = fs.readFileSync(p, 'utf8').split('\n');

  const entry = (from ? `> ${from} · ${hhmm()}\n` : '') + text.trim() + '\n';

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
  const body = ['', text.trim(), ''];
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
