// =============================================================================
// New Entry — ISBN lookup → editable book records → transaction → JSON outputs
//
// Architecture mirrors catalog.js:
//   - Pure data transformations where possible.
//   - State is held in a single `state` object; `rerender_outputs()` is a
//     pure projection of state into the three readonly textareas.
//   - Mutations are confined to event handlers.
// =============================================================================

import {
  isbn10_to_13,
  isbn13_to_10,
  parse_isbns,
} from "./isbn.js";

// ---- Existing catalog data (used for dedup, collision detection, locations) -

const load_json = (path) =>
  fetch(path)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);

const load_existing = async () => {
  const [books, locations] = await Promise.all([
    load_json("./books.json"),
    load_json("./locations.json"),
  ]);
  return { books, locations };
};

// Index existing books by ISBN-13 and by title for fast lookup.
const index_books = (books) => {
  const by_isbn13 = new Map();
  const by_title = new Map();
  for (const b of books) {
    if (b.isbn13) by_isbn13.set(b.isbn13, b);
    if (b.isbn10) by_isbn13.set(isbn10_to_13(b.isbn10) ?? "", b);
    if (b.title) {
      if (!by_title.has(b.title)) by_title.set(b.title, []);
      by_title.get(b.title).push(b);
    }
  }
  return { by_isbn13, by_title };
};


// ---- API key persistence ---------------------------------------------------

const KEY_STORAGE = "google_books_api_key";

const load_api_key = () => {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
};

const save_api_key = (key) => {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* private mode etc. */ }
};


// ---- Lookups ---------------------------------------------------------------

const google_books_url = (isbn, key) => {
  const base = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
  return key ? `${base}&key=${encodeURIComponent(key)}` : base;
};

const lookup_google = async (isbn, key) => {
  const r = await fetch(google_books_url(isbn, key));
  if (!r.ok) {
    if (r.status === 429 || r.status === 403) {
      throw new Error("Google Books quota exceeded; falling back");
    }
    throw new Error(`Google Books ${r.status}`);
  }
  const data = await r.json();
  const item = data.items?.[0];
  if (!item) return null;
  const v = item.volumeInfo ?? {};
  const ids = v.industryIdentifiers ?? [];
  const find_id = (type) => ids.find((x) => x.type === type)?.identifier ?? null;
  return {
    title: v.title ?? null,
    subtitle: v.subtitle ?? null,
    isbn10: find_id("ISBN_10"),
    isbn13: find_id("ISBN_13"),
    language: v.language ?? null,
    source: "google",
  };
};

const lookup_openlibrary = async (isbn) => {
  const r = await fetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
  );
  if (!r.ok) throw new Error(`Open Library ${r.status}`);
  const data = await r.json();
  const rec = data[`ISBN:${isbn}`];
  if (!rec) return null;
  const ids = rec.identifiers ?? {};
  return {
    title: rec.title ?? null,
    subtitle: rec.subtitle ?? null,
    isbn10: ids.isbn_10?.[0] ?? null,
    isbn13: ids.isbn_13?.[0] ?? null,
    language: null,
    source: "openlibrary",
  };
};

