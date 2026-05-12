// =============================================================================
// Library Catalog
//
// Architecture:
//   1. Load three JSON files in parallel.
//   2. Build an enriched, immutable in-memory index (books joined to their
//      transactions and resolved locations).
//   3. Render is a pure function of (index, filter state) → DOM.
//   4. UI events update filter state; we re-render. No incremental mutation
//      of book rows.
//
// Filter state is mirrored to `location.hash` so search URLs are shareable.
// =============================================================================


// ---- Loading & joining -----------------------------------------------------

const load_json = (path) => fetch(path).then((r) => r.json());

const load_all = async () => {
  const [books, transactions, locations] = await Promise.all([
    load_json("./books.json"),
    load_json("./transactions.json"),
    load_json("./locations.json"),
  ]);
  return { books, transactions, locations };
};

// The implicit "online" location isn't in locations.json — add it so joins
// always resolve to something.
const ONLINE_LOCATION = {
  id: "online",
  name: "Online",
  type: "online",
};

const index_locations = (locations) =>
  new Map(
    [ONLINE_LOCATION, ...locations].map((loc) => [loc.id, loc]),
  );

// Each book is referenced from transactions by its `disambiguation` if set,
// otherwise by `title`. We use a single canonical key for the join.
const book_ref = (book) => book.disambiguation || book.title;

// One transaction can reference many books; we flip it into a per-ref lookup.
// The ref string can be a plain title or a disambiguation. Both match the
// `book_ref()` of the corresponding book.
const transactions_by_ref = (transactions, locations_by_id) => {
  const map = new Map();
  for (const txn of transactions) {
    const enriched = {
      ...txn,
      location_resolved: txn.location ? locations_by_id.get(txn.location) : null,
      sort_date: parse_date(txn.date),
    };
    for (const ref of txn.books ?? []) {
      if (typeof ref !== "string") continue;
      if (!map.has(ref)) map.set(ref, []);
      map.get(ref).push(enriched);
    }
  }
  for (const txns of map.values()) {
    txns.sort((a, b) => (b.sort_date ?? 0) - (a.sort_date ?? 0));
  }
  return map;
};

// "May 6, 2026" → Date | "April 2025" → Date(midmonth) | else null
const parse_date = (s) => {
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
};

// Each book becomes a self-contained record carrying everything we need
// for filtering, sorting, and display.
const enrich_books = (books, txns_by_ref) =>
  books.map((book) => {
    const txns = txns_by_ref.get(book_ref(book)) ?? [];
    const latest = txns[0] ?? null;
    return {
      ...book,
      transactions: txns,
      latest_transaction: latest,
      acquired_date: latest?.sort_date ?? null,
      acquired_year: latest?.sort_date?.getFullYear() ?? null,
      acquired_type: latest?.type ?? null,
      acquired_location_id: latest?.location ?? null,
      acquired_location_name: latest?.location_resolved?.name ?? null,
      // Pre-computed lowercase haystack for fast search.
      search_blob: [
        book.title,
        book.subtitle,
        book.series,
        book.note,
        book.disambiguation,
        ...txns.map((t) => t.note),
        ...txns.map((t) => t.location_resolved?.name),
        ...txns.map((t) => t.giver),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });


// ---- Filter state ----------------------------------------------------------

const DEFAULT_STATE = {
  query: "",
  types: new Set(),       // empty = all
  locations: new Set(),   // empty = all
  group_by: "none",       // none | year | location | type
  sort_by: "auto",        // auto | acquired | alpha
};

const read_state_from_hash = () => {
  const params = new URLSearchParams(location.hash.slice(1));
  return {
    query: params.get("q") ?? "",
    types: new Set((params.get("type") ?? "").split(",").filter(Boolean)),
    locations: new Set((params.get("loc") ?? "").split(",").filter(Boolean)),
    group_by: params.get("group") ?? "none",
    sort_by: params.get("sort") ?? "auto",
  };
};

const write_state_to_hash = (state) => {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.types.size) params.set("type", [...state.types].join(","));
  if (state.locations.size) params.set("loc", [...state.locations].join(","));
  if (state.group_by !== "none") params.set("group", state.group_by);
  if (state.sort_by !== "auto") params.set("sort", state.sort_by);
  const new_hash = params.toString();
  history.replaceState(null, "", new_hash ? `#${new_hash}` : location.pathname);
};


// ---- Filtering & grouping --------------------------------------------------

const matches_query = (book, query) =>
  !query || book.search_blob.includes(query.toLowerCase());

const matches_type = (book, types) =>
  types.size === 0 || (book.acquired_type && types.has(book.acquired_type));

const matches_location = (book, locations) =>
  locations.size === 0 ||
  (book.acquired_location_id && locations.has(book.acquired_location_id));

const filter_books = (books, state) =>
  books.filter(
    (b) =>
      matches_query(b, state.query) &&
      matches_type(b, state.types) &&
      matches_location(b, state.locations),
  );

// SORTERS preserve a stable secondary order (alphabetical) where the primary
// key ties. `auto` returns the input untouched (file order).
const SORTERS = {
  auto: (books) => books,

  // Newest acquisition first; within the same date, alphabetical by title.
  // Books without any transaction sink to the bottom, alphabetical.
  acquired: (books) => {
    const with_txn = books.filter((b) => b.acquired_date != null);
    const without = books.filter((b) => b.acquired_date == null);
    const by_date_then_title = [...with_txn].sort((a, b) => {
      const diff = b.acquired_date - a.acquired_date;
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title);
    });
    const alpha_orphans = [...without].sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    return [...by_date_then_title, ...alpha_orphans];
  },

  alpha: (books) =>
    [...books].sort((a, b) => a.title.localeCompare(b.title)),
};

