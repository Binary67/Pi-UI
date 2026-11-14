import { Check, ChevronDown, Search } from "lucide-react";
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

export type MenuItem = { key: string; label: string; group?: string };

type MenuProps = {
  /** An extra class of the menu, for its styles. */
  className?: string;
  icon: ReactNode;
  /** The text on the pill. */
  label: string;
  title: string;
  /** Items of the same group must be next to each other. */
  items: MenuItem[];
  /** The key of the current item. */
  selected: string;
  disabled: boolean;
  /** When set, the menu shows a search field with this placeholder. */
  searchPlaceholder?: string;
  /** Called when the menu opens. */
  onOpen?: () => void;
  /**
   * When set, and the search text is not the key of an item, the list ends with an item that creates it.
   * `label` gives the text of the item from the trimmed search text.
   */
  create?: { label: (name: string) => string; onCreate: (name: string) => void };
  onSelect: (key: string) => void;
};

/** A ghost pill that opens a list above it, in the style of a macOS menu. */
export function Menu({
  className,
  icon,
  label,
  title,
  items,
  selected,
  disabled,
  searchPlaceholder,
  onOpen,
  create,
  onSelect,
}: MenuProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // A run that starts closes the menu.
  if (open && disabled) setOpen(false);

  // Each word of the query must occur in the group or the label.
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = items.filter((item) =>
    terms.every((term) => `${item.group ?? ""} ${item.label}`.toLowerCase().includes(term)),
  );
  const name = query.trim();
  const showCreate = Boolean(create && name && !items.some((item) => item.key === name));
  const count = matches.length + (showCreate ? 1 : 0);
  const activeId = count ? `${id}-${active}` : undefined;

  // Focus the menu when it opens. A press outside the menu closes it.
  useEffect(() => {
    if (!open) return;
    (searchRef.current ?? listRef.current)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  function show() {
    onOpen?.();
    setQuery("");
    setActive(Math.max(items.findIndex((item) => item.key === selected), 0));
    setOpen(true);
  }

  /** Close the menu. After a key press, the focus goes back to the pill. After a click, it does not. */
  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }

  function choose(key: string, refocus: boolean) {
    close(refocus);
    if (key !== selected) onSelect(key);
  }

  function createItem(refocus: boolean) {
    close(refocus);
    create!.onCreate(name);
  }

  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (count) setActive((active + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
        return;
      case "Enter":
        event.preventDefault();
        if (matches[active]) choose(matches[active].key, true);
        else if (showCreate) createItem(true);
        return;
      case "Escape":
      case "Tab":
        event.preventDefault();
        close(true);
        return;
    }
  }

  return (
    <div className={className ? `menu ${className}` : "menu"} ref={rootRef}>
      <button
        ref={buttonRef}
        className="pill"
        onClick={() => (open ? setOpen(false) : show())}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon}
        <span className="pill-label">{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu-panel" onKeyDown={onKeyDown}>
          {searchPlaceholder !== undefined && (
            <div className="menu-search">
              <Search size={14} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                placeholder={searchPlaceholder}
                role="combobox"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={activeId}
              />
            </div>
          )}
          <div
            ref={listRef}
            id={`${id}-list`}
            className="menu-list"
            role="listbox"
            aria-label={title}
            tabIndex={-1}
            aria-activedescendant={searchPlaceholder === undefined ? activeId : undefined}
          >
            {matches.map((item, index) => (
              <Fragment key={item.key}>
                {item.group !== undefined && item.group !== matches[index - 1]?.group && (
                  <div className="menu-group" role="presentation">
                    {item.group}
                  </div>
                )}
                <div
                  id={`${id}-${index}`}
                  className={index === active ? "menu-item active" : "menu-item"}
                  role="option"
                  aria-selected={item.key === selected}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(item.key, false)}
                >
                  <span className="menu-check">{item.key === selected && <Check size={14} />}</span>
                  {item.label}
                </div>
              </Fragment>
            ))}
            {showCreate && (
              <div
                id={`${id}-${matches.length}`}
                className={active === matches.length ? "menu-item active" : "menu-item"}
                role="option"
                aria-selected={false}
                onPointerMove={() => setActive(matches.length)}
                onClick={() => createItem(false)}
              >
                <span className="menu-check" />
                {create!.label(name)}
              </div>
            )}
            {!count && <div className="menu-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}
