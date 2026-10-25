import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import hljs from 'highlight.js/lib/common';
import MiniSearch from 'minisearch';
import 'highlight.js/styles/github-dark.css';
import './style.css';

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const el = {
  sidebar: $('.sidebar'),
  article: $('.markdown'),
  meta: $('.page-meta'),
  toc: $('.toc'),
  navToggle: $('.nav-toggle'),
  searchBtn: $('.search-btn'),
  dialog: $('.search-dialog'),
  input: $('.search-input'),
  results: $('.search-results'),
};

// ---------- state ----------
let manifest;
let search;
let searchDocs = new Map();
let currentRoute = null;
const mdCache = new Map();

// ---------- path helpers ----------
const isExternal = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const contentUrl = (p) => `${manifest.contentDir}/${p.split('/').map(encodeURIComponent).join('/')}`;

function normalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function resolveRel(fromDir, href) {
  const clean = decodeURIComponent(href);
  return clean.startsWith('/') ? normalize(clean) : normalize(`${fromDir}/${clean}`);
}

function routeForFile(p) {
  const noExt = p.replace(/\.md$/i, '');
  if (noExt === 'index') return '';
  return noExt.endsWith('/index') ? noExt.slice(0, -6) : noExt;
}

function splitHash(href) {
  const i = href.indexOf('#');
  return i < 0 ? [href, ''] : [href.slice(0, i), href.slice(i + 1)];
}

const slugify = (s) =>
  String(s).trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

const pageHref = (route, heading = '') => `#/${route}${heading ? `#${heading}` : ''}`;

// Resolve a [[wikilink]] target by route, last path segment, or title.
function findPageByName(name) {
  const n = name.trim().replace(/\.md$/i, '').toLowerCase();
  const routes = Object.keys(manifest.pages);
  return (
    routes.find((r) => r.toLowerCase() === n) ??
    routes.find((r) => basename(r).toLowerCase() === n) ??
    routes.find((r) => manifest.pages[r].title.toLowerCase() === n)
  );
}

function findAssetByName(name) {
  const n = name.trim().toLowerCase();
  return manifest.assets.find((a) => a.toLowerCase() === n || basename(a).toLowerCase() === n);
}

// ---------- markdown ----------
function wikilinks(md) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const { src, pos } = state;
    const embed = src.charCodeAt(pos) === 0x21 && src.startsWith('[[', pos + 1);
    const start = embed ? pos + 1 : pos;
    if (!src.startsWith('[[', start)) return false;
    const end = src.indexOf(']]', start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner || inner.includes('\n')) return false;
    if (!silent) {
      const [target, label] = inner.split('|');
      const text = (label ?? target).trim();
      if (embed) {
        const token = state.push('image', 'img', 0);
        token.attrs = [['src', `wiki:${target.trim()}`], ['alt', text]];
        const child = new state.Token('text', '', 0);
        child.content = text;
        token.children = [child];
        token.content = text;
      } else {
        state.push('link_open', 'a', 1).attrs = [['href', `wiki:${target.trim()}`]];
        state.push('text', '', 0).content = text;
        state.push('link_close', 'a', -1);
      }
    }
    state.pos = end + 2;
    return true;
  });
}

const md = new MarkdownIt({
  html: false, // raw HTML in notes is not rendered (keeps innerHTML safe)
  linkify: true,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    const html = language
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : md.utils.escapeHtml(code);
    const cls = language ? ` language-${md.utils.escapeHtml(language)}` : '';
    return `<pre><code class="hljs${cls}">${html}</code></pre>`;
  },
})
  .use(wikilinks)
  .use(anchor, {
    slugify,
    level: [2, 3, 4],
    permalink: anchor.permalink.linkInsideHeader({
      symbol: '#',
      placement: 'after',
      ariaHidden: true,
      class: 'header-anchor',
    }),
  });