const apply_sort = (books, sort_by) =>
  (SORTERS[sort_by] ?? SORTERS.auto)(books);

// All groupers return [[key, label, books], …] in display order.
// Sentinel for the "no value" bucket in groupers; always sorts last and
// gets a label that reflects the field rather than a generic "Unknown".
const NO_VALUE = "\u00A0__none__"; // leading nbsp keeps it stable in URL hashes

const GROUPERS = {
  none: (books) => [["all", null, books]],
  year: (books) => group_and_sort(
    books,
    (b) => b.acquired_year ?? NO_VALUE,
    (key) => key === NO_VALUE ? "No date" : String(key),
    (a, b) => {
      if (a === NO_VALUE) return 1;
      if (b === NO_VALUE) return -1;
      return Number(b) - Number(a);
    },
  ),
  location: (books) => group_and_sort(
    books,
    (b) => b.acquired_location_id ?? NO_VALUE,
    (key, sample) =>
      key === NO_VALUE ? "No transaction" : (sample.acquired_location_name ?? key),
    (a, b, samples) => {
      if (a === NO_VALUE) return 1;
      if (b === NO_VALUE) return -1;
      return label_for(samples, a).localeCompare(label_for(samples, b));
    },
  ),
  type: (books) => group_and_sort(
    books,
    (b) => b.acquired_type ?? NO_VALUE,
    (key) => key === NO_VALUE ? "Unrecorded" : titlecase(key),
    (a, b) => {
      if (a === NO_VALUE) return 1;
      if (b === NO_VALUE) return -1;
      return a.localeCompare(b);
    },
  ),
};

const label_for = (samples, key) => samples.get(key)?.acquired_location_name ?? key;

const group_and_sort = (books, key_fn, label_fn, sort_fn) => {
  const groups = new Map();
  const samples = new Map();
  for (const book of books) {
    const k = key_fn(book);
    if (!groups.has(k)) {
      groups.set(k, []);
      samples.set(k, book);
    }
    groups.get(k).push(book);
  }
  return [...groups.keys()]
    .sort((a, b) => sort_fn(a, b, samples))
    .map((k) => [k, label_fn(k, samples.get(k)), groups.get(k)]);
};

const titlecase = (s) => s.charAt(0).toUpperCase() + s.slice(1);


// ---- Rendering -------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const fmt_currency = (s) => s ?? "";

const fmt_date = (date_str) => date_str ?? "";

