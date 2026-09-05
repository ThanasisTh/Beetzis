# Wedding Table Planner

A static, client-side tool for planning wedding seating. No backend, no
build step — open `index.html` or serve the folder statically.

## How it works

1. **Guest list** — add guest names one at a time in the sidebar.
2. **Add tables** — pick a shape (Round, Oval, Rectangular/Banquet, Square,
   or Sweetheart) and a seat count, then add the table to the floor plan.
3. **Arrange the room** — press and drag a table's header to move it
   anywhere on the canvas.
4. **Seat guests** — press and drag a name from the guest list onto a
   table. Each table shows a `seated/capacity` badge and refuses drops once
   it's full. Drag a seated guest back to the guest list, or click its `✕`,
   to unseat them.

Everything is saved to the browser's local storage automatically, so a
reload keeps your layout. "Clear everything" wipes it.

Drag-and-drop is implemented with pointer events (not the HTML5 drag API)
so it works with both mouse and touch/mobile.