// Rewrite links and images in rendered HTML so they work inside the viewer.
function postProcess(root, page, route) {
  const dir = dirname(page.file);

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('wiki:')) {
      const [name, heading] = splitHash(href.slice(5));
      const target = name ? findPageByName(name) : route;
      if (target !== undefined) a.href = pageHref(target, heading && slugify(heading));
      else a.classList.add('broken');
      continue;
    }
    if (href.startsWith('#')) {
      a.href = pageHref(route, href.slice(1));
      continue;
    }
    if (isExternal(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      continue;
    }
    const [pathPart, heading] = splitHash(href);
    const resolved = resolveRel(dir, pathPart).replace(/\/$/, '');
    const asRoute = /\.md$/i.test(resolved) ? routeForFile(resolved) : resolved;
    if (asRoute in manifest.pages) a.href = pageHref(asRoute, heading);
    else if (manifest.assets.includes(resolved)) a.href = contentUrl(resolved.replace(/\.d2$/i, '.svg'));
    else a.classList.add('broken');
  }

  for (const img of root.querySelectorAll('img[src]')) {
    let src = img.getAttribute('src');
    if (isExternal(src) && !src.startsWith('wiki:')) continue;
    let resolved;
    if (src.startsWith('wiki:')) {
      resolved = findAssetByName(src.slice(5));
      if (!resolved) {
        img.replaceWith(Object.assign(document.createElement('span'), {
          className: 'broken', textContent: `missing: ${src.slice(5)}`,
        }));
        continue;
      }
    } else {
      resolved = resolveRel(dir, src);
    }
    const isDiagram = /\.d2$/i.test(resolved) || resolved.startsWith('_d2/');
    const url = contentUrl(resolved.replace(/\.d2$/i, '.svg'));
    img.src = url;
    img.loading = 'lazy';
    if (isDiagram) {
      img.classList.add('diagram');
      const link = Object.assign(document.createElement('a'), {
        href: url, target: '_blank', rel: 'noopener', className: 'diagram-link', title: 'Open full size',
      });
      img.replaceWith(link);
      link.append(img);
    }
  }

  for (const pre of root.querySelectorAll('pre')) {
    const btn = Object.assign(document.createElement('button'), {
      className: 'copy-btn', type: 'button', textContent: 'Copy',
    });
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? '');
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
    pre.append(btn);
  }
}

// ---------- navigation tree ----------
function renderTree() {
  const nav = el.sidebar;
  nav.replaceChildren();
  const ul = document.createElement('ul');
  if (manifest.tree.route !== null) ul.append(treeItem({ ...manifest.tree, children: [] }, ''));
  for (const child of manifest.tree.children) ul.append(treeItem(child, child.name));
  nav.append(ul);
}

function treeItem(node, path) {
  const li = document.createElement('li');
  const link = (text) => {
    if (node.route === null) return Object.assign(document.createElement('span'), { textContent: text });
    return Object.assign(document.createElement('a'), {
      href: pageHref(node.route), textContent: text, className: 'nav-link',
    });
  };
  if (!node.children.length) {
    const a = link(node.title);
    a.dataset.route = node.route ?? '';
    li.append(a);
    return li;
  }
  const details = document.createElement('details');
  details.dataset.path = path;
  const summary = document.createElement('summary');
  const a = link(node.title);
  if (node.route !== null) a.dataset.route = node.route;
  summary.append(a);
  details.append(summary);
  const ul = document.createElement('ul');
  for (const child of node.children) ul.append(treeItem(child, `${path}/${child.name}`));
  details.append(ul);
  li.append(details);
  return li;
}

function markActive(route) {
  for (const a of el.sidebar.querySelectorAll('[data-route]')) {
    const active = a.dataset.route === route;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  for (const d of el.sidebar.querySelectorAll('details')) {
    const p = d.dataset.path;
    if (route === p || route.startsWith(`${p}/`)) d.open = true;
  }
}

// ---------- page ----------
function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [route, heading] = splitHash(raw);
  return { route: route.replace(/\/$/, ''), heading };
}

