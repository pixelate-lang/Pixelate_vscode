# `.pxldoc` format

Pixelate's built-in documentation is stored as Markdown records with a small
metadata header. A file may contain one or more records. Each record starts
with `---` and must define `id` and `name`:

```text
---
id: label
name: Label
kind: element
---
Creates a non-clickable text widget.
```

The `id` is the identifier recognized by editor tooling. `name` is the title
shown in hover documentation. `kind` is optional metadata for future tooling.
The body is Markdown and may contain fenced `pxl` examples.

The CMake build embeds `builtins.pxldoc` into the `pixelate` executable. The
embedded registry can be inspected with:

```text
pixelate --docs
```