// Try Google first if we have a key, otherwise Open Library first
// (Google works without a key but limits are tight per-IP).
const lookup_with_fallback = async (isbn, key) => {
  const providers = key
    ? [() => lookup_google(isbn, key), () => lookup_openlibrary(isbn)]
    : [() => lookup_openlibrary(isbn), () => lookup_google(isbn, null)];

  const errors = [];
  for (const provider of providers) {
    try {
      const result = await provider();
      if (result) return result;
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { not_found: true, errors };
};

// Fill in missing ISBN-10/13 from the query and via 10↔13 conversion.
const backfill_isbns = (record, query) => {
  const query_len = query.length;
  let isbn10 = record.isbn10 ?? (query_len === 10 ? query : null);
  let isbn13 = record.isbn13 ?? (query_len === 13 ? query : null);
  if (!isbn13 && isbn10) isbn13 = isbn10_to_13(isbn10);
  if (!isbn10 && isbn13) isbn10 = isbn13_to_10(isbn13);
  return { ...record, isbn10, isbn13 };
};


// ---- State -----------------------------------------------------------------
//
// `state.books` is the array of editable book records derived from lookups.
// `state.txn` holds the transaction form values.
// `state.new_location` holds the inline new-location form values, used iff
//    `state.txn.location_id === "__new__"`.

const TXN_TYPES = [
  ["purchased", "Purchased"],
  ["given", "Given (to me)"],
  ["gifted", "Gifted"],
  ["ordered", "Ordered"],
  ["found", "Found"],
  ["inherited", "Inherited"],
  ["won", "Won"],
  ["gave", "Gave (away)"],
  ["stolen", "Stolen"],
];

const new_state = () => ({
  books: [],
  txn: {
    type: "purchased",
    date: today_string(),
    cost: "",
    location_id: "",
    giver: "",
    receiver: "",
    note: "",
  },
  new_location: {
    id: "",
    name: "",
    address: "",
    type: "bookstore",
    note: "",
  },
});

const today_string = () => {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "long" });
  return `${month} ${d.getDate()}, ${d.getFullYear()}`;
};


// ---- Book record helpers ---------------------------------------------------
//
// A "book record" in state is an editable object with the same fields we'd
// output to books.json plus a `query` (the user's input) and any flags
// for the UI (duplicate, disambiguation_needed, error).

const record_from_lookup = (query, lookup, existing_index) => {
  if (lookup.not_found) {
    return { query, error: lookup.errors?.join("; ") || "Not found" };
  }
  const filled = backfill_isbns(lookup, query);
  const existing_by_isbn = filled.isbn13 && existing_index.by_isbn13.get(filled.isbn13);
  const same_title = existing_index.by_title.get(filled.title) ?? [];
  return {
    query,
    title: filled.title,
    subtitle: filled.subtitle,
    isbn10: filled.isbn10,
    isbn13: filled.isbn13,
    language: filled.language,
    disambiguation: "",
    note: "",
    // Flags
    duplicate_isbn: !!existing_by_isbn,
    title_collision: same_title.length > 0,
    suggested_disambiguation: same_title.length > 0
      ? `${filled.title} (${filled.isbn13})`
      : "",
  };
};

// Strip fields we don't want in the final book JSON.
const book_record_to_json = (record) => {
  const out = { title: record.title };
  if (record.subtitle) out.subtitle = record.subtitle;
  if (record.isbn10) out.isbn10 = record.isbn10;
  if (record.isbn13) out.isbn13 = record.isbn13;
  if (record.language && record.language !== "en") out.language = record.language;
  if (record.disambiguation) out.disambiguation = record.disambiguation;
  if (record.note) out.note = record.note;
  return out;
};

// How a book is referenced in a transaction: by disambiguation if set,
// otherwise by title.
const book_reference = (record) => record.disambiguation || record.title;


// ---- Transaction → JSON ----------------------------------------------------

const txn_to_json = (state) => {
  const { txn, books, new_location } = state;
  const book_refs = books
    .filter((b) => !b.error && b.title)
    .map(book_reference);

  const out = { type: txn.type };

  // Location/giver/receiver depend on type.
  if (["purchased", "ordered", "found"].includes(txn.type)) {
    const loc_id = txn.location_id === "__new__" ? new_location.id : txn.location_id;
    if (loc_id) out.location = loc_id;
  }
  if (["given", "gifted", "inherited", "won"].includes(txn.type) && txn.giver) {
    out.giver = txn.giver;
  }
  if (txn.type === "gave" && txn.receiver) {
    out.receiver = txn.receiver;
  }

  if (txn.date) out.date = txn.date;
  out.books = book_refs;
  if (txn.cost) out.cost = txn.cost;
  if (txn.note) out.note = txn.note;
  return out;
};

const new_location_to_json = (loc) => {
  if (!loc.id || !loc.name) return null;
  const out = { id: loc.id, name: loc.name };
  if (loc.address) out.address = loc.address;
  if (loc.type) out.type = loc.type;
  if (loc.note) out.note = loc.note;
  return out;
};