const render_stats = (books, transactions, locations_by_id) => {
  const stats = $("#stats");
  stats.replaceChildren(
    render_stat_total(books),
    render_stat_top_locations(transactions, locations_by_id),
    render_stat_monthly_chart(transactions),
  );
};

const render_stat_total = (books) => {
  const wrap = document.createElement("div");
  wrap.className = "stat-total";
  wrap.innerHTML = `<dt>Books</dt><dd>${books.length.toLocaleString()}</dd>`;
  return wrap;
};

// Top 5 locations by total books purchased (not transaction count, since a
// single trip can yield many books). "Purchased" only — given/found/etc.
// happen at non-store places and would skew this.
const render_stat_top_locations = (transactions, locations_by_id) => {
  const counts = new Map();
  for (const t of transactions) {
    if (t.type !== "purchased") continue;
    const loc_id = t.location;
    if (!loc_id) continue;
    const n_books = t.books?.length ?? 0;
    counts.set(loc_id, (counts.get(loc_id) ?? 0) + n_books);
  }
  const top = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const wrap = document.createElement("div");
  wrap.className = "stat-locations";
  const dt = document.createElement("dt");
  dt.textContent = "Top locations";
  const dd = document.createElement("dd");
  const list = document.createElement("ol");
  for (const [loc_id, count] of top) {
    const loc = locations_by_id.get(loc_id);
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "loc-name";
    name.textContent = loc?.name ?? loc_id;
    const ct = document.createElement("span");
    ct.className = "loc-count";
    ct.textContent = count;
    li.append(name, ct);
    list.append(li);
  }
  dd.append(list);
  wrap.append(dt, dd);
  return wrap;
};

// Bar chart of books added per month since the earliest transaction.
// Pure SVG, no library. Bars are anchored to the bottom, x axis labels
// at year boundaries.
const render_stat_monthly_chart = (transactions) => {
  const by_month = aggregate_books_per_month(transactions);

  const wrap = document.createElement("div");
  wrap.className = "stat-chart";
  const dt = document.createElement("dt");
  dt.textContent = "Books added per month";
  const dd = document.createElement("dd");

  if (by_month.length === 0) {
    dd.textContent = "—";
    wrap.append(dt, dd);
    return wrap;
  }

  const max_count = Math.max(...by_month.map(([, n]) => n));
  const w = 360;
  const h = 80;
  const bar_w = w / by_month.length;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h + 14}`);
  svg.setAttribute("class", "monthly-chart");
  svg.setAttribute("preserveAspectRatio", "none");

  for (const [i, [month_key, count]] of by_month.entries()) {
    const bar_h = (count / max_count) * h;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", i * bar_w);
    rect.setAttribute("y", h - bar_h);
    rect.setAttribute("width", Math.max(bar_w - 0.5, 1));
    rect.setAttribute("height", bar_h);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${month_key}: ${count} book${count === 1 ? "" : "s"}`;
    rect.append(title);
    svg.append(rect);
  }

  // Year axis labels at January boundaries.
  for (const [i, [month_key]] of by_month.entries()) {
    if (!month_key.endsWith("-01")) continue;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", i * bar_w);
    text.setAttribute("y", h + 11);
    text.setAttribute("class", "axis-label");
    text.textContent = month_key.slice(0, 4);
    svg.append(text);
  }

  dd.append(svg);
  wrap.append(dt, dd);
  return wrap;
};

// Returns sorted array of [YYYY-MM, count], covering every month from the
// earliest transaction to today, with zeroes for months that had no entries.
const aggregate_books_per_month = (transactions) => {
  const counts = new Map();
  let earliest = null;
  for (const t of transactions) {
    const d = parse_date(t.date);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const n = (t.books?.length ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + n);
    if (!earliest || d < earliest) earliest = d;
  }
  if (!earliest) return [];

  const result = [];
  const cursor = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
  const end = new Date();
  while (cursor <= end) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    result.push([key, counts.get(key) ?? 0]);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return result;
};

