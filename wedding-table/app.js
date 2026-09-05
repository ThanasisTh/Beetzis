(() => {
  "use strict";

  const STORAGE_KEY = "wedding-table-planner-state-v1";

  const SHAPES = [
    { id: "round", label: "Round Table", defaultCapacity: 8, cssClass: "shape-round" },
    { id: "oval", label: "Oval Table", defaultCapacity: 10, cssClass: "shape-oval" },
    { id: "rect", label: "Rectangular / Banquet", defaultCapacity: 8, cssClass: "shape-rect" },
    { id: "square", label: "Square Table", defaultCapacity: 4, cssClass: "shape-square" },
    { id: "sweetheart", label: "Sweetheart Table", defaultCapacity: 2, cssClass: "shape-sweetheart" },
  ];

  function shapeById(id) {
    return SHAPES.find((s) => s.id === id) || SHAPES[0];
  }

  function uid(prefix) {
    return prefix + "-" + Math.random().toString(36).slice(2, 9);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      /* ignore corrupt storage */
    }
    return { guests: [], tables: [] };
  }

  let state = loadState();

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 2000);
  }

  // ---------- rendering ----------

  const unassignedListEl = document.getElementById("unassigned-list");
  const unassignedCountEl = document.getElementById("unassigned-count");
  const canvasEl = document.getElementById("canvas");
  const shapeSelectEl = document.getElementById("table-shape-input");
  const capacityInputEl = document.getElementById("table-capacity-input");

  function seatedCount(tableId) {
    return state.guests.filter((g) => g.tableId === tableId).length;
  }

  function render() {
    renderUnassignedList();
    renderTables();
  }

  function renderUnassignedList() {
    unassignedListEl.innerHTML = "";
    const unassigned = state.guests.filter((g) => g.tableId === null);
    unassigned.forEach((guest) => {
      unassignedListEl.appendChild(createGuestChip(guest, false));
    });
    unassignedCountEl.textContent = `${unassigned.length} unassigned guest${unassigned.length === 1 ? "" : "s"}`;
  }

  function createGuestChip(guest, seated) {
    const chip = document.createElement("li");
    chip.className = "chip" + (seated ? " seat-chip" : "");
    chip.dataset.guestId = guest.id;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = guest.name;
    chip.appendChild(nameSpan);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.type = "button";
    removeBtn.title = seated ? "Unseat" : "Remove guest";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (seated) {
        guest.tableId = null;
      } else {
        state.guests = state.guests.filter((g) => g.id !== guest.id);
      }
      saveState();
      render();
    });
    chip.appendChild(removeBtn);

    makeGuestDraggable(chip, guest.id);
    return chip;
  }

  function renderTables() {
    canvasEl.innerHTML = "";
    state.tables.forEach((table) => {
      canvasEl.appendChild(createTableElement(table));
    });
  }

  function createTableElement(table) {
    const shape = shapeById(table.shape);
    const card = document.createElement("div");
    card.className = "table-card";
    card.style.left = table.x + "px";
    card.style.top = table.y + "px";
    card.dataset.tableId = table.id;

    const handle = document.createElement("div");
    handle.className = "table-drag-handle";

    const nameSpan = document.createElement("span");
    nameSpan.className = "table-name";
    nameSpan.textContent = table.name;
    handle.appendChild(nameSpan);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn";
    deleteBtn.type = "button";
    deleteBtn.title = "Delete table";
    deleteBtn.textContent = "✕";
    deleteBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.guests.forEach((g) => { if (g.tableId === table.id) g.tableId = null; });
      state.tables = state.tables.filter((t) => t.id !== table.id);
      saveState();
      render();
    });
    handle.appendChild(deleteBtn);

    makeTableDraggable(handle, card, table.id);
    card.appendChild(handle);

    const shapeDiv = document.createElement("div");
    shapeDiv.className = "table-shape " + shape.cssClass;

    const inner = document.createElement("ul");
    inner.className = "shape-inner guest-list";
    inner.dataset.role = "table-drop";
    inner.dataset.tableId = table.id;
    inner.style.listStyle = "none";
    inner.style.margin = "0";
    inner.style.padding = "0";

    const seated = state.guests.filter((g) => g.tableId === table.id);
    seated.forEach((guest) => inner.appendChild(createGuestChip(guest, true)));
    shapeDiv.appendChild(inner);

    const badge = document.createElement("div");
    const count = seated.length;
    badge.className = "capacity-badge" + (count >= table.capacity ? " full" : "");
    badge.textContent = `${count}/${table.capacity}`;
    shapeDiv.appendChild(badge);

    card.appendChild(shapeDiv);
    return card;
  }

  // ---------- guest drag-and-drop (assign to table / unassign) ----------

  function positionGhost(ghost, x, y) {
    ghost.style.left = x + "px";
    ghost.style.top = y + "px";
  }

  function clearDropHighlights() {
    document.querySelectorAll(".drop-hover").forEach((el) => el.classList.remove("drop-hover"));
  }

  function highlightDropTarget(x, y) {
    clearDropHighlights();
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const zone = el.closest('[data-role="table-drop"], [data-role="unassigned-drop"]');
    if (zone) zone.classList.add("drop-hover");
  }

  function findDropZone(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return el.closest('[data-role="table-drop"], [data-role="unassigned-drop"]');
  }

  function makeGuestDraggable(chipEl, guestId) {
    chipEl.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();

      const rect = chipEl.getBoundingClientRect();
      const ghost = chipEl.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.width = rect.width + "px";
      document.body.appendChild(ghost);
      positionGhost(ghost, e.clientX, e.clientY);
      chipEl.classList.add("dragging-source");

      function onMove(ev) {
        positionGhost(ghost, ev.clientX, ev.clientY);
        highlightDropTarget(ev.clientX, ev.clientY);
      }

      function onUp(ev) {
        document.removeEventListener("pointermove", onMove);
        clearDropHighlights();
        ghost.remove();
        chipEl.classList.remove("dragging-source");

        const zone = findDropZone(ev.clientX, ev.clientY);
        applyGuestDrop(guestId, zone);
      }

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    });
  }

  function applyGuestDrop(guestId, zone) {
    if (!zone) return;
    const guest = state.guests.find((g) => g.id === guestId);
    if (!guest) return;

    if (zone.dataset.role === "unassigned-drop") {
      guest.tableId = null;
      saveState();
      render();
      return;
    }

    if (zone.dataset.role === "table-drop") {
      const tableId = zone.dataset.tableId;
      const table = state.tables.find((t) => t.id === tableId);
      if (!table) return;
      if (guest.tableId !== tableId && seatedCount(tableId) >= table.capacity) {
        showToast(`${table.name} is full`);
        return;
      }
      guest.tableId = tableId;
      saveState();
      render();
    }
  }

  // ---------- table drag-and-drop (position in space) ----------

  function makeTableDraggable(handleEl, cardEl, tableId) {
    handleEl.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();

      const canvasRect = canvasEl.getBoundingClientRect();
      const cardRect = cardEl.getBoundingClientRect();
      const offsetX = e.clientX - cardRect.left;
      const offsetY = e.clientY - cardRect.top;

      cardEl.classList.add("table-dragging");

      function onMove(ev) {
        let newLeft = ev.clientX - canvasRect.left + canvasEl.scrollLeft - offsetX;
        let newTop = ev.clientY - canvasRect.top + canvasEl.scrollTop - offsetY;
        newLeft = Math.max(0, newLeft);
        newTop = Math.max(0, newTop);
        cardEl.style.left = newLeft + "px";
        cardEl.style.top = newTop + "px";
      }

      function onUp() {
        document.removeEventListener("pointermove", onMove);
        cardEl.classList.remove("table-dragging");
        const table = state.tables.find((t) => t.id === tableId);
        if (table) {
          table.x = parseFloat(cardEl.style.left) || 0;
          table.y = parseFloat(cardEl.style.top) || 0;
          saveState();
        }
      }

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    });
  }

  // ---------- forms ----------

  function populateShapeSelect() {
    SHAPES.forEach((shape) => {
      const opt = document.createElement("option");
      opt.value = shape.id;
      opt.textContent = `${shape.label} (seats ${shape.defaultCapacity})`;
      shapeSelectEl.appendChild(opt);
    });
    capacityInputEl.value = SHAPES[0].defaultCapacity;
  }

  shapeSelectEl?.addEventListener("change", () => {
    capacityInputEl.value = shapeById(shapeSelectEl.value).defaultCapacity;
  });

  document.getElementById("guest-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("guest-name-input");
    const name = input.value.trim();
    if (!name) return;
    state.guests.push({ id: uid("guest"), name, tableId: null });
    input.value = "";
    saveState();
    render();
    input.focus();
  });

  document.getElementById("table-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("table-name-input");
    const name = nameInput.value.trim();
    if (!name) return;
    const shapeId = shapeSelectEl.value;
    const capacity = Math.max(1, parseInt(capacityInputEl.value, 10) || shapeById(shapeId).defaultCapacity);

    const index = state.tables.length;
    const columns = 5;
    const x = 40 + (index % columns) * 250;
    const y = 40 + Math.floor(index / columns) * 230;

    state.tables.push({
      id: uid("table"),
      name,
      shape: shapeId,
      capacity,
      x,
      y,
    });
    nameInput.value = "";
    saveState();
    render();
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    if (!confirm("Clear all guests and tables? This cannot be undone.")) return;
    state = { guests: [], tables: [] };
    saveState();
    render();
  });

  populateShapeSelect();
  render();
})();
