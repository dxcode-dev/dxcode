---
name: drawing-boards
description: "Draws and edits dx drawing boards (artifacts of type board) through the artifact tool's line-per-shape board text: flowcharts, architecture and system diagrams, sequence-like flows, mind maps, and sketches people keep editing. Use when asked to draw, diagram, sketch, or whiteboard something on a board, to put a diagram in an artifact, or to change an existing board. For a chart or an interactive view in a reply, use creating-views instead."
---

# Drawing boards

A board is an artifact people draw on, with you, in an Excalidraw canvas. You write it through the `artifact` tool as board text, one element per line, and you never see it drawn. So plan the layout in numbers before you write, and let the tool's `layout_notes` tell you what reads badly.

## Board text

```
board background=#ffffff
text title "Checkout" x=0 y=0 size=28
rect cart "Cart" x=0 y=80 w=200 h=80
diamond paid "Paid?" x=0 y=260 w=200 h=120 fill=yellow
ellipse done "Order placed" x=0 y=480 w=200 h=80 fill=green
rect retry "Show payment error" x=320 y=280 w=200 h=80 fill=red
arrow a1 cart -> paid "pay"
arrow a2 paid -> done "yes"
arrow a3 paid -> retry "no"
arrow a4 retry -> cart "try again"
```

- A line is `<kind> <id> "label" key=value …`. The id always follows the kind. Every setting is `key=value`; a bare number is an error.
- Kinds: `rect`, `ellipse`, `diamond` (shapes, with an optional label), `text` (a free note, words required), `arrow`, `line`, `frame` (a labelled area that holds shapes). `freehand` and `image` lines are people's drawings; you can only move or resize them.
- `x`, `y` are the top-left corner in pixels, and y grows downward. `w`, `h` apply to shapes and frames. A `text` takes no `w` or `h`; it sizes to its words.
- `arrow <id> <from> -> <to> "label"` connects two shapes by id, and dx draws a straight arrow between their outlines and keeps it attached when either moves. Arrows have no x or y to set.
- Colors: `fill=` and `stroke=` take `#rrggbb` or a name: black, white, gray, red, pink, purple, blue, cyan, teal, green, yellow, orange. A named fill is the light shade and a named stroke the strong one, so `fill=red` reads as an error box with dark text.
- Other keys: `size` (font size, 20 by default), `font` (hand, normal, code), `rough=0` for clean lines, `dash` (dashed, dotted), `align` (text), `head`/`tail` (arrowheads), `frame=<frame id>`, `link`.
- `\n` in a label starts a new line. A label also wraps to its shape's width, and the shape grows taller when the wrapped label needs the room.

## Lay it out before writing

1. List the nodes and the arrows. Pick a direction: top to bottom for a flow or process, left to right for layers or a pipeline.
2. Put the nodes on a grid of rows and columns. The main path goes straight down one column (or along one row). Side branches, such as errors, retries, or "no" answers, go in the next column beside the step they leave from.
3. Turn the grid into numbers. Make every box in a column the same width so the arrows run straight:
   - Box size: at the default font size a character is about 11 px wide and a line 25 px tall. Make a rect at least 11 × (longest line) + 40 wide and 25 × (lines) + 30 tall. A diamond needs about twice the width and height of its label, so keep diamond labels to two to four words. 180 × 80 suits a short step label and 200 × 120 a short question.
   - Gaps: leave at least 80 px between boxes joined by an unlabelled arrow, and 120 px or more when the arrow has a label, so the label sits on a visible stretch of line.
   - Column x = column × (box width + gap); row y = row × (box height + gap).
4. Keep an arrow from passing through other shapes: a straight line between two boxes crosses whatever sits between them. Route a long jump around the column (put the target beside the path, not two rows below), or add the arrow to the next step instead. Two arrows between the same two shapes draw on top of each other, so draw a loop back (such as "wrong code, try again") from a side step, like an error box beside the path, to the earlier step.
5. Keep labels short: two to six words in a box, one to three on an arrow. Put an explanation in a `text` note beside the diagram or in your reply, not inside a box.

Frames group related shapes, such as one per system boundary or layer. Give a frame 30 px of padding around its shapes and 50 px at the top for its name, give each shape inside `frame=<frame id>`, and leave 80 px or more between frames. A frame hides whatever sticks out of it.

A title goes in a `text` line above everything at `size=28`. Add a legend `text` when colors carry meaning.

When you would rather not place shapes, leave out `x` and `y` on every new shape: dx stacks them in rows below what is already there, one row per step along the arrows. That suits a short chain. For branches, frames, or a layout people will read, set positions yourself.

## Write it once, then fix the notes

- Create the whole board in one `artifact` create call with `type: "board"`. Don't make a scratch board to test the syntax; the format above is complete, and an error names the line and what to write instead. Nothing saves when a line is wrong, so fix that line and send the call again.
- The result can include `layout_notes`: shapes on top of each other, an arrow through a shape, an arrow label on a shape or longer than its arrow, a shape outside its frame. The board is saved, but people will see these problems. Fix each one with an update that moves the shapes it names, then check the next result. When no notes come back, the layout is clean.
- In your reply, link the board and say in a sentence or two what it shows.

## Edit an existing board

1. `read` the board first. It returns every line, the revision, comments, and what people changed since your last save.
2. Change only the lines you mean to. With `edits`, each `old_str` is one or more whole lines copied exactly from the read, and `new_str` is their replacement. A label's line break reads as `\n`, one backslash, so keep it that way in `old_str`. A line you leave out of a full `markdown` rewrite deletes its element, so prefer `edits` on a board people have drawn on.
3. Keep every existing id. Don't rename a shape; renaming deletes it and creates a new one, and the arrows and comments on it are lost.
4. To insert a step between `a` and `b`: add the new shape, change `arrow x a -> b` to `arrow x a -> new`, and add `arrow y new -> b`. Make room first: move the shapes below it down by the new row's height plus the gap, by editing their `y`.
5. To recolor, add or change `fill=` and `stroke=` on the shape's line. To delete, remove its line and the lines of the arrows that use it.
6. Send `base_revision` from your read. When someone saved in between, nothing is saved and the result has the current text: apply your change to it and update again.

## Examples

A flowchart with a decision and a loop back. The main path is one column at x=0 and the branch is a second column at x=320:

```
text title "Sign in" x=0 y=0 size=28
ellipse start "Open login page" x=0 y=70 w=220 h=80
rect form "Enter email\nand password" x=0 y=230 w=220 h=80
diamond ok "Credentials\nvalid?" x=0 y=410 w=220 h=130
ellipse dash "Dashboard" x=0 y=640 w=220 h=80 fill=green
rect error "Show error" x=340 y=440 w=220 h=80 fill=red
arrow a1 start -> form
arrow a2 form -> ok "submit"
arrow a3 ok -> dash "yes"
arrow a4 ok -> error "no"
arrow a5 error -> form "try again"
```

An architecture diagram in left-to-right frames, one per boundary:

```
text title "System overview" x=0 y=0 size=28
frame client "Browser" x=0 y=60 w=280 h=200
rect web "Web app" x=30 y=120 w=220 h=100 fill=blue frame=client
frame cloud "Cloud" x=360 y=60 w=560 h=360
rect api "API server" x=390 y=120 w=220 h=100 fill=yellow frame=cloud
rect db "Database" x=390 y=290 w=220 h=100 fill=green frame=cloud
rect files "File storage" x=670 y=290 w=220 h=100 fill=green frame=cloud
arrow a1 web -> api "HTTPS"
arrow a2 api -> db "SQL"
arrow a3 api -> files "blobs"
```
