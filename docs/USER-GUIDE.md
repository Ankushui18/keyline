# User guide

Everything you can do in Keyline, from the first icon to a delivered set.

- [First run](#first-run)
- [The three surfaces](#the-three-surfaces)
- [Pages, artboards and the frame](#pages-artboards-and-the-frame)
- [Tools](#tools)
- [Tool-specific behaviour](#tool-specific-behaviour)
- [The Design inspector](#the-design-inspector)
- [Constraints](#constraints)
- [Fills, regions and stroke widths](#fills-regions-and-stroke-widths)
- [Parametric groups](#parametric-groups)
- [The icon-set view and consistency check](#the-icon-set-view-and-consistency-check)
- [Families and QA](#families-and-qa)
- [Import and tidy](#import-and-tidy)
- [Export](#export)
- [Motion](#motion)
- [Command bar and on-device edits](#command-bar-and-on-device-edits)
- [Collaboration](#collaboration)
- [Settings](#settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Saving and recovery](#saving-and-recovery)

---

## First run

`npm run dev` opens the dashboard, not an empty canvas. Your files are listed here; nothing is
stored on a server.

Starting points:

| Card | Result |
|---|---|
| **Icon set** | One 24 px frame, sized for icon work. |
| **Logo or mark** | A 512 × 512 frame. |
| **Import a file** | SVG or a `.keyline.json` backup, from the file picker or by dropping it on the dashboard. |
| **Open a sample** | A small drawing built with constraints and regions, useful for exploring. |

The dashboard has search, filters (**All**, **Icon sets**, **Logos**, **Imported**), and a
per-file menu for **Rename**, **Duplicate** and **Delete** (undoable for a few seconds).

The first icon start reuses the untouched auto-generated starter artboard, so you end up with
one frame — the one you chose — instead of a frame beside an unused default. Deliberately created
blank frames are always listed and preserved.

---

## The three surfaces

| Surface | How to reach it | Purpose |
|---|---|---|
| **Dashboard** | Home button, or `Ctrl/⌘ K` → *All files* | Local file library, import, new set. |
| **Icon-set view** | Toolbar **Set**, or command bar → *See the whole icon set* | Thumbnails of every icon, search, grid toggle, consistency summary. |
| **Editor** | Open any file or start a new one | Draw, constrain, inspect, export. |

The editor has a top bar (file name, save status, undo/redo, Share, Export, renderer switch), a
left tool rail, the canvas, an optional layers column, and the right **Layers + Design** sidebar.
Panels are collapsible; the divider between Layers and Design is draggable and keyboard
operable, and both width and split height persist on the device.

---

## Pages, artboards and the frame

- A **document** contains **pages**; a page contains **artboards** (frames). A typical icon file
  has one page and one artboard per icon.
- Add frames from the **More (⋯)** menu (New 24×24 / 32×32 / 48×48 frame, or a custom size), the
  command bar (`Ctrl/⌘ K`), or the Layers panel context menu.
- **Duplicate** copies an artboard with its content; the copy gets fresh IDs.
- **Delete** removes selected artboards as one undoable step (no modal confirmation; use
  `Ctrl/⌘ Z` to restore).
- The **Frame** block in Design edits X/Y, width/height, presets (16/24/32/48), and background; it
  can also duplicate the active frame.
- **Flow** buttons arrange selected frames once. They are one-shot actions, not a persistent
  auto-layout engine.
- Frame clipping, frame rotation and frame corner rounding are intentionally unavailable.

> **Artboard bounds matter for export.** SVG and PNG default to the artboard rectangle, which
> preserves transparent padding — important for consistent icon spacing. Switch to artwork
> bounds only when you deliberately want a tight crop.

---

## Tools

Press `Enter` on a selected object to edit its points; `Enter` or `Escape` leaves point editing.

A selected object shows a frame with eight square resize handles, drawn on the object's own axes so
it rotates with the shape. The frame also prints its size (`W × H`, the object's own width and height) on a small blue pill
whenever the selection is large enough for the readout to fit. The pill hangs under the bottom edge
and turns with the shape, but never renders upside down: past a quarter turn it moves to the top
edge and reads the right way up. There is no separate
rotate handle: as in Figma, move the pointer just outside a corner and it becomes a rotate arrow.

- Drag a corner or edge handle to resize — `Shift` on a corner keeps the aspect ratio.
- Drag just outside a corner, where the cursor turns into a rotate arrow, to rotate — `Shift`
  snaps to 15° steps. The `Rotation` field and the 90° button in Design do the same thing by
  number, about the same centre, so a shape never leaves its artboard when you type an angle.
- Dragging anywhere else inside the frame moves the object, so `Alt`-drag still duplicates.
- Several selected objects share one axis-aligned frame; resizing and rotating there apply to the
  whole selection at once.

Every resize and rotation is one undoable step. Artboards keep their own handles, shown only while
a frame is selected; resizing a frame never scales the artwork inside it.

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Object selection; `Enter` enters point editing. |
| Pen | `P` | Click for corners, drag for Bézier handles. |
| Pencil | `N` | Freehand path, simplified. |
| Brush | `J` | Freehand stroke with width behaviour. |
| Rectangle | `R` | Drag to draw. |
| Rounded rectangle | `⇧ R` | Radius is set in the inspector. |
| Ellipse | `U` | Hold `Shift` for a circle. |
| Polygon | `G` | Side count in the inspector. |
| Star | `S` | Point count and inner ratio in the inspector. |
| Line | `\` | Straight geometry segment. |
| Construction line | `⇧ \` | Finite or infinite guide; excluded from export. |
| Arc | `A` | Native circular arc. |
| Shape builder | `B` | Merge/subtract by dragging across regions. |
| Paint | `⇧ B` | Bind a solid fill to a region. |
| Cut | `C` (or `X` in point mode) | Split a segment at a point. |
| Bend | `D` | Push a segment into curvature. |
| Fillet | `F` | Round a corner with a true tangent arc. |
| Variable width | `W` | Add per-segment width points. |
| Offset | `O` | Create an offset path at a set distance. |
| Lasso | `L` (or `Q` in point mode) | Bulk-select points. |
| Eraser | `E` | Remove segments; heal gaps. |

Tool defaults (line width, cap, join, fill) are set in **Settings → General** and apply to newly
drawn shapes.

---

## Tool-specific behaviour

- **Fillet** — choose a radius in Design, then click a corner shared by two line segments. The
  operation trims both lines, inserts a native tangent arc, and adds hard radius and tangency
  constraints in one undoable step. Fillets are arcs, not Bézier approximations.
- **Paint** — hover shows striped face feedback, click binds a solid fill to the region's stable
  ID, `Alt`-click clears it. The fill follows reshaping because it is tied to topology.
- **Variable width** — click a segment to add a width point; drag the round centre to move it or
  the square ends to resize. Width data affects rendering and is outlined on export; it never
  enters solver topology.
- **Offset** — set the distance in Design, click a segment; hold `Alt/Option` for the opposite
  side. Offsets create new typed geometry with fresh IDs and preserve the source.
- **Cut** — click a segment to split it at the nearest point; endpoints are shared correctly.
- **Bend** — drag a segment to curve it. Handle mirroring (**Free**, **Angle**, **Mirror**) is in
  Design.
- **Eraser** — click a segment to remove it and its direct constraints atomically. Click a
  selected gap endpoint to heal with a line, or `Alt`-click for an arc.
- **Lasso** — draw around points, then use Align H, Align V, Distribute or Symmetry in Design.
- **Shape builder** — drag across regions to merge; modifier behaviour is shown in the tool hint.

---

## The Design inspector

The inspector is contextual. Depending on selection you will see:

| Block | Contents |
|---|---|
| **Frame** | X/Y, width/height, presets, background, duplicate, Flow arrangements. |
| **Position** | X/Y, rotation, flip horizontal/vertical. |
| **Size** | Width/height with aspect lock, corner radii. |
| **Appearance** | Opacity, fills (colour, opacity, visibility), stroke (colour, width, cap, join, alignment, dash, visibility). |
| **Point / segment** | Coordinates, handle modes (corner, smooth, symmetric), segment role and construction extent. |
| **Constraints** | Applied constraints, priority, diagnostics. |
| **Parametric group** | Transform type, axis/reference, count, spread, centre. |
| **Geometry family** | Source/variant membership, propagation preview, overrides, QA. |
| **Export variables** | Public controls exposed to React/CSS export. |

Design fields accept expressions such as `24/2` or `12+4`, commit on `Enter` or blur, and cancel
with `Escape`. Arrow keys step the value (`Shift` ×10, `Alt` ×0.1). Other numeric fields commit on
`Enter` or blur and revert on `Escape`.

---

## Constraints

Open with `K` or the **Constraints** button. Eleven types are available:

`parallel` · `perpendicular` · `tangent` · `symmetric` · `equal_length` · `fixed_distance` ·
`fixed_angle` · `fixed_radius` · `horizontal` · `vertical` · `coincident`

Each constraint has a priority:

- **Hard** — must hold; a conflicting commit is rejected and rolled back.
- **Medium** — preferred, traded off against other medium constraints.
- **Soft** — a hint the solver may relax.

Apply constraints from the palette after selecting geometry, or right-click a selection for the
contextual menu. The diagnostics panel lists conflicts with a suggestion; nothing invalid reaches
the canvas.

Solving is deterministic: sorted inputs, fixed iteration limit, fixed tolerance. The same
document and constraints therefore produce the same result on every machine and in both solvers.

---

## Fills, regions and stroke widths

- Drawings are **networks of segments**. Closed boundaries produce **regions**.
- Region fills are stable across reshaping because they are keyed by boundary segments, not by a
  frozen outline.
- Compound shapes (holes) use an explicit fill rule (`nonzero` or `evenodd`) shared by Canvas,
  WebGL, hit testing and SVG export.
- Object appearance (fill and stroke) is separate from region fills. Both can coexist.
- **Construction lines** are excluded from export and from region detection.

---

## Parametric groups

Select artwork paths and create a **Mirror** or **Radial Repeat** group from Design.

- Mirror can use an arbitrary angle or a live construction line as its axis.
- Radial repeat uses a live construction anchor as its centre, with count, spread and start angle.
- Instances are **virtual**: they are evaluated by Canvas, WebGL and SVG export but never cloned
  into the graph. Editing the source updates every instance.
- Group parameters and references are persisted and undoable.

---

## The icon-set view and consistency check

**Set** in the toolbar (or the command bar) shows every icon frame on the page as a thumbnail,
with a search box and a pixel-grid toggle. Click a tile to open that frame.

**Check icons** (`Ctrl/⌘ ⇧ C`) analyses the whole set:

| Check | What it flags |
|---|---|
| **Line width** | Objects whose stroke width differs from the most common width. |
| **Line ends** | Objects whose cap/join pair differs from the most common pair. |
| **Safe area** | Artwork closer to the frame edge than the set's padding. |
| **Grid** | Bounds that do not land on half-pixel positions, which causes blurry 1× rendering. |
| **Small stroke** | Strokes too thin to read at 16 px. |

Checks list the offending objects and, where a single target style is known, offer a **Fix** that
applies as one undoable change. Clicking an issue selects the object on the canvas.

Consistency checks are guidance for icon designers, not a correctness guarantee; deliberate
differences are allowed.

---

## Families and QA

A **geometry family** links a source object to variants.

1. Select an object and use **Create linked variant** in Design's **Geometry family** section.
2. Edits to the source can be propagated to variants with **Review geometry impact**; a preview
   shows what will change before you apply it.
3. Intentional differences become **overrides**, stored against source IDs so they survive
   ordinary variant edits.
4. Conflicts offer explicit choices: skip, replace, keep local, map compatible topology, or
   detach the variant.
5. **Family QA** checks topology, naming, size, stroke and bounds. Selected fixes apply as one
   transaction. `FamilyCollectionDialog` rolls up every family and its delivery status.

**Appearance rules** are the styling counterpart: a named rule shared by objects. Geometry stays
independent; style propagates transactionally.

---

## Import and tidy

Drop an SVG on the dashboard (or use the empty-canvas start panel), or choose **Import**.

- Path data, transforms, styles, caps, joins and simple CSS rules are parsed into Keyline
  geometry.
- If cleanup is possible, a **tidy** dialog appears first with switchable rules:
  - **Straighten** near-horizontal/near-vertical lines (within a small angle).
  - **Merge collinear** points that add no shape information.
  - **Snap to grid** (opt-in, because it moves points).
- The dialog reports how many points will be removed; importing is always cancellable.
- Imported content is placed as a new object and is fully undoable.

---

## Export

**Export** opens the delivery dialog.

### Tabs

| Tab | Output |
|---|---|
| **SVG & PNG** | Production SVG and raster exports, with preview and code. |
| **React Component** | A dependency-free React + TypeScript component with baked geometry and typed props for exposed variables. |
| **CSS Variables** | Custom properties for the same exposed controls. |

### Options

- **Bounds** — artboard (preserves padding) or artwork (tight).
- **Background** — include the artboard background or stay transparent.
- **Formats** — SVG, PNG (1×, 2×, 3×, or a custom size), or both.
- **File naming** — a pattern using `{name}`, `{scale}` and `{format}`; collisions are reported
  before download.
- **Presets** — save and reuse delivery settings.
- **Family change manifest** — include a human-readable QA/change report in the ZIP.
- **Artboards** — choose one, several or all (searchable).
- **Export variables** — expose stroke width, fill colour, scale or opacity within bounded
  ranges; they persist in the snapshot and are undoable.

SVG output materializes mirror/repeat instances, keeps compatible native arcs, outlines
variable-width strokes, emits region fills with the correct rule, rounds coordinates to three
decimals, and omits editor metadata and source IDs.

PNG output is limited to 16,384 px per side and 268,435,456 px² total; exceeding either shows an
explicit error instead of silently clamping.

### What is not exported

Construction lines, editor metadata, source IDs, selection state and solver diagnostics.

---

## Motion

**Motion** (`M`) turns the current artboard's SVG into a self-contained animated SVG using CSS
keyframes. The drawing is copied; the document is not modified.

- Presets: **Draw on**, **Pulse**, **Swing**, **Pop in**.
- Controls: duration, delay, stagger, easing, loop.
- You can copy the generated CSS or download the animated SVG.
- **Reduce motion** in Settings disables editor animation. Motion export is separate and stays
  opt-in.

Motion is CSS-only: no JavaScript ships inside the exported SVG.

---

## Command bar and on-device edits

`Ctrl/⌘ K` opens the command bar. It searches actions, tools, frames, export, sharing, families
and settings, and disables actions that cannot run (for example Export with an empty document)
with a reason.

The same field accepts short appearance commands:

```text
thinner          thicker          line 1.5
round ends       sharp corners    flat ends
no fill          fill #0d99ff     line color black
opacity 60%
```

This is a **deterministic phrase reader**, not an AI model. It runs entirely on-device. Anything
it cannot parse gets an explanation and examples instead of a guess, and every applied change is
shown as before → after before it is committed.

---

## Collaboration

**Share** creates a room link. Opening that link elsewhere joins the room.

- Edits propagate as operations and replay in a canonical order.
- Offline edits queue locally and resynchronise on reconnect.
- Presence shows names, colours, cursors and selections.
- The toolbar reports connecting, synced, offline and error states.
- Joining a room creates a **separate local file identity**; a peer cannot overwrite your file's
  storage identity.

Turning sharing off disconnects this device. It does **not** revoke the link or delete copies
peers already hold. See [COLLABORATION.md](COLLABORATION.md#deployment-boundary).

---

## Settings

| Section | Contents |
|---|---|
| **General** | Default line width, line ends, corners, fill new shapes. |
| **Canvas and grid** | Pixel grid. |
| **Performance** | Drawing engine (Standard/GPU), reduce motion, shortcut summary. |
| **Shortcuts** | Full keyboard reference. |
| **AI and connections** | Plain statement of what is and is not connected. |

Settings that affect drawing persist per device; renderer and sidebar size are also remembered.

---

## Keyboard shortcuts

Modifier is `Ctrl` on Windows/Linux and `⌘` on macOS.

| Action | Keys |
|---|---|
| Select / Pen / Pencil / Brush | `V` / `P` / `N` / `J` |
| Rectangle / Rounded rect / Ellipse | `R` / `⇧ R` / `U` |
| Polygon / Star / Line / Arc | `G` / `S` / `\` / `A` |
| Construction line | `⇧ \` |
| Shape builder / Paint | `B` / `⇧ B` |
| Cut / Bend / Fillet | `C` / `D` / `F` |
| Variable width / Offset | `W` / `O` |
| Lasso / Eraser | `L` / `E` |
| Constraints | `K` |
| Command bar | `Ctrl/⌘ K` |
| Check icons | `Ctrl/⌘ ⇧ C` |
| Motion | `M` |
| Edit points | `Enter` |
| Flip horizontal / vertical | `⇧ H` / `⇧ V` |
| Copy / cut / paste | `Ctrl/⌘ C` / `X` / `V` |
| Undo / redo | `Ctrl/⌘ Z` / `Ctrl/⌘ ⇧ Z` |
| Nudge objects or points | Arrow keys (1 px), `Shift` + arrows (10 px) |
| Delete selection or point | `Delete` / `Backspace` |
| Pan | Wheel or two-finger scroll, `Shift` + wheel (horizontal), middle-drag, `Space` + drag |
| Zoom | `Ctrl/⌘` + wheel or pinch, `Ctrl/⌘ +` / `Ctrl/⌘ -` |

Shortcuts are ignored while typing in a field or while a dialog is open.

---

## Saving and recovery

- Every committed change schedules an autosave (500 ms debounce).
- The toolbar shows **Saving** and **Saved**; a failure shows an error state.
- Switching tabs or closing the page flushes pending work on a best-effort basis.
- If saving fails (blocked or full storage), download the `.keyline.json` copy offered in the
  error state. It contains the full snapshot and can be re-imported.
- Files appear on the dashboard only after their first edit.

Storage locations, reset steps and limits: [FAQ.md](FAQ.md#where-are-my-files-stored).