async function loadMarkdown(file) {
  if (!mdCache.has(file)) {
    const res = await fetch(contentUrl(file), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    mdCache.set(file, await res.text());
  }
  return mdCache.get(file);
}

function scrollToHeading(heading) {
  const target = heading && document.getElementById(heading);
  if (target) target.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
}

function renderMeta(page) {
  el.meta.replaceChildren();
  const parts = [];
  if (page.updated) {
    const d = new Date(page.updated);
    parts.push(Object.assign(document.createElement('time'), {
      dateTime: page.updated,
      textContent: `Updated ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`,
    }));
  }
  for (const tag of page.tags) {
    const b = Object.assign(document.createElement('button'), {
      className: 'tag', type: 'button', textContent: `#${tag}`,
    });
    b.addEventListener('click', () => openSearch(tag));
    parts.push(b);
  }
  if (manifest.repo) {
    const base = `https://github.com/${manifest.repo}`;
    const file = `${manifest.contentDir}/${page.file}`;
    const mk = (text, href) => Object.assign(document.createElement('a'), {
      href, textContent: text, target: '_blank', rel: 'noopener', className: 'meta-link',
    });
    const spacer = Object.assign(document.createElement('span'), { className: 'spacer' });
    parts.push(spacer, mk('History', `${base}/commits/${manifest.branch}/${file}`),
      mk('Edit', `${base}/edit/${manifest.branch}/${file}`));
  }
  el.meta.append(...parts);
}

function headingText(h) {
  const clone = h.cloneNode(true);
  clone.querySelector('.header-anchor')?.remove();
  return clone.textContent.trim();
}

function renderToc() {
  el.toc.replaceChildren();
  const heads = el.article.querySelectorAll('h2[id], h3[id]');
  if (heads.length < 2) return;
  const title = Object.assign(document.createElement('p'), { className: 'toc-title', textContent: 'On this page' });
  const ul = document.createElement('ul');
  for (const h of heads) {
    const a = Object.assign(document.createElement('a'), {
      href: pageHref(currentRoute, h.id),
      textContent: headingText(h),
    });
    const li = document.createElement('li');
    li.className = h.tagName.toLowerCase();
    li.append(a);
    ul.append(li);
  }
  el.toc.append(title, ul);
}

async function render() {
  const { route, heading } = parseHash();
  if (route === currentRoute) return scrollToHeading(heading);

  const page = manifest.pages[route];
  currentRoute = route;
  document.body.classList.remove('nav-open');
  el.navToggle.setAttribute('aria-expanded', 'false');
  markActive(route);

  if (!page) {
    document.title = 'Not found · Notes';
    el.meta.replaceChildren();
    el.toc.replaceChildren();
    el.article.innerHTML = '<h1>Not found</h1><p>No page at this address.</p>';
    return;
  }

  try {
    const source = await loadMarkdown(page.file);
    if (currentRoute !== route) return; // user navigated away meanwhile
    el.article.innerHTML = md.render(source);
    postProcess(el.article, page, route);
  } catch (err) {
    el.article.innerHTML = '';
    el.article.append(Object.assign(document.createElement('p'), {
      className: 'error', textContent: `Could not load ${page.file}: ${err.message}`,
    }));
  }
  document.title = `${page.title} · Notes`;
  renderMeta(page);
  renderToc();
  scrollToHeading(heading);
}

// ---------- search ----------
function buildSearch(docs) {
  search = new MiniSearch({
    fields: ['title', 'tags', 'text'],
    storeFields: ['title'],
    searchOptions: { boost: { title: 3, tags: 2 }, prefix: true, fuzzy: 0.2 },
  });
  search.addAll(docs);
  searchDocs = new Map(docs.map((d) => [d.id, d]));
}

function snippet(text, terms) {
  const lower = text.toLowerCase();
  const idx = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Infinity);
  if (idx === Infinity) return text.slice(0, 120);
  const start = Math.max(0, idx - 50);
  return `${start ? '…' : ''}${text.slice(start, start + 140)}…`;
}

let selected = 0;
function showResults(query) {
  el.results.replaceChildren();
  selected = 0;
  if (!query.trim()) return;
  const hits = search.search(query).slice(0, 15);
  if (!hits.length) {
    el.results.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No results' }));
    return;
  }
  hits.forEach((hit, i) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.dataset.route = hit.id;
    if (i === 0) li.classList.add('selected');
    const title = Object.assign(document.createElement('div'), { className: 'r-title', textContent: hit.title });
    const path = Object.assign(document.createElement('div'), { className: 'r-path', textContent: `/${hit.id}` });
    const text = Object.assign(document.createElement('div'), {
      className: 'r-snippet', textContent: snippet(searchDocs.get(hit.id)?.text ?? '', hit.terms),
    });
    li.append(title, path, text);
    li.addEventListener('click', () => go(hit.id));
    el.results.append(li);
  });
}

function moveSelection(delta) {
  const items = [...el.results.querySelectorAll('li[data-route]')];
  if (!items.length) return;
  items[selected]?.classList.remove('selected');
  selected = (selected + delta + items.length) % items.length;
  items[selected].classList.add('selected');
  items[selected].scrollIntoView({ block: 'nearest' });
}

function go(route) {
  el.dialog.close();
  location.hash = pageHref(route);
}

function openSearch(prefill = '') {
  el.input.value = prefill;
  showResults(prefill);
  el.dialog.showModal();
  el.input.focus();
}

// ---------- wiring ----------
function wireUi() {
  el.searchBtn.addEventListener('click', () => openSearch());
  el.input.addEventListener('input', () => showResults(el.input.value));
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter') {
      const item = el.results.querySelectorAll('li[data-route]')[selected];
      if (item) go(item.dataset.route);
    }
  });
  el.dialog.addEventListener('click', (e) => { if (e.target === el.dialog) el.dialog.close(); });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      openSearch();
    }
  });

  el.navToggle.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    el.navToggle.setAttribute('aria-expanded', String(open));
  });

  window.addEventListener('hashchange', render);
}

async function init() {
  const [m, docs] = await Promise.all([
    fetch('manifest.json', { cache: 'no-cache' }).then((r) => r.json()),
    fetch('search.json', { cache: 'no-cache' }).then((r) => r.json()),
  ]);
  manifest = m;
  buildSearch(docs);
  renderTree();
  wireUi();
  await render();
}

init().catch((err) => {
  el.article.textContent = `Failed to load the wiki: ${err.message}`;
});
