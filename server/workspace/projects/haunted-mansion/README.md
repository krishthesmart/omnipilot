# Haunted Mansion

**Haunted Mansion** is a tiny browser‑based horror adventure.  
You explore a spooky mansion, collect clues, and try to escape while a restless ghost roams the halls. The game runs entirely in the browser – just open `index.html`. All core mechanics (room layout, inventory, ghost AI, win/lose detection) are pure JavaScript and are unit‑tested with Node’s built‑in test runner.

---

## Table of Contents

- [Features](#features)  
- [Getting Started](#getting-started)  
  - [Running the Game](#running-the-game)  
  - [Running the Tests](#running-the-tests)  
- [Project Structure](#project-structure)  
- [Game Rules](#game-rules)  
- [Contributing](#contributing)  
- [License](#license)  

---

## Features

- **Exploration** – Move between rooms with the arrow keys.  
- **Inventory** – Pick up items (keys, notes, relics) to solve puzzles.  
- **Ghost AI** – A roaming ghost moves after each player turn; getting caught ends the game.  
- **Win/Lose Conditions** – Escape the mansion with the required items or be caught by the ghost.  
- **Pure Logic Layer** – All game mechanics live in `logic.js` and are fully unit‑tested.  
- **Zero Dependencies** – No external libraries, no network calls, no subprocesses.

---

## Getting Started

### Running the Game

1. **Clone or download** the repository to a local folder.  
2. Open `index.html` in a web browser (double‑click the file or run `open index.html` on macOS, `xdg-open index.html` on Linux, etc.).  
3. The game UI appears. Use the **arrow keys** to move, **Enter** to pick up an item, and watch the status bar for messages.

> **Tip:** The game works offline; no server is required.

### Running the Tests

The test suite validates the pure logic in `logic.js`.

```bash
# From the project root
node haunted-mansion.test.cjs
```

The test file uses Node’s built‑in `test` module, so no additional test runner is needed. All tests should pass:

```
✓ movePlayer – basic movement
✓ movePlayer – blocked by walls
✓ pickItem – adds to inventory
✓ advanceGhost – chases player
✓ checkGameOver – win condition
✓ checkGameOver – lose condition
...
```

If a test fails, the console output will show the assertion that failed.

---

## Project Structure

```
haunted-mansion/
│
├─ index.html          # Main UI page – contains #game-area, #inventory, #status
├─ style.css           # Dark‑theme styling and simple animations
├─ logic.js            # Pure game logic (rooms, inventory, ghost AI, win/lose)
├─ game.js             # UI glue – renders map, handles input, updates DOM
├─ haunted-mansion.test.cjs  # Node test suite for logic.js
└─ README.md           # ← you are reading it
```

### File Summaries

| File | Purpose |
|------|---------|
| **index.html** | Sets up the HTML skeleton and loads CSS/JS. |
| **style.css** | Provides visual styling: dark background, room borders, player/ghost icons, hidden items, etc. |
| **logic.js** | Exports pure functions and type definitions: <br>`createGameMap()`, `movePlayer(state, direction)`, `pickItem(state, itemId)`, `advanceGhost(state)`, `checkGameOver(state)`. |
| **game.js** | Binds keyboard events, renders the map into `#game-area`, updates `#inventory` and `#status`, and calls the functions from `logic.js`. |
| **haunted-mansion.test.cjs** | Unit tests for every exported function in `logic.js`. Uses only Node core modules (`node:test`, `node:assert`). |
| **README.md** | This documentation. |

---

## Game Rules

1. **Movement** – Use the arrow keys (`↑ ↓ ← →`). The player cannot move through walls.  
2. **Items** – When standing on a tile that contains an item, press **Enter** to pick it up. The item disappears from the map and appears in the inventory panel.  
3. **Ghost** – After each player move, the ghost moves one step toward the player using a simple Manhattan‑distance algorithm.  
4. **Win** – Reach the **Exit** room while possessing the **Master Key**.  
5. **Lose** – The ghost moves onto the same tile as the player. The status bar shows a “You have been caught!” message.  

---

## Contributing

Contributions are welcome! To add a new feature or fix a bug:

1. Fork the repository.  
2. Create a feature branch (`git checkout -b feature/awesome‑feature`).  
3. Make your changes.  
4. Add or update tests in `haunted-mansion.test.cjs`.  
5. Run the test suite (`node haunted-mansion.test.cjs`). All tests must pass.  
6. Submit a pull request.

Please keep the pure‑logic layer (`logic.js`) free of DOM manipulation – UI changes belong in `game.js`.

---

## License

This project is released under the **MIT License**. See the `LICENSE` file for details.

--- 

Enjoy surviving the **Haunted Mansion**! 🎃👻
