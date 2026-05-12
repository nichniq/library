# Nick's Library

A static, single-page catalog for a personal book collection. Reads three
JSON files at runtime, joins them in the browser, and renders a searchable,
filterable, groupable, sortable list of books. No build step, no framework,
no dependencies.

## Files

```
.
├── index.html        ← catalog page
├── styles.css        ← visual grammar: element selectors, classes for variants
├── catalog.js        ← load → enrich → filter → sort → group → render
├── entry.html        ← new-entry tool (ISBN lookup → JSON snippets to paste)
├── entry.js          ← lookup, collision detection, live JSON generation
├── isbn.js           ← shared pure ISBN utilities (10↔13, parsing)
├── books.json
├── transactions.json
├── locations.json
├── AUDIT.md          ← record of cleanup changes made to the data files
└── README.md
```

All JSON files live at the repo root and are fetched directly by the
catalog page. No build step, no `/data` directory.

## How the data fits together

- **`books.json`** — array of books. Each has a `title` (the join key when
  no `disambiguation` is set), optionally `subtitle`, `isbn13`, `isbn10`,
  `lccn`, `series`, `note`, `disambiguation`, `language`, `external`.
- **`transactions.json`** — array of acquisition events. Each has a `type`
  (`purchased`, `given`, `ordered`, `found`, `gifted`, `inherited`, `won`,
  `gave`, `stolen`), a `date`, an array of `books` (referenced by title or
  by disambiguation), and optionally `location`, `cost`, `note`, `giver`,
  `receiver`.
- **`locations.json`** — array of places. Each has an `id` (the join key),
  `name`, optional `address`, `type`, `note`.

### The disambiguation rule

When two books share a title, each gets a `disambiguation` field set to a
unique string (conventionally `"<title> (<isbn13>)"`, but anything that
uniquely identifies it works — e.g. `"Architecture (lccn 62015928)"` or
`"The Book of Ceremonial Magic (1961 edition)"`).

Transactions reference such books **by their disambiguation** rather than
by their title. A book without a `disambiguation` is referenced by plain
title. The catalog uses this rule when joining — it looks up each book by
`disambiguation || title` against the transaction's `books[]` entries.

## Stats

The page header has a **Stats** toggle next to the title (collapsed by
default). When opened, three panels appear:

- **Total books** — a single big number, the live count of entries in
  `books.json`.
- **Top 5 locations by books purchased** — counts books across all
  `purchased` transactions at each location, not transaction count (since
  a single bookstore trip yields many books). Other transaction types
  (given, found, inherited) are excluded.
- **Monthly additions chart** — a small inline SVG showing how many books
  were added each month, from the earliest transaction date forward, with
  year axis labels. Bars get tooltips on hover.

## Controls

Search across title, subtitle, series, location, notes, and giver. The
search input is debounced (150ms) so rapid typing doesn't trigger a render
per keystroke. Filter by acquisition type or location (with counts). Group
by year, location, or type — the "no value" bucket ("No date", "No
transaction", "Unrecorded") always sinks to the bottom of the list.

When grouping is active, a sticky chip strip appears below the controls
for quick jumping between groups:
- Year and type chips show the full label.
- Location chips dedupe by first letter (one chip per A, B, C, …), since
  100+ locations would otherwise produce an unreadable strip.

Sort by:

- **File order** — preserves the order in `books.json`. Useful for seeing
  recent additions at the top, since new entries are appended.
- **Acquisition date** — newest first, alphabetical within ties. Books
  without any transaction sink to the end, alphabetized.
- **Alphabetical** — straight title sort.

All filter and view state is mirrored to `location.hash`, so URLs like
`#q=palouse&sort=acquired&group=year` are shareable.

## The entry tool

`entry.html` is a helper for adding new transactions:

1. Paste ISBNs (10 or 13, any separator).
2. Click **Look up** — results show as editable cards. ISBN-10/13 are
   auto-cross-filled. Duplicates and title collisions are flagged with
   suggested disambiguation strings.
3. Fill in transaction details: type, date, cost, location, note. The
   location picker searches your existing `locations.json`; pick **+ Add
   new location…** to expand an inline form for first-time places.
4. The three output panes (books / transaction / new location) update live.
   Copy each into the matching JSON file.

### Optional Google Books API key

The tool works anonymously, but Google's rate limits per IP are tight. If
you hit them, get a free key from
[Google Cloud Console](https://console.cloud.google.com/apis/credentials)
(enable the Books API first), then paste it into the **Advanced** section
on the entry page. It's stored in your browser's `localStorage` (this
origin only — other sites can't read it).

## Maintenance

The easy way: open `entry.html`, paste ISBNs, fill in the transaction,
copy the three JSON snippets into the right files. Commit and push.

The manual way:

1. Append a book entry to `books.json`.
2. Append a transaction to `transactions.json` referencing the book by
   `disambiguation` if it has one, otherwise by title.
3. If acquired somewhere new, append the place to `locations.json`.
4. Commit and push.

The site updates on the next load.

## Data audit

The initial cleanup pass through the three JSON files is documented in
`AUDIT.md`. Highlights:

- 5 books dropped as duplicates
- 26 stub books added for transactions that referenced books not yet in
  `books.json`
- 8 sets of duplicate titles disambiguated (e.g. `Edward Hopper`,
  `Keeping a Nature Journal`)
- 5 ISBN collisions corrected (where two unrelated books shared an ISBN
  due to copy-paste errors)
- 2 missing locations added (`arundel`, `friends_of_moscow`)
- Various malformed fields fixed (stray double-paren, nested-list bug,
  misfiled `city` fields)

Books and transactions touched by the audit carry a `todo` field
describing what was changed, so you can verify.

## Publishing on GitHub Pages

1. Create a public repository on GitHub.
2. Push these files to the default branch (`main`).
3. In the repo, **Settings → Pages**.
4. **Source → Deploy from a branch**, pick `main` / root.
5. Your site is live at `https://<username>.github.io/<repo-name>/`.

To update: commit and push. Pages redeploys automatically.

## Local development

Browsers block `file://` JSON fetches, so run any static server from this
directory:

```sh
python3 -m http.server 8000
# or: npx serve .
# or: bunx serve .
```

Open <http://localhost:8000>.

## Design notes

- Pure data transformations top to bottom in the JS:
  `load_all` → `enrich_books` → `filter_books` → `apply_sort` →
  `GROUPERS[…]` → `render_results`. Each function takes data and returns
  data or DOM. State mutation is narrowly scoped to event handlers.
- The CSS defines a "visual grammar" with element-first selectors and
  relationship combinators (`>`, `+`). Classes appear only to mark variants
  (`.title`, `.note`, `.txn-type.purchased`). Design tokens live in `:root`.
- Native disclosure widgets (`<details>` / `<summary>`) handle both the
  facet dropdowns and the per-book expansion. No custom dropdown library.
- Deep links to books work via `#b-<slugified-title>`.
- 1,400+ rows render fine because each row gets `content-visibility: auto`,
  which tells the browser to skip layout/paint for anything offscreen.
- A print stylesheet drops the controls; open books print expanded, closed
  books print as a single-line list.
