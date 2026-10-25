// Builds everything the viewer needs from ./content into ./public:
//   public/content/**     processed Markdown, rendered D2 SVGs, copied assets
//   public/manifest.json  page metadata + navigation tree
//   public/search.json    plain-text documents for client-side search
//
// Conventions:
//   - `foo.md`        -> page route "foo";  `dir/index.md` -> route "dir"
//   - `foo.d2`        -> rendered to `foo.svg`; reference it as ![alt](foo.d2) or ![[foo.d2]]
//   - ```d2 fences    -> rendered at build time and replaced with an image
//   - files/dirs starting with "_" or "." are not published (use `_shared.d2` for D2 imports)
//   - frontmatter: title, tags, order (lower sorts first)

import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.CONTENT_DIR || path.join(ROOT, 'content'));
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'content');
const D2_ARGS = ['--theme', '0', '--dark-theme', '200', '--pad', '24'];
const STRICT = !!process.env.CI; // fail the build on D2 errors in CI, warn locally

const toPosix = (p) => p.split(path.sep).join('/');
const hidden = (name) => name.startsWith('.') || name.startsWith('_');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (hidden(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

function d2Available() {
  return spawnSync('d2', ['--version'], { stdio: 'ignore' }).status === 0;
}

function renderD2({ input, file, cwd, outFile, errors }) {
  const args = [...D2_ARGS, input ? '-' : file, outFile];
  const res = spawnSync('d2', args, { cwd, input, encoding: 'utf8' });
  if (res.status !== 0) {
    errors.push(`${path.relative(ROOT, file)}: ${(res.stderr || '').trim()}`);
    return false;
  }
  return true;
}

function gitUpdated(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      cwd: SRC,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function routeFor(relMd) {
  const noExt = relMd.replace(/\.md$/i, '');
  if (noExt === 'index') return '';
  return noExt.endsWith('/index') ? noExt.slice(0, -'/index'.length) : noExt;
}

function plainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)\|?([^\]]*)]]/g, (_, a, b) => b || a)
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function insertIntoTree(tree, route, page) {
  const parts = route === '' ? [] : route.split('/');
  let node = tree;
  for (let i = 0; i < parts.length; i++) {
    const isLeaf = i === parts.length - 1;
    let child = node.children.find((c) => c.name === parts[i]);
    if (!child) {
      child = { name: parts[i], route: null, title: parts[i], order: Infinity, children: [] };
      node.children.push(child);
    }
    if (isLeaf) {
      child.route = route;
      child.title = page.title;
      child.order = page.order;
    }
    node = child;
  }
  if (parts.length === 0) {
    tree.route = '';
    tree.title = page.title;
  }
}

function sortTree(node) {
  node.children.sort((a, b) => {
    const folder = (n) => (n.children.length ? 0 : 1);
    return folder(a) - folder(b) || a.order - b.order || a.title.localeCompare(b.title);
  });
  node.children.forEach(sortTree);
  if (node.order === Infinity) delete node.order;
  return node;
}

export async function buildContent({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const errors = [];
  const hasD2 = d2Available();
  if (!hasD2) console.warn('[content] d2 not found on PATH – diagrams will not be rendered');

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const files = existsSync(SRC) ? await walk(SRC) : [];
  const pages = {};
  const assets = [];
  const searchDocs = [];
  const tree = { name: '', route: null, title: 'Home', children: [] };
  let diagrams = 0;

  for (const file of files) {
    const rel = toPosix(path.relative(SRC, file));
    const dest = path.join(OUT, rel);
    await mkdir(path.dirname(dest), { recursive: true });

    if (/\.md$/i.test(rel)) {
      const raw = await readFile(file, 'utf8');
      const { data, content } = matter(raw);

      // Render ```d2 fences and replace them with images
      const body = content.replace(/^```d2[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (block, code) => {
        if (!hasD2) return block;
        const hash = createHash('sha1').update(code).digest('hex').slice(0, 12);
        const outFile = path.join(OUT, '_d2', `${hash}.svg`);
        mkdirSync(path.dirname(outFile), { recursive: true });
        const ok =
          existsSync(outFile) ||
          renderD2({ input: code, file, cwd: path.dirname(file), outFile, errors });
        if (ok) diagrams++;
        return ok ? `![diagram](/_d2/${hash}.svg)` : block;
      });

      const route = routeFor(rel);
      const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const title = String(data.title ?? h1 ?? path.basename(rel, '.md'));
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : data.tags ? [String(data.tags)] : [];
      const page = {
        title,
        file: rel,
        tags,
        order: Number.isFinite(data.order) ? data.order : Infinity,
        updated: gitUpdated(file),
      };

      await writeFile(dest, body);
      pages[route] = { ...page, order: undefined };
      insertIntoTree(tree, route, page);
      searchDocs.push({ id: route, title, tags: tags.join(' '), text: plainText(body) });
    } else if (/\.d2$/i.test(rel)) {
      if (!hasD2) continue;
      const outFile = dest.replace(/\.d2$/i, '.svg');
      if (renderD2({ file, cwd: path.dirname(file), outFile, errors })) {
        assets.push(rel);
        diagrams++;
      }
    } else {
      await copyFile(file, dest);
      assets.push(rel);
    }
  }

  const manifest = {
    generated: new Date().toISOString(),
    repo: process.env.GITHUB_REPOSITORY || process.env.WIKI_REPO || '',
    branch: process.env.WIKI_BRANCH || process.env.GITHUB_REF_NAME || 'main',
    contentDir: 'content',
    pages,
    assets,
    tree: sortTree(tree),
  };

  await writeFile(path.join(PUBLIC, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(PUBLIC, 'search.json'), JSON.stringify(searchDocs));

  for (const e of errors) console.error(`[content] d2 error: ${e}`);
  log(`[content] ${Object.keys(pages).length} pages, ${diagrams} diagrams, ${assets.length} assets`);
  if (errors.length && STRICT) throw new Error(`${errors.length} D2 diagram(s) failed to render`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildContent().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