// ---- DOM helpers -----------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Create an element with attributes and children (children may be strings).
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
};


// ---- Rendering: book cards -------------------------------------------------

const render_books = (state, on_change) => {
  const list = $("#results");
  list.replaceChildren(
    ...state.books.map((book, index) =>
      render_book_card(book, index, state, on_change),
    ),
  );
  $("#results-section").hidden = state.books.length === 0;
  $("#txn-section").hidden = state.books.length === 0;
  $("#output-section").hidden = state.books.length === 0;
};

const render_book_card = (book, index, state, on_change) => {
  if (book.error) {
    return el("li", { class: "card error" },
      el("header", {},
        el("span", { class: "query" }, `ISBN: ${book.query}`),
        el("button", {
          class: "remove",
          type: "button",
          onclick: () => {
            state.books.splice(index, 1);
            on_change();
          },
        }, "Remove ✕"),
      ),
      el("p", { class: "err-msg" }, `— ${book.error} —`),
    );
  }

  const update = (field, value) => {
    book[field] = value;
    on_change({ skip_book_render: true });
  };

  const flags = [];
  if (book.duplicate_isbn) flags.push("Already in books.json (matching ISBN)");
  if (book.title_collision && !book.disambiguation) {
    flags.push("Title collides with existing book(s) — consider disambiguation");
  }

  return el("li", { class: "card" },
    el("header", {},
      el("span", { class: "query" },
        `ISBN: ${book.query}${book.source ? ` · ${book.source}` : ""}`,
      ),
      el("button", {
        class: "remove",
        type: "button",
        onclick: () => {
          state.books.splice(index, 1);
          on_change();
        },
      }, "Remove ✕"),
    ),

    flags.length
      ? el("p", { class: "disambig-hint" }, flags.join(" · "))
      : null,

    el("div", { class: "field-grid" },
      el("div", { class: "full" },
        el("label", { for: `t-${index}` }, "Title"),
        el("input", {
          id: `t-${index}`,
          type: "text",
          class: "serif",
          value: book.title ?? "",
          oninput: (e) => update("title", e.target.value),
        }),
      ),
      el("div", { class: "full" },
        el("label", { for: `s-${index}` }, "Subtitle"),
        el("input", {
          id: `s-${index}`,
          type: "text",
          class: "serif",
          value: book.subtitle ?? "",
          oninput: (e) => update("subtitle", e.target.value),
        }),
      ),
      el("div", {},
        el("label", { for: `i13-${index}` }, "ISBN-13"),
        el("input", {
          id: `i13-${index}`,
          type: "text",
          value: book.isbn13 ?? "",
          oninput: (e) => update("isbn13", e.target.value),
        }),
      ),
      el("div", {},
        el("label", { for: `i10-${index}` }, "ISBN-10"),
        el("input", {
          id: `i10-${index}`,
          type: "text",
          value: book.isbn10 ?? "",
          oninput: (e) => update("isbn10", e.target.value),
        }),
      ),
      el("div", { class: "full" },
        el("label", { for: `d-${index}` },
          "Disambiguation (used as the txn reference if set)",
        ),
        el("input", {
          id: `d-${index}`,
          type: "text",
          placeholder: book.suggested_disambiguation
            ? `Suggested: ${book.suggested_disambiguation}`
            : "(leave blank unless title collides)",
          value: book.disambiguation ?? "",
          oninput: (e) => update("disambiguation", e.target.value),
        }),
        book.suggested_disambiguation && !book.disambiguation
          ? el("button", {
              class: "secondary",
              type: "button",
              style: "margin-top: 0.35rem;",
              onclick: () => {
                book.disambiguation = book.suggested_disambiguation;
                on_change();
              },
            }, `Use suggested`)
          : null,
      ),
      el("div", { class: "full" },
        el("label", { for: `n-${index}` }, "Note (optional)"),
        el("textarea", {
          id: `n-${index}`,
          rows: 2,
          oninput: (e) => update("note", e.target.value),
        }, book.note ?? ""),
      ),
    ),
  );
};


// ---- Rendering: location picker -------------------------------------------

