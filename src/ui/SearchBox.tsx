import { useStore } from "../store";

/** Search input bound to the store's `searchQuery`. Filters the Floor Contents
 *  unit list and the CameraPanel camera list, and dims non-matching units on the
 *  canvas (see MapView). Purely a filter — never changes selection. */
export default function SearchBox({ placeholder }: { placeholder?: string }) {
  const searchQuery = useStore((s) => s.searchQuery);
  const setSearch = useStore((s) => s.setSearch);

  return (
    <div className="searchbox">
      <input
        value={searchQuery}
        placeholder={placeholder ?? "Search name, tenant, or type…"}
        onChange={(e) => setSearch(e.target.value)}
      />
      {searchQuery && (
        <button className="searchclear" title="Clear search" onClick={() => setSearch("")}>
          ✕
        </button>
      )}
    </div>
  );
}
