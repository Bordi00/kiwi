# kiwi 

A small, git-native wiki engine for Markdown and [D2](https://d2lang.com) diagrams.

Your notes live in their own git repository. kiwi turns them into a fast static site with GitHub Actions: it renders every D2 diagram to SVG at build time, builds a navigation tree and a search index, and publishes the result to a branch that any static web server can serve. There is no database, no server-side code and no editor to host; git is the storage, the history and the access control.

```
notes repo ──push──► GitHub Actions (kiwi) ──► `site` branch ──► any static host
 content/**.md        d2 → svg                  index.html          nginx, Caddy,
 content/**.d2        manifest + search index   assets/ content/    git-sync, Pages…
```

## Features

- **Plain Markdown** (GitHub-flavoured, with tables, task lists and syntax highlighting). Links between `.md` files keep working on GitHub too.
- **D2 diagrams, rendered in CI.** Reference a `.d2` file like an image, or write a fenced ` ```d2 ` block. The SVGs carry both light and dark palettes and follow the reader's system theme.
- **Obsidian-style wikilinks:** `[[page]]`, `[[page|label]]`, `[[page#Heading]]`, `![[diagram.d2]]`.
- **Navigation tree** generated from your folders, ordered by frontmatter.
- **Instant search** (`Ctrl K` or `/`) with fuzzy and prefix matching, entirely client-side.
- **Git-aware pages:** a "last updated" date from the commit history, plus History and Edit links to GitHub, so editing in the browser comes for free.
- **Static output only.** One HTML page and a handful of JSON, Markdown and SVG files, with hash-based routing, so it works under any path and on any host without rewrite rules.
- **Safe by default.** Raw HTML in Markdown is not rendered, and diagrams are loaded as images, never inlined.

## Quick start

kiwi is used from a separate repository that holds only your notes.

**1. Create the notes repository** (it can be private):

```
my-notes/
├── content/
│   ├── index.md          → /
│   ├── homelab/
│   │   ├── index.md      → /homelab
│   │   ├── network.md    → /homelab/network
│   │   └── network.d2
│   └── …
└── .github/workflows/build.yml
```

**2. Add the workflow** that calls kiwi:

```yaml
# .github/workflows/build.yml
name: build-site
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write   # kiwi pushes the built site to the `site` branch

concurrency:
  group: build-site
  cancel-in-progress: true

jobs:
  site:
    uses: Bordi00/kiwi/.github/workflows/build.yml@v1
```

**3. Push.** The first run creates a `site` branch that contains the finished website. Serve that branch with any static web server (see [Deploying](#deploying)).

## Writing notes

| You write | You get |
| --- | --- |
| `content/foo.md` | the page `/foo` |
| `content/dir/index.md` | the page `/dir`, which also makes the folder clickable in the sidebar |
| `[text](other.md)`, `[text](../dir/page.md#heading)` | ordinary links, which also work when browsing the repo on GitHub |
| `[[page]]`, `[[page\|label]]`, `[[page#Heading]]` | links resolved by path, file name or title |
| `![alt](diagram.d2)` or `![[diagram.d2]]` | the rendered diagram |
| a fenced ` ```d2 ` block | a diagram rendered at build time, in place of the code |
| `_name.d2`, `_folder/`, `.anything` | not published; use these for shared D2 `@imports` and drafts |

Diagrams can be opened full size by clicking them.

### Frontmatter

All fields are optional.

```yaml
---
title: Network       # default: the first "# H1", then the file name
tags: [homelab, k3s] # shown on the page and searchable
order: 1             # position in the sidebar; lower comes first
---
```

## Configuration

### Workflow inputs

```yaml
jobs:
  site:
    uses: Bordi00/kiwi/.github/workflows/build.yml@v1
    with:
      engine-ref: v1       # kiwi version to build with; keep it in step with the @ref above
      d2-version: v0.8.2   # D2 release used to render diagrams
```

The build fails if any diagram fails to render, so a broken diagram never reaches the published site.

### Environment variables

These are only needed when running the build yourself; the reusable workflow sets them for you.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTENT_DIR` | `./content` | folder containing the notes |
| `WIKI_REPO` | `$GITHUB_REPOSITORY` | `owner/repo` used for the History and Edit links; leave empty to hide them |
| `WIKI_BRANCH` | `$GITHUB_REF_NAME`, then `main` | branch used for the History and Edit links |
| `CI` | unset | when set, D2 errors fail the build instead of printing a warning |

## Local preview

You need Node.js 22 or newer, and the `d2` binary on your `PATH` if you want diagrams (pages still render without it).

```bash
git clone https://github.com/Bordi00/kiwi.git
cd kiwi
npm install

# point kiwi at your notes and start the dev server
CONTENT_DIR=../my-notes/content npm run dev
```

PowerShell:

```powershell
$env:CONTENT_DIR = "..\my-notes\content"; npm run dev
```

The dev server rebuilds and reloads the browser whenever anything in your notes folder changes. Use `npm run build` to produce the same `dist/` folder that CI publishes.

## Deploying

The `site` branch is a complete static website: a single commit, force-pushed on every build, so it never grows. Some ways to serve it:

- **Kubernetes:** a [git-sync](https://github.com/kubernetes/git-sync) sidecar that pulls the `site` branch with a read-only deploy key, next to an unprivileged nginx serving the checkout. New notes go live within a minute of the build, with no registry and no redeploys.
- **Any server:** a cron job that runs `git pull` on the branch into a web root.
- **GitHub Pages:** publish from the `site` branch. Note that Pages sites are public even when the repository is private.

Recommended web server settings:

- Cache `assets/` forever; the file names are content-hashed.
- Send `Cache-Control: no-cache` for everything else, so new notes show up immediately.
- Block dotfiles, so `.git` metadata is never served.
- Use a strict Content Security Policy:

  ```
  default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
  ```

## How it works

1. `scripts/build-content.mjs` walks the content folder. For each Markdown file it reads the frontmatter, renders fenced D2 blocks to SVG, and records the title, tags and last commit date. It renders standalone `.d2` files to `.svg` and copies every other file as is.
2. It writes `manifest.json` (pages and navigation tree) and `search.json` (plain text for the search index) next to the processed content.
3. Vite bundles the viewer, a dependency-light vanilla JavaScript app built on [markdown-it](https://github.com/markdown-it/markdown-it), [MiniSearch](https://github.com/lucaong/minisearch) and [highlight.js](https://highlightjs.org). In the browser it renders Markdown, rewrites links and diagram references, and handles search.

```
kiwi/
├── scripts/build-content.mjs    content → public/ (manifest, search index, processed files)
├── src/                         the viewer
├── index.html
├── vite.config.js               runs the content build and live-reloads it in dev
└── .github/workflows/build.yml  the reusable workflow
```

## Versioning

Releases are tagged `vX.Y.Z`, and the major tag (`v1`) moves to the latest compatible release. Calling `@v1` gets fixes automatically. To review every change before it reaches your site, pin a full commit SHA instead.

## License

MIT, see [LICENSE](https://github.com/Bordi00/kiwi/edit/main/LICENSE.md).
