# Foldworks component prompts for the Triplex workbench

These prompts are intended to be copied into the Foldworks/Foldkit repository. They describe
general-purpose `@foldkit/ui` primitives rather than Triplex-specific widgets. Triplex can then
compose them into its bitemporal, provenance-aware database workbench.

## 1. Headless DataGrid

> Implement a production-quality, headless `DataGrid` component for `@foldkit/ui`, following the
> package's existing Elm Architecture and `toView` conventions. The component must own interaction
> state but not application rows or cell values. Its public model and messages must be Effect
> Schemas, and all effects such as focus, measurement, and scrolling must be explicit Commands.
>
> Support WAI-ARIA grid semantics, roving focus, arrow/Home/End/PageUp/PageDown navigation,
> row/column/cell selection, Shift range selection, Cmd/Ctrl additive selection, Enter/F2 edit
> requests, Escape cancellation, clipboard copy requests, sortable column-header requests, and
> resize/reorder requests. Emit typed out-messages; do not mutate host data. Permit controlled
> single-cell editing through render inputs without prescribing an editor.
>
> Compose with the existing `VirtualList` rather than introducing a second virtualization engine.
> Cover fixed and variable row heights, sticky row/column headers, horizontal virtualization,
> stable cell identity, focus restoration when a cell scrolls out and back into view, and an empty
> grid. The `toView` render contract must expose attribute arrays for the grid, row groups, rows,
> column headers, row headers, cells, and the active/selected/editing states needed for custom
> markup and styling.
>
> Add documentation and scene tests for keyboard navigation, range selection, virtualization,
> disabled/read-only cells, edit request/cancel/commit messaging, column resize, and screen-reader
> attributes. Include an example with 100,000 rows showing that application data remains outside
> the component model and messages stay serializable.

## 2. DateTimePicker

> Add a headless, accessible `DateTimePicker` to `@foldkit/ui` by composing the existing
> `DatePicker`, `Popover`, and controlled input helpers. Do not fork Calendar or duplicate Popover
> focus management. Follow the existing submodel pattern with Schema-backed Model, Message, and
> OutMessage types.
>
> The parent owns the selected instant. Support a date plus hour/minute/optional-second editor,
> 12- and 24-hour presentation, locale formatting, min/max instants, disabled instants, clear, and
> explicit timezone interpretation (`local`, `UTC`, or an IANA zone supplied by the host). Emit an
> unambiguous instant and timezone in the selection out-message. Handle DST gaps and repeated local
> times explicitly: invalid wall times must be rejected and ambiguous wall times must require a
> documented deterministic choice or host resolution.
>
> Keyboard behavior must include the current DatePicker grid behavior, focus movement among time
> fields, increment/decrement with arrow keys, Escape to close, and a predictable commit action.
> The `toView` contract should expose trigger, dialog/panel, calendar, time fields, timezone label,
> clear, cancel, and apply attributes without shipping markup or styles.
>
> Add docs and tests for controlled reflection, UTC/local conversion, min/max boundaries, DST gap
> and overlap cases, keyboard-only use, focus return, clearing, seconds on/off, and serialization of
> every model/message. Include a two-picker example suitable for independent “recorded at” and
> “valid at” values.

## 3. Resizable SplitPane

> Implement a headless `SplitPane` component for `@foldkit/ui` for dense workbench layouts. Follow
> the package's Elm Architecture conventions: Schema-backed state/messages, explicit Commands for
> DOM measurement, and a `toView` API that supplies behavior and attributes while the caller owns
> markup and styles.
>
> Support horizontal and vertical orientation, two or more panes, pixel and proportional initial
> sizes, per-pane minimum/maximum/collapsible constraints, pointer dragging, keyboard resizing on
> the separator, double-click reset, and controlled reflection when the host restores a saved
> layout. Emit resize and resize-complete out-messages so persistence remains host-owned. Avoid
> storing DOM nodes or non-serializable values in the model.
>
> Use the ARIA separator pattern with orientation, value min/max/now, focus visibility, and arrow,
> Home, and End behavior. Pointer capture must clean up on cancellation and unmount. Prevent text
> selection while dragging without leaking global listeners. Define deterministic behavior when
> the container shrinks below the sum of pane minima.
>
> Add scene/unit tests for keyboard resizing, pointer dragging, nested panes, collapse/restore,
> reflected external sizes, constrained containers, unmount during drag, and serializable model
> round-trips. Document a three-pane example with navigation, a virtualized grid, and an inspector.

## Triplex integration order

1. Adopt `DateTimePicker` in the global recorded-time/valid-time control.
2. Replace the reflected entity table with `DataGrid`, keeping facts and transactions host-owned.
3. Use `SplitPane` for entity-type navigation, the grid, and the provenance inspector.

Until these land upstream, Triplex should keep narrow local markup around native date-time inputs
and CSS grid layouts, without growing parallel reusable component implementations.