// Builds the option list for a facet, with counts.
const render_facet = (container, entries, selected, on_toggle) => {
  container.replaceChildren(
    ...entries.map(([value, label, count]) => {
      const lbl = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = value;
      cb.checked = selected.has(value);
      cb.addEventListener("change", () => on_toggle(value, cb.checked));
      const text = document.createElement("span");
      text.textContent = label;
      const ct = document.createElement("span");
      ct.className = "count";
      ct.textContent = count;
      lbl.append(cb, text, ct);
      return lbl;
    }),
  );
};

const tally = (items, key_fn) => {
  const counts = new Map();
  for (const item of items) {
    const k = key_fn(item);
    if (k == null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
};

const render_type_facet = (books, state, on_change) => {
  const counts = tally(books, (b) => b.acquired_type);
  const entries = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => [type, titlecase(type), count]);
  render_facet($("#type-filters"), entries, state.types, (value, checked) => {
    if (checked) state.types.add(value);
    else state.types.delete(value);
    on_change();
  });
  $("#type-count").textContent = state.types.size ? `(${state.types.size})` : "";
};

const render_location_facet = (books, locations_by_id, state, on_change) => {
  const counts = tally(books, (b) => b.acquired_location_id);
  const entries = [...counts.entries()]
    .sort(([a_id, a_n], [b_id, b_n]) => {
      if (a_n !== b_n) return b_n - a_n;
      return (locations_by_id.get(a_id)?.name ?? a_id).localeCompare(
        locations_by_id.get(b_id)?.name ?? b_id,
      );
    })
    .map(([id, count]) => [id, locations_by_id.get(id)?.name ?? id, count]);
  render_facet($("#loc-filters"), entries, state.locations, (value, checked) => {
    if (checked) state.locations.add(value);
    else state.locations.delete(value);
    on_change();
  });
  $("#loc-count").textContent = state.locations.size ? `(${state.locations.size})` : "";
};

// Pulls a <template> by id and clones it.
const tmpl = (id) => document.getElementById(id).content.cloneNode(true);

const render_book = (book) => {
  const node = tmpl("book-row");
  const root = node.querySelector("details.book");
  // Make book rows linkable: title slug as id.
  root.id = "b-" + slug(book.title);

  node.querySelector(".title").textContent = book.title;
  node.querySelector(".subtitle").textContent = book.subtitle ?? "";

  const acq = book.latest_transaction;
  node.querySelector(".acquired-date").textContent = acq?.date ?? "";
  node.querySelector(".acquired-where").textContent = acq
    ? where_label(acq)
    : "Unrecorded";

  node.querySelector(".book-fields").replaceChildren(...render_book_fields(book));
  node.querySelector(".transaction-list").replaceChildren(
    ...book.transactions.map(render_transaction),
  );

  return node;
};

const where_label = (txn) => {
  if (txn.type === "given" || txn.type === "gifted" || txn.type === "inherited") {
    return txn.giver ? `from ${txn.giver}` : titlecase(txn.type);
  }
  if (txn.type === "gave") return txn.receiver ? `to ${txn.receiver}` : "Given away";
  if (txn.type === "stolen") return "Stolen";
  if (txn.type === "found") return "Found" + (txn.location_resolved ? ` · ${txn.location_resolved.name}` : "");
  return txn.location_resolved?.name ?? "";
};

const render_book_fields = (book) => {
  const rows = [];
  const push = (label, value, classname = "") => {
    if (value == null || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (classname) dd.className = classname;
    if (typeof value === "string" && value.startsWith("http")) {
      const a = document.createElement("a");
      a.href = value;
      a.textContent = value.replace(/^https?:\/\//, "");
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      dd.append(a);
    } else {
      dd.textContent = value;
    }
    rows.push(dt, dd);
  };

  push("Series", book.series);
  push("ISBN-13", book.isbn13, "isbn");
  push("ISBN-10", book.isbn10, "isbn");
  push("LCCN", book.lccn, "isbn");
  push("Language", book.language);
  push("Disambiguation", book.disambiguation, "note");
  push("Note", book.note, "note");
  push("Link", book.external);
  return rows;
};

const render_transaction = (txn) => {
  const li = document.createElement("li");

  const head = document.createElement("p");
  head.className = "txn-headline";

  const type_tag = document.createElement("span");
  type_tag.className = `txn-type ${txn.type}`;
  type_tag.textContent = txn.type;
  head.append(type_tag);

  const parts = [];
  if (txn.date) parts.push(txn.date);
  if (txn.location_resolved) parts.push(txn.location_resolved.name);
  if (txn.giver) parts.push(`from ${txn.giver}`);
  if (txn.receiver) parts.push(`to ${txn.receiver}`);
  head.append(document.createTextNode(parts.join(" · ")));

  if (txn.cost) {
    const cost = document.createElement("span");
    cost.className = "cost";
    cost.textContent = " · " + txn.cost;
    head.append(cost);
  }

  li.append(head);

  if (txn.location_resolved?.address) {
    const addr_p = document.createElement("p");
    const addr = document.createElement("address");
    addr.textContent = txn.location_resolved.address;
    addr_p.append(addr);
    li.append(addr_p);
  }

  if (txn.note) {
    const note = document.createElement("p");
    note.className = "txn-note";
    note.textContent = txn.note;
    li.append(note);
  }

  return li;
};

const render_results = (groups, state) => {
  const main = $("#results");
  const index = $("#group-index");

  if (groups.length === 0 || groups.every(([,, books]) => books.length === 0)) {
    main.replaceChildren(empty_state(state));
    index.hidden = true;
    return;
  }

  main.replaceChildren(
    ...groups.map(([key, label, books]) => {
      const section = document.createElement("section");
      section.className = "group";
      section.id = "g-" + slug(String(key));
      if (label) {
        const h = document.createElement("h2");
        h.append(document.createTextNode(label));
        const meta = document.createElement("span");
        meta.className = "group-meta";
        meta.textContent = `${books.length} book${books.length === 1 ? "" : "s"}`;
        h.append(meta);
        section.append(h);
      }
      section.append(...books.map(render_book));
      return section;
    }),
  );

  render_group_index(groups, state);
};

// Sticky chip strip linking to each group section. Empty when grouping is off
// or when there's only one group (nothing to jump between).
//
// Behavior varies by group type:
//   year — one chip per year (small set, full labels fit).
//   type — one chip per acquisition type (small set, full labels fit).
//   location — one chip per first letter (104 locations would otherwise
//              produce an unreadable strip). Clicking "B" scrolls to the
//              first location starting with B.
const render_group_index = (groups, state) => {
  const index = $("#group-index");
  if (state.group_by === "none" || groups.length <= 1) {
    index.hidden = true;
    index.replaceChildren();
    return;
  }

  index.hidden = false;
  const chips = state.group_by === "location"
    ? location_alphabet_chips(groups)
    : groups.map(([key, label, books]) => ({
        target_key: key,
        text: label,
        title: `${label} — ${books.length} book${books.length === 1 ? "" : "s"}`,
      }));

  index.replaceChildren(
    ...chips.map(({ target_key, text, title }) => {
      const a = document.createElement("a");
      a.href = "#g-" + slug(String(target_key));
      a.className = "chip";
      a.textContent = text;
      a.title = title;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const target = document.getElementById("g-" + slug(String(target_key)));
        if (!target) return;
        // Use instant (non-smooth) scroll. Smooth scrolling over thousands
        // of rows interacts badly with `content-visibility: auto`: as
        // offscreen rows resolve during the animation, the document height
        // shifts and the final position drifts. An instant jump is more
        // reliable and also feels faster.
        target.scrollIntoView({ behavior: "instant", block: "start" });
      });
      return a;
    }),
  );
};

// One chip per first letter of location name. Each chip points to the first
// group section with that letter. The "No transaction" bucket gets a "·" chip.
const location_alphabet_chips = (groups) => {
  const seen = new Set();
  const chips = [];
  for (const [key, label, books] of groups) {
    const initial = label === "No transaction"
      ? "·"
      : label.charAt(0).toUpperCase();
    if (seen.has(initial)) continue;
    seen.add(initial);
    chips.push({
      target_key: key,
      text: initial,
      title: `${label}…`,
    });
  }
  return chips;
};

const empty_state = (state) => {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = state.query || state.types.size || state.locations.size
    ? "No books match the current filters."
    : "No books to display.";
  return p;
};

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");


// ---- Wiring ----------------------------------------------------------------

const main = async () => {
  const { books, transactions, locations } = await load_all();

  const locations_by_id = index_locations(locations);
  const txns_by_ref = transactions_by_ref(transactions, locations_by_id);
  const enriched = enrich_books(books, txns_by_ref);

  render_stats(books, transactions, locations_by_id);

  const state = { ...DEFAULT_STATE, ...read_state_from_hash() };

  const rerender = () => {
    const filtered = filter_books(enriched, state);
    const sorted = apply_sort(filtered, state.sort_by);
    const grouper = GROUPERS[state.group_by] ?? GROUPERS.none;
    const groups = grouper(sorted);
    render_results(groups, state);
    const is_filtered = filtered.length !== enriched.length;
    $("#result-count").textContent = is_filtered
      ? `${filtered.length.toLocaleString()} of ${enriched.length.toLocaleString()} books`
      : `${enriched.length.toLocaleString()} books`;
    write_state_to_hash(state);
  };

  // Facets are built once over the full enriched set so counts are stable.
  render_type_facet(enriched, state, rerender);
  render_location_facet(enriched, locations_by_id, state, rerender);

  // --- Event wiring (state mutations are kept here, narrowly) -----------

  // Search is debounced so we don't rebuild ~1500 rows on every keystroke.
  // 150ms is roughly the floor a user perceives as "instant" while still
  // collapsing multiple rapid keystrokes into one render pass.
  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  const search_input = $("#search");
  search_input.value = state.query;
  const debounced_search_rerender = debounce(rerender, 150);
  search_input.addEventListener("input", (e) => {
    state.query = e.target.value;
    debounced_search_rerender();
  });

  // Stats panel is collapsed by default. The <details> element handles the
  // expand/collapse state; we mirror that to the <dl> hidden attribute so the
  // panel actually disappears (rather than just being toggled by CSS, which
  // wouldn't free the SVG drawing work).
  const stats_toggle = $("#stats-wrap");
  const stats_dl = $("#stats");
  stats_toggle.addEventListener("toggle", () => {
    stats_dl.hidden = !stats_toggle.open;
  });

  for (const radio of document.querySelectorAll('input[name="group"]')) {
    radio.checked = radio.value === state.group_by;
    radio.addEventListener("change", (e) => {
      state.group_by = e.target.value;
      rerender();
    });
  }

  for (const radio of document.querySelectorAll('input[name="sort"]')) {
    radio.checked = radio.value === state.sort_by;
    radio.addEventListener("change", (e) => {
      state.sort_by = e.target.value;
      rerender();
    });
  }

  // Close sibling facets when one opens — keeps the top bar tidy.
  const facets = document.querySelectorAll("nav.controls > details.facet");
  for (const facet of facets) {
    facet.addEventListener("toggle", () => {
      if (facet.open) {
        for (const other of facets) {
          if (other !== facet) other.open = false;
        }
      }
    });
  }

  const close_all_facets = () => {
    for (const facet of facets) facet.open = false;
  };

  $("#reset").addEventListener("click", () => {
    state.query = "";
    state.types = new Set();
    state.locations = new Set();
    state.group_by = "none";
    state.sort_by = "auto";
    search_input.value = "";
    document.querySelector('input[name="group"][value="none"]').checked = true;
    document.querySelector('input[name="sort"][value="auto"]').checked = true;
    close_all_facets();
    render_type_facet(enriched, state, rerender);
    render_location_facet(enriched, locations_by_id, state, rerender);
    rerender();
  });

  rerender();

  // Deep-link to a specific book on load if the hash has #b-...
  if (location.hash.startsWith("#b-")) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) {
      target.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
};

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p style="color:#8b2c1f;padding:1rem;">Failed to load catalog: ${err.message}</p>`,
  );
});
