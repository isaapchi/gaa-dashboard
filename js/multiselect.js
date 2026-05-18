// Lightweight multi-select dropdown component.
//
// Wraps a hidden <select multiple> for state. Renders a trigger button that
// opens a panel with a search input and checkbox list. Selecting/deselecting
// checkboxes drives option.selected on the hidden select and dispatches a
// 'change' event so existing listeners (markStale, runQuery) still work.
//
// Usage:
//   MultiSelect.mount(wrapperEl)  // wrapperEl has data-target pointing at the <select> id
// or
//   MultiSelect.mountAll(rootEl)  // mounts every .ms-wrapper inside rootEl

const CARET_DOWN = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function buildTrigger() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ms-trigger';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="ms-trigger-label">All</span>' + '<span class="ms-trigger-caret">' + CARET_DOWN + '</span>';
  return btn;
}

function buildPanel(options) {
  const panel = document.createElement('div');
  panel.className = 'ms-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');

  panel.innerHTML = [
    '<div class="ms-panel-header">',
    '  <input type="search" class="ms-search" placeholder="Type to filter…" aria-label="Filter options">',
    '  <div class="ms-actions">',
    '    <button type="button" class="ms-action ms-action-all">Select all</button>',
    '    <span class="ms-action-sep">·</span>',
    '    <button type="button" class="ms-action ms-action-clear">Clear</button>',
    '  </div>',
    '</div>',
    '<div class="ms-list" role="listbox" aria-multiselectable="true"></div>',
  ].join('');

  const list = panel.querySelector('.ms-list');
  for (const opt of options) {
    const item = document.createElement('label');
    item.className = 'ms-item';
    item.setAttribute('role', 'option');
    item.dataset.value = opt.value;
    item.innerHTML = '<input type="checkbox" value="' + escAttr(opt.value) + '"' +
                     (opt.selected ? ' checked' : '') + '> ' +
                     '<span class="ms-item-label">' + escAttr(opt.label) + '</span>';
    list.appendChild(item);
  }

  return panel;
}

function updateTriggerLabel(wrapper) {
  const select = wrapper._select;
  const trigger = wrapper.querySelector('.ms-trigger-label');
  if (!trigger) return;
  const selected = Array.from(select.options).filter(o => o.selected);
  if (selected.length === 0) {
    trigger.textContent = select.dataset.empty === 'all' ? 'All' : 'None selected';
    trigger.classList.remove('ms-has-selection');
  } else if (selected.length === select.options.length) {
    trigger.textContent = 'All (' + selected.length + ')';
    trigger.classList.add('ms-has-selection');
  } else {
    trigger.textContent = selected.length + ' selected';
    trigger.classList.add('ms-has-selection');
  }
}

function syncCheckboxesFromSelect(wrapper) {
  const select = wrapper._select;
  const valueToSelected = new Map();
  for (const opt of select.options) valueToSelected.set(opt.value, opt.selected);
  wrapper.querySelectorAll('.ms-item input[type="checkbox"]').forEach(cb => {
    const want = !!valueToSelected.get(cb.value);
    if (cb.checked !== want) cb.checked = want;
  });
  updateTriggerLabel(wrapper);
}

function applySearch(panel, query) {
  const q = query.trim().toLowerCase();
  const items = panel.querySelectorAll('.ms-item');
  let visible = 0;
  items.forEach(item => {
    const label = item.querySelector('.ms-item-label').textContent.toLowerCase();
    const match = !q || label.indexOf(q) !== -1;
    item.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  let empty = panel.querySelector('.ms-empty');
  if (visible === 0) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'ms-empty';
      empty.textContent = 'No matches';
      panel.querySelector('.ms-list').appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

function closeAll() {
  document.querySelectorAll('.ms-wrapper.ms-open').forEach(w => {
    w.classList.remove('ms-open');
    const panel = w.querySelector('.ms-panel');
    if (panel) panel.hidden = true;
    const trigger = w.querySelector('.ms-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

// Wire global handlers once (idempotent).
let _wiredGlobal = false;
function wireGlobalHandlers() {
  if (_wiredGlobal) return;
  _wiredGlobal = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ms-wrapper')) closeAll();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });
}

function mount(wrapper) {
  if (wrapper._mounted) return;
  wireGlobalHandlers();
  const targetId = wrapper.dataset.target;
  const select = document.getElementById(targetId);
  if (!select) {
    console.warn('MultiSelect: no select with id', targetId);
    return;
  }
  wrapper._select = select;
  select.hidden = true;
  // Read options from the select to build the panel
  const options = Array.from(select.options).map(o => ({
    value: o.value, label: o.text, selected: o.selected,
  }));

  const trigger = buildTrigger();
  const panel = buildPanel(options);
  wrapper.insertBefore(trigger, select);
  wrapper.appendChild(panel);

  // Toggle open
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !wrapper.classList.contains('ms-open');
    closeAll();
    if (willOpen) {
      wrapper.classList.add('ms-open');
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const search = panel.querySelector('.ms-search');
      // Focus search shortly after layout (avoid scroll-into-view race)
      requestAnimationFrame(() => search.focus());
    }
  });

  // Checkbox interaction → update hidden select + dispatch change
  panel.querySelector('.ms-list').addEventListener('change', (e) => {
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
    const opt = Array.from(select.options).find(o => o.value === cb.value);
    if (opt) opt.selected = cb.checked;
    updateTriggerLabel(wrapper);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Search
  const search = panel.querySelector('.ms-search');
  search.addEventListener('input', (e) => applySearch(panel, e.target.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });

  // Select all / Clear (within panel)
  panel.querySelector('.ms-action-all').addEventListener('click', () => {
    panel.querySelectorAll('.ms-item').forEach(item => {
      if (item.style.display !== 'none') {
        const cb = item.querySelector('input[type=checkbox]');
        cb.checked = true;
        const opt = Array.from(select.options).find(o => o.value === cb.value);
        if (opt) opt.selected = true;
      }
    });
    updateTriggerLabel(wrapper);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  panel.querySelector('.ms-action-clear').addEventListener('click', () => {
    panel.querySelectorAll('.ms-item input[type=checkbox]').forEach(cb => {
      cb.checked = false;
      const opt = Array.from(select.options).find(o => o.value === cb.value);
      if (opt) opt.selected = false;
    });
    updateTriggerLabel(wrapper);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Listen for external programmatic changes (e.g., applyStateToForm)
  select.addEventListener('change', (e) => {
    // Only re-sync if change didn't originate from this component
    if (e.isTrusted === false && e._fromMultiSelect) return;
    syncCheckboxesFromSelect(wrapper);
  });

  // Initial label
  updateTriggerLabel(wrapper);
  wrapper._mounted = true;
}

function mountAll(root) {
  (root || document).querySelectorAll('.ms-wrapper').forEach(mount);
}

export const MultiSelect = { mount, mountAll, syncFromSelect: syncCheckboxesFromSelect, updateLabel: updateTriggerLabel };
export default MultiSelect;