const render_location_dropdown = (state, locations, on_change) => {
  const input = $("#txn-location");
  const dropdown = $("#location-dropdown");
  const picker = $("#location-picker");
  const query = input.value.trim().toLowerCase();

  const matches = locations
    .filter((l) =>
      !query
        ? true
        : l.name.toLowerCase().includes(query) ||
          l.id.toLowerCase().includes(query) ||
          (l.address ?? "").toLowerCase().includes(query),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 25);

  const items = [
    ...matches.map((loc) =>
      el("button", {
        type: "button",
        onclick: () => {
          state.txn.location_id = loc.id;
          input.value = loc.name;
          picker.classList.remove("open");
          $("#new-location").hidden = true;
          on_change();
        },
      },
        loc.name,
        el("span", { class: "id" }, loc.id),
      ),
    ),
    // "Online" pseudo-location
    !query || "online".includes(query)
      ? el("button", {
          type: "button",
          onclick: () => {
            state.txn.location_id = "online";
            input.value = "Online";
            picker.classList.remove("open");
            $("#new-location").hidden = true;
            on_change();
          },
        }, "Online", el("span", { class: "id" }, "online"))
      : null,
    el("button", {
      type: "button",
      class: "add-new",
      onclick: () => {
        state.txn.location_id = "__new__";
        input.value = "+ New location…";
        picker.classList.remove("open");
        $("#new-location").hidden = false;
        $("#new-loc-id").focus();
        on_change();
      },
    }, "+ Add new location…"),
  ].filter(Boolean);

  dropdown.replaceChildren(...items);
};


// ---- Rendering: txn type → which extra fields show ------------------------

const render_txn_type_fields = (state) => {
  const type = state.txn.type;
  const uses_location = ["purchased", "ordered", "found"].includes(type);
  $("#location-field").hidden = !uses_location;
  $("#giver-field").hidden = !["given", "gifted", "inherited", "won"].includes(type);
  $("#receiver-field").hidden = type !== "gave";
  // If we're not using location at all, also hide the new-location form.
  if (!uses_location) $("#new-location").hidden = true;
};


// ---- Rendering: the three output JSON blobs --------------------------------

const fmt_json = (value) => JSON.stringify(value, null, 2);

const render_outputs = (state) => {
  const books_json = state.books
    .filter((b) => !b.error && b.title)
    .map(book_record_to_json);

  // Render books as a comma-separated list of objects (suitable for pasting
  // inside an existing array). Each item gets indented two spaces.
  const books_text = books_json.length
    ? books_json
        .map((b) => fmt_json(b).split("\n").map((l) => "  " + l).join("\n"))
        .join(",\n") + ","
    : "";
  $("#out-books").value = books_text;

  const txn_text = state.books.some((b) => !b.error)
    ? fmt_json(txn_to_json(state)).split("\n").map((l) => "  " + l).join("\n") + ","
    : "";
  $("#out-txn").value = txn_text;

  const type_uses_location = ["purchased", "ordered", "found"].includes(state.txn.type);
  const loc_json = type_uses_location && state.txn.location_id === "__new__"
    ? new_location_to_json(state.new_location)
    : null;
  $("#out-location-block").hidden = !loc_json;
  $("#out-location").value = loc_json
    ? fmt_json(loc_json).split("\n").map((l) => "  " + l).join("\n") + ","
    : "";
};


// ---- Main wiring -----------------------------------------------------------

