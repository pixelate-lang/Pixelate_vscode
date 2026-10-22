# Pixelate for Visual Studio Code

Language support for Pixelate `.pxl` programs, including syntax highlighting,
inline diagnostics, hover documentation, and a command to run the current file.

## Current language features

The extension recognizes:

- `label`, `par`, `button`, `textbox`, `textarea`, `rect`, `circle`, and `triangle` elements.
- Rectangle and triangle `angle` in clockwise degrees.
- Circle centers with `x`/`y` and `radius` (default `10`).
- Triangle points using `p1: (x, y)`, `p2: (x, y)`, and `p3: (x, y)`. Omit all three for the default upward equilateral triangle; with points present, paired `x`/`y` values place the triangle by its centroid.
- `onkey("a")` for case-sensitive key triggers and `onkeyci("a")` for case-insensitive triggers.
- Named keys: `space`, `esc`, `enter`, `shift`, `alt`, `up`, `down`, `left`, `right`, and `tab`.
- `!`, `&&`, `||`, comparisons, and parentheses in `if`, `while`, and condition triggers.
- Increment/decrement expressions such as `count++`, `circle.radius++`, `marker.x++`, and `marker.angle--`.
- Named object declarations with explicit window composition through `add` and `remove`.
- Explicit window startup with `windowName.run()` and redraws with `windowName.update()`.

Example:

```pxl
window main = window {
    title: "Shape demo",
}

triangle marker = triangle {
    p1: (200, 80),
    p2: (260, 180),
    p3: (140, 180),
    angle: 15,
}

trigger rotate = trigger(onkey("right")) {
    marker.x++;
    main.update();
}

main.add(marker);
main.add(rotate);
main.run();
```

Open a `.pxl` file and use the play button in the editor title bar or the
command palette command `Pixelate: Run Current File`.

The executable defaults to `pixelate.exe` on `PATH`. Configure a full path or
command in `pixelate.executablePath` when needed.

## Reinstalling

```text
npx @vscode/vsce package --no-dependencies
code --uninstall-extension local.pixelate
code --install-extension pixelate-VERSION.vsix --force
```
