#!/usr/bin/env node
/**
 * Markdown link checker — relative file links and heading anchors only, no network.
 *
 * Checks, across every tracked `.md` file in the repo:
 *   - inline links `[text](./path/to.md#anchor)` and images `![alt](path.png)`
 *   - reference definitions `[label]: ./path/to.md#anchor`
 *   - reference usages `[text][label]` / `[label][]` resolve to a definition
 *   - same-file anchors `[text](#anchor)`
 *
 * Absolute URLs (`https:`, `mailto:`, …) are skipped deliberately: this check must stay
 * offline and deterministic. Fenced and inline code spans are ignored so snippets can't
 * produce phantom links.
 *
 * Usage: node scripts/check-md-links.mjs [rootDir]
 * Exit codes: 0 = every link resolves, 1 = at least one broken link.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "coverage",
  ".expo",
  ".turbo",
  "Pods",
  "android",
  "ios",
]);

/** Schemes that are out of scope for an offline checker. */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Package READMEs published to npm must link to docs by absolute URL — a relative `../../docs/…`
 * 404s on npmjs.com, which renders the README outside the repo tree. Those URLs still name files
 * in THIS repository, so rewrite them back to repo-relative paths and check them like any other
 * link; nothing is fetched.
 */
const SELF_BLOB =
  /^https:\/\/github\.com\/callstackincubator\/cordierite\/blob\/main\/(.+)$/i;

/** Repo-relative form of a self-referencing blob URL, or null if it is a genuinely external one. */
function selfRelative(url) {
  const match = SELF_BLOB.exec(url);
  return match ? match[1] : null;
}

/** Collect every `.md` file under `dir`, skipping generated/vendored trees. */
function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collectMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out fenced code blocks and, unless `inline` is false, inline code spans — preserving
 * line/column offsets so reported line numbers stay accurate. Heading extraction keeps inline
 * spans, since `## \`CORDIERITE_ENABLED\`` is a real heading whose text is entirely code.
 */
function maskCode(source, { inline = true } = {}) {
  const lines = source.split("\n");
  let fence = null;
  return lines
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
          fence = null;
        }
        return " ".repeat(line.length);
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        return " ".repeat(line.length);
      }
      return inline ? line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length)) : line;
    })
    .join("\n");
}

/**
 * GitHub's heading-slug rules: strip markdown emphasis/links, drop everything that is not a
 * word character, space or hyphen, lowercase, spaces to hyphens, then `-1`, `-2`, … for
 * repeated slugs within one document.
 */
function slugify(headingText) {
  // Code spans render literally, so their contents must survive emphasis stripping:
  // `## \`CORDIERITE_ENABLED\`` slugs to `cordierite_enabled`, underscore intact.
  const codeSpans = [];
  let plain = headingText.replace(/`([^`]*)`/g, (_match, inner) => {
    codeSpans.push(inner);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  plain = plain
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/__?([^_]+)__?/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_match, index) => codeSpans[Number(index)])
    .trim();
  return plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    // One hyphen per space, not per run — GitHub keeps the gap left by removed punctuation.
    .replace(/\s/g, "-");
}

/** Every anchor a GitHub-rendered version of this file would expose. */
function anchorsOf(source) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of maskCode(source, { inline: false }).split("\n")) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = slugify(heading[2]);
    if (!base) continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  // Explicit anchors authored as HTML, e.g. `<a id="foo"></a>`.
  for (const match of source.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) {
    anchors.add(match[1].toLowerCase());
  }
  return anchors;
}

const files = collectMarkdown(ROOT).sort();
const anchorCache = new Map();

function anchorsForFile(path) {
  if (!anchorCache.has(path)) {
    try {
      anchorCache.set(path, anchorsOf(readFileSync(path, "utf8")));
    } catch {
      anchorCache.set(path, null);
    }
  }
  return anchorCache.get(path);
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const problems = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const masked = maskCode(source);
  const here = dirname(file);
  const rel = relative(ROOT, file);

  const definitions = new Map();
  for (const match of masked.matchAll(/^[ \t]{0,3}\[([^\]^][^\]]*)\]:[ \t]*(\S+)/gm)) {
    definitions.set(match[1].trim().toLowerCase(), {
      target: match[2],
      index: match.index,
    });
  }

  /** @type {{target: string, index: number}[]} */
  const targets = [];

  // Inline links and images: [text](target) / ![alt](target). Nested parens in the label are
  // tolerated; the destination itself may be wrapped in <>.
  for (const match of masked.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^()\s]*)(?:\s+"[^"]*")?\s*\)/g)) {
    targets.push({ target: match[1].replace(/^<|>$/g, ""), index: match.index });
  }

  // Reference definitions.
  for (const [, def] of definitions) {
    targets.push(def);
  }

  // Reference usages must point at a definition that exists.
  for (const match of masked.matchAll(/(?<!\!)\[((?:[^\]\\]|\\.)+)\]\[((?:[^\]\\]|\\.)*)\]/g)) {
    const label = (match[2].trim() || match[1].trim()).toLowerCase();
    if (!definitions.has(label)) {
      problems.push(`${rel}:${lineOf(source, match.index)}  undefined link reference [${label}]`);
    }
  }

  for (const { target, index } of targets) {
    let raw = target.trim();
    // A link into this repo's own tree is checkable even when written absolutely.
    const selfPath = selfRelative(raw);
    let base = here;
    if (selfPath !== null) {
      raw = selfPath;
      base = ROOT;
    } else if (!raw || EXTERNAL.test(raw)) {
      continue;
    }
    if (!raw) continue;

    const line = lineOf(source, index);
    const hashAt = raw.indexOf("#");
    const pathPart = hashAt === -1 ? raw : raw.slice(0, hashAt);
    const anchor = hashAt === -1 ? "" : decodeURIComponent(raw.slice(hashAt + 1)).toLowerCase();

    let targetPath = file;
    if (pathPart) {
      targetPath = resolve(base, decodeURIComponent(pathPart));
      let stats;
      try {
        stats = statSync(targetPath);
      } catch {
        problems.push(`${rel}:${line}  missing target: ${raw}`);
        continue;
      }
      if (stats.isDirectory()) {
        // A directory link is fine on its own; only a README inside it can carry an anchor.
        if (!anchor) continue;
        targetPath = join(targetPath, "README.md");
        try {
          statSync(targetPath);
        } catch {
          problems.push(`${rel}:${line}  anchor on a directory without README.md: ${raw}`);
          continue;
        }
      }
    }

    if (!anchor) continue;
    if (!targetPath.endsWith(".md")) continue;

    const anchors = anchorsForFile(targetPath);
    if (!anchors) {
      problems.push(`${rel}:${line}  unreadable target: ${raw}`);
    } else if (!anchors.has(anchor)) {
      problems.push(
        `${rel}:${line}  missing anchor "#${anchor}" in ${relative(ROOT, targetPath).split(sep).join("/")}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`Broken Markdown links (${problems.length}):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(`check:links — ${files.length} Markdown files, no broken relative links or anchors.`);
