// A windowed list: only the rows in view exist in the DOM, so folders with tens of thousands of entries stay fast.
export class VirtualList {
  constructor({ body, rowHeight = 28, renderRow, onSelect, onOpen, onContext, keyOf }) {
    this.body = body;
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.onSelect = onSelect;
    this.onOpen = onOpen;
    this.onContext = onContext;
    this.keyOf = keyOf;
    this.items = [];
    this.selected = -1;
    this.marked = new Set();   // extra selected rows (Ctrl or Shift click)
    this.pool = [];
    this.spacer = document.createElement('div');
    this.spacer.className = 'list-spacer';
    body.replaceChildren(this.spacer);
    body.addEventListener('scroll', () => this.draw(), { passive: true });
    new ResizeObserver(() => this.draw()).observe(body);
    body.addEventListener('keydown', event => this.#key(event));
    body.addEventListener('click', event => {
      const index = this.#indexAt(event);
      if (index < 0) return;
      if (event.ctrlKey || event.metaKey) {
        if (this.selected >= 0) this.marked.add(this.selected);
        if (this.marked.has(index)) this.marked.delete(index); else this.marked.add(index);
        this.selected = index;
        this.draw();
        this.onSelect?.(this.items[index], index);
      } else if (event.shiftKey && this.selected >= 0) {
        const anchor = this.anchor ?? this.selected;
        this.marked = new Set();
        for (let at = Math.min(anchor, index); at <= Math.max(anchor, index); at++) this.marked.add(at);
        this.anchor = anchor;
        this.selected = index;
        this.draw();
      } else {
        this.marked = new Set();
        this.anchor = index;
        this.select(index);
      }
    });
    body.addEventListener('dblclick', event => {
      const index = this.#indexAt(event);
      if (index >= 0) this.onOpen?.(this.items[index], index);
    });
    body.addEventListener('contextmenu', event => {
      const index = this.#indexAt(event);
      if (index < 0) return;
      event.preventDefault();
      if (this.marked.has(index)) { this.selected = index; this.draw(); }
      else { this.marked = new Set(); this.select(index, { focus: true }); }
      this.onContext?.(this.items[index], event);
    });
  }

  #indexAt(event) {
    const row = event.target.closest('.list-row');
    return row ? Number(row.dataset.index) : -1;
  }

  setItems(items, { keepScroll = false, selectKey = null } = {}) {
    this.items = items;
    this.spacer.style.height = items.length * this.rowHeight + 'px';
    if (!keepScroll) this.body.scrollTop = 0;
    this.marked = new Set();
    this.selected = selectKey === null ? -1 : items.findIndex(item => this.keyOf(item) === selectKey);
    for (const row of this.pool) row.remove();
    this.pool = [];
    this.draw();
    if (this.selected >= 0) this.scrollTo(this.selected);
  }

  scrollTo(index) {
    const top = index * this.rowHeight;
    const view = this.body.clientHeight;
    if (top < this.body.scrollTop) this.body.scrollTop = top;
    else if (top + this.rowHeight > this.body.scrollTop + view) this.body.scrollTop = top + this.rowHeight - view;
    this.draw();
  }

  select(index, { scroll = true, notify = true, focus = false } = {}) {
    if (index < 0 || index >= this.items.length) return;
    this.selected = index;
    if (scroll) this.scrollTo(index);
    this.draw();
    if (focus) this.body.focus();
    if (notify) this.onSelect?.(this.items[index], index);
  }

  selectedItem() { return this.items[this.selected] ?? null; }

  // Every selected item, in list order (a single selection when nothing is marked).
  selectedItems() {
    if (!this.marked.size) return this.selected >= 0 ? [this.items[this.selected]] : [];
    return [...this.marked].sort((a, b) => a - b).map(index => this.items[index]);
  }

  draw() {
    const view = this.body.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.body.scrollTop / this.rowHeight) - 4);
    const last = Math.min(this.items.length, Math.ceil((this.body.scrollTop + view) / this.rowHeight) + 4);
    const needed = Math.max(0, last - first);
    while (this.pool.length < needed) {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.setAttribute('role', 'option');
      this.spacer.append(row);
      this.pool.push(row);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const row = this.pool[i];
      const index = first + i;
      if (i >= needed) { row.hidden = true; continue; }
      row.hidden = false;
      const item = this.items[index];
      row.style.transform = 'translateY(' + index * this.rowHeight + 'px)';
      row.setAttribute('aria-selected', String(index === this.selected || this.marked.has(index)));
      if (row.dataset.index !== String(index) || row.dataset.key !== this.keyOf(item) || row.dataset.stamp !== String(this.stamp ?? 0)) {
        row.dataset.index = String(index);
        row.dataset.key = this.keyOf(item);
        row.dataset.stamp = String(this.stamp ?? 0);
        this.renderRow(row, item);
      }
    }
  }

  // Force every visible row to be rebuilt (after a sort or a view change).
  refresh() { this.stamp = (this.stamp ?? 0) + 1; this.draw(); }

  #key(event) {
    const count = this.items.length;
    if (!count) return;
    const page = Math.max(1, Math.floor(this.body.clientHeight / this.rowHeight) - 1);
    const at = this.selected < 0 ? 0 : this.selected;
    let next = null;
    if (event.key === 'ArrowDown') next = Math.min(count - 1, this.selected < 0 ? 0 : at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'PageDown') next = Math.min(count - 1, at + page);
    else if (event.key === 'PageUp') next = Math.max(0, at - page);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (event.key === 'Enter' && this.selected >= 0) { event.preventDefault(); this.onOpen?.(this.items[this.selected], this.selected); return; }
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      if (this.selected < 0) return;
      event.preventDefault();
      const row = this.pool.find(candidate => candidate.dataset.index === String(this.selected));
      const box = row?.getBoundingClientRect() ?? this.body.getBoundingClientRect();
      this.onContext?.(this.items[this.selected], { clientX: box.left + 40, clientY: box.bottom, preventDefault() {} });
      return;
    }
    if (next === null) return;
    event.preventDefault();
    this.select(next);
  }
}
