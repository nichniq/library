const fetch_json = url => fetch(url).then(x => x.json());
const compare_title = (a, b) => a.title.localeCompare(b.title);
const es_to_obj = entries => Object.fromEntries(entries);

const book_title = book => book.title +
    (book.subtitle ? `: ${book.subtitle}` : "") +
    (book.series ? ` (${book.series})` : "");

const txn_date = txn => {
  const date = new Date(txn?.date);
  return !isNaN(date.getTime()) ? date.toLocaleDateString("en", {
    day: "2-digit", month: "2-digit", year: "2-digit"
  }) : null;
};

export default async function() {
  const raw_books = await fetch_json("books.json");
  const raw_txns = await fetch_json("transactions.json");
  const raw_locations = await fetch_json("locations.json");

  const sorted_books = raw_books.toSorted(compare_title);
  const locations_map = es_to_obj(raw_locations.map(l => [ l.id, l ]));
  const txns_map = es_to_obj(raw_txns.flatMap(t => t.books.map(b => [ b, t ])));

  return sorted_books.map(book => {
    const txn = txns_map[book.disambiguation || book.title];
    const location = locations_map[txn?.location];
    return {
      title: book_title(book),
      date: txn_date(txn),
      isbn: book.isbn13 ?? book.isbn10,
      location: txn?.type === "purchased" ? location?.name : null,
      href: book.external,
    };
  });
}