const main = async () => {
  const { books: existing_books, locations } = await load_existing();
  const existing_index = index_books(existing_books);

  const state = new_state();

  // --- API key wiring

  const key_input = $("#api-key");
  const key_status = $("#key-status");
  const update_key_status = () => {
    if (key_input.value) {
      key_status.textContent = `Key set (${key_input.value.length} chars). Saved locally.`;
      key_status.classList.add("set");
    } else {
      key_status.textContent = "No key set — using anonymous quota.";
      key_status.classList.remove("set");
    }
  };
  key_input.value = load_api_key();
  if (key_input.value) $("#advanced").open = true;
  update_key_status();
  key_input.addEventListener("input", () => {
    save_api_key(key_input.value.trim());
    update_key_status();
  });

  // --- Render functions tied to state

  const rerender = (opts = {}) => {
    if (!opts.skip_book_render) render_books(state, rerender);
    render_outputs(state);
  };

  // --- Type radio buttons

  const type_row = $("#txn-type-row");
  type_row.replaceChildren(
    ...TXN_TYPES.map(([value, label]) =>
      el("label", { class: "inline" },
        el("input", {
          type: "radio",
          name: "txn-type",
          value,
          checked: value === state.txn.type ? "" : false,
          onchange: (e) => {
            state.txn.type = e.target.value;
            render_txn_type_fields(state);
            rerender();
          },
        }),
        label,
      ),
    ),
  );
  render_txn_type_fields(state);

  // --- Simple text fields wired into state.txn

  const wire_field = (id, key, source = "txn") => {
    const input = $(id);
    input.value = state[source][key];
    input.addEventListener("input", (e) => {
      state[source][key] = e.target.value;
      rerender({ skip_book_render: true });
    });
  };

  wire_field("#txn-date", "date");
  wire_field("#txn-cost", "cost");
  wire_field("#txn-giver", "giver");
  wire_field("#txn-receiver", "receiver");
  wire_field("#txn-note", "note");

  wire_field("#new-loc-id", "id", "new_location");
  wire_field("#new-loc-name", "name", "new_location");
  wire_field("#new-loc-address", "address", "new_location");
  wire_field("#new-loc-note", "note", "new_location");

  $("#new-loc-type").addEventListener("change", (e) => {
    state.new_location.type = e.target.value;
    rerender({ skip_book_render: true });
  });

  // --- Location picker

  const loc_input = $("#txn-location");
  const picker = $("#location-picker");
  loc_input.addEventListener("focus", () => {
    render_location_dropdown(state, locations, rerender);
    picker.classList.add("open");
  });
  loc_input.addEventListener("input", () => {
    render_location_dropdown(state, locations, rerender);
    picker.classList.add("open");
  });
  document.addEventListener("click", (e) => {
    if (!picker.contains(e.target)) picker.classList.remove("open");
  });

  // --- Lookup button

  const lookup_btn = $("#lookup-btn");
  const lookup_status = $("#lookup-status");
  const isbn_input = $("#isbn-input");

  const run_lookup = async () => {
    const isbns = parse_isbns(isbn_input.value);
    if (!isbns.length) {
      lookup_status.textContent = "No valid ISBNs found in input.";
      lookup_status.classList.add("error");
      return;
    }
    lookup_status.classList.remove("error");
    lookup_btn.disabled = true;
    lookup_btn.textContent = "Looking up…";
    lookup_status.textContent = `Looking up ${isbns.length} ISBN${isbns.length === 1 ? "" : "s"}…`;

    const key = key_input.value.trim();
    const results = await Promise.all(
      isbns.map((isbn) =>
        lookup_with_fallback(isbn, key).then((r) => ({
          query: isbn,
          ...r,
        })),
      ),
    );

    // Append results to existing state (so multiple batches work).
    for (const r of results) {
      const record = record_from_lookup(r.query, r, existing_index);
      record.source = r.source;
      state.books.push(record);
    }

    isbn_input.value = "";
    lookup_btn.disabled = false;
    lookup_btn.textContent = "Look up";
    const found = results.filter((r) => !r.not_found).length;
    lookup_status.textContent = `Added ${found} of ${results.length}.`;
    rerender();
  };

  lookup_btn.addEventListener("click", run_lookup);
  isbn_input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run_lookup();
  });

  // --- Copy buttons

  for (const btn of $$("button.copy")) {
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.dataset.copy);
      const text = target.value;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        target.select();
        document.execCommand("copy");
      }
      const original_text = btn.textContent;
      btn.textContent = "Copied ✓";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = original_text;
        btn.classList.remove("copied");
      }, 1500);
    });
  }

  // First render
  rerender();
};

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p class="status error" style="padding:1rem;">Failed to load: ${err.message}</p>`,
  );
});
