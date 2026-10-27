# Horror Game

A minimal 3‑D horror‑style demo built with plain WebGL.  
The game shows a dark scene with a rotating cube, flickering lights, a health bar, and a simple monster that reduces health on collision, illustrating basic horror‑game mechanics without external libraries.

---

## Quick Start

1. **Open the game**  
   ```bash
   # Just open the file in a browser
   open index.html
   ```
   (On Windows use `start index.html` or double‑click the file.)

2. **Play**  
   - The cube rotates slowly.  
   - A monster moves toward the cube.  
   - When the monster collides, the health bar shrinks.  
   - Flickering lights add a spooky atmosphere.

3. **Quit**  
   Close the browser tab.

---

## Project Structure

```
horror-game/
├─ index.html          # Entry point – loads CSS & JS
├─ style.css           # Full‑screen canvas + UI overlay
├─ utils.js            # Shared helper functions
├─ game.js             # Core game logic (Game class)
├─ main.js             # WebGL init, shader loading, render loop
├─ horror.test.cjs     # Node tests for Game & utils
└─ README.md           # This file
```

---

## Development

### Adding a New Shader

1. Create a new `.glsl` file in the project root.  
2. Load it in `main.js` using `fetch()` or a `<script type="x-shader/x-vertex">` tag.  
3. Pass the source to `utils.createShader()` and link it with `utils.createProgram()`.

### Extending the Monster

- Edit `game.js`:
  - Add a new `Monster` class or extend the existing one.
  - Update the `Game.update()` loop to spawn or move the new monster.
  - Adjust collision logic if needed.

### UI Tweaks

- Modify `.health-bar` or `.overlay` styles in `style.css`.  
- Add new UI elements inside the `<div class="overlay">` in `index.html`.

---

## Testing

The project ships with a small Node test suite that validates the core logic and utility functions.

```bash
# Run the tests
node horror.test.cjs
```

**Requirements**

- Node.js v18+ (uses the built‑in `node:test` module).  
- No external dependencies.

The test file uses `assert` and `node:test` to verify:

- `utils.createShader` and `utils.createProgram` return valid objects.  
- `utils.randomRange` and `utils.clamp` behave correctly.  
- `Game.takeDamage`, `Game.isGameOver`, and the update loop work as expected.

---

## Browser Compatibility

- Works on modern browsers (Chrome, Firefox, Edge, Safari).  
- No WebGL extensions are required; the demo uses only core WebGL 1.0.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Canvas not visible | Ensure `index.html` is opened via a web server or double‑click; some browsers block local file access. |
| No flickering lights | Check the console for shader compilation errors. |
| Health bar not updating | Verify that `Game.takeDamage()` is called on collision. |

---

## License

This project is released under the MIT License. Feel free to modify and extend it for your own horror experiments.
