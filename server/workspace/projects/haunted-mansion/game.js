```file game.js
/**
 * UI glue code for Haunted Mansion.
 *
 * This module is loaded in the browser (via <script src="logic.js"> and
 * <script src="game.js">). It reads the pure game logic from the global
 * `logic` object (set by logic.js's module.exports in the browser context)
 * and wires up the DOM: rendering the map, inventory, and status messages,
 * and handling keyboard input.
 *
 * @module game
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Guard: only run in a browser environment.
  // ---------------------------------------------------------------------------
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  // ---------------------------------------------------------------------------
  // Reference the pure logic module.
  // In the browser, logic.js sets `window.logic` via module.exports.
  // ---------------------------------------------------------------------------
  const logic = window.logic;
  if (!logic) {
    console.error('game.js: logic module not found. Ensure logic.js is loaded before game.js.');
    return;
  }

  // ---------------------------------------------------------------------------
  // DOM element references.
  // ---------------------------------------------------------------------------
  const gameArea = document.getElementById('game-area');
  const inventoryEl = document.getElementById('inventory');
  const statusEl = document.getElementById('status');

  if (!gameArea || !inventoryEl || !statusEl) {
    console.error('game.js: required DOM elements (#game-area, #inventory, #status) not found.');
    return;
  }

  // ---------------------------------------------------------------------------
  // Game state.
  // ---------------------------------------------------------------------------
  let state = null;
  let gameOver = false;

  // ---------------------------------------------------------------------------
  // Initialisation.
  // ---------------------------------------------------------------------------
  function init() {
    const map = logic.createGameMap();
    state = {
      map: map,
      playerRoomId: 'foyer',
      ghostRoomId: 'study',
      inventory: [],
      turn: 0,
    };
    gameOver = false;
    render();
    setStatus('You wake up in the foyer of the haunted mansion. Find the key and escape!');
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers.
  // ---------------------------------------------------------------------------

  /**
   * Renders the current game state into the DOM.
   */
  function render() {
    if (!state) return;

    renderMap();
    renderInventory();
  }

  /**
   * Renders the map into #game-area.
   * Each room is a div with class .room. The player's room gets .player,
   * the ghost's room gets .ghost. Items in the player's room are shown.
   */
  function renderMap() {
    gameArea.innerHTML = '';

    const rooms = Array.from(state.map.values());

    for (const room of rooms) {
      const roomEl = document.createElement('div');
      roomEl.className = 'room';
      roomEl.dataset.roomId = room.id;

      // Room name / description.
      const nameEl = document.createElement('div');
      nameEl.className = 'room-name';
      nameEl.textContent = room.id.charAt(0).toUpperCase() + room.id.slice(1);
      roomEl.appendChild(nameEl);

      const descEl = document.createElement('div');
      descEl.className = 'room-desc';
      descEl.textContent = room.description;
      roomEl.appendChild(descEl);

      // Exits.
      const exitsEl = document.createElement('div');
      exitsEl.className = 'room-exits';
      const exitDirs = Object.keys(room.exits);
      if (exitDirs.length > 0) {
        exitsEl.textContent = 'Exits: ' + exitDirs.join(', ');
      } else {
        exitsEl.textContent = 'No exits.';
      }
      roomEl.appendChild(exitsEl);

      // Items in this room (only show if player is here, to avoid spoilers).
      if (room.id === state.playerRoomId && room.items.length > 0) {
        const itemsEl = document.createElement('div');
        itemsEl.className = 'room-items';
        for (const item of room.items) {
          const itemEl = document.createElement('span');
          itemEl.className = 'item';
          itemEl.textContent = item.name;
          itemEl.title = item.description;
          itemsEl.appendChild(itemEl);
        }
        roomEl.appendChild(itemsEl);
      }

      // Mark player and ghost positions.
      if (room.id === state.playerRoomId) {
        roomEl.classList.add('player');
      }
      if (room.id === state.ghostRoomId) {
        roomEl.classList.add('ghost');
      }

      gameArea.appendChild(roomEl);
    }
  }

  /**
   * Renders the inventory into #inventory.
   */
  function renderInventory() {
    inventoryEl.innerHTML = '';

    if (state.inventory.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'inventory-empty';
      emptyEl.textContent = 'Empty';
      inventoryEl.appendChild(emptyEl);
      return;
    }

    for (const itemId of state.inventory) {
      // Look up the item name from the map (items may have been removed from rooms).
      const item = findItemById(itemId);
      const itemEl = document.createElement('div');
      itemEl.className = 'item';
      itemEl.textContent = item ? item.name : itemId;
      if (item) {
        itemEl.title = item.description;
      }
      inventoryEl.appendChild(itemEl);
    }
  }

  /**
   * Finds an item by id across all rooms and the inventory.
   * @param {string} itemId
   * @returns {Item|null}
   */
  function findItemById(itemId) {
    for (const room of state.map.values()) {
      for (const item of room.items) {
        if (item.id === itemId) return item;
      }
    }
    // Item may have been picked up; we don't store it separately, so return null.
    // The inventory render falls back to showing the id.
    return null;
  }

  /**
   * Sets the status message.
   * @param {string} message
   */
  function setStatus(message) {
    statusEl.textContent = message;
  }

  // ---------------------------------------------------------------------------
  // Game actions.
  // ---------------------------------------------------------------------------

  /**
   * Attempts to move the player in the given direction.
   * @param {string} direction
   */
  function handleMove(direction) {
    if (gameOver) return;

    const oldRoomId = state.playerRoomId;
    state = logic.movePlayer(state, direction);

    if (state.playerRoomId === oldRoomId) {
      // Move was illegal (no exit in that direction).
      setStatus('You cannot go that way.');
      return;
    }

    // Advance the ghost after the player moves.
    state = logic.advanceGhost(state);

    // Check game over.
    const result = logic.checkGameOver(state);
    if (result.over) {
      gameOver = true;
      setStatus(result.message);
      render();
      return;
    }

    // Show a brief message about the new room.
    const newRoom = state.map.get(state.playerRoomId);
    if (newRoom) {
      setStatus(newRoom.description);
    }

    render();
  }

  /**
   * Attempts to pick up an item from the current room.
   * @param {string} itemId
   */
  function handlePickItem(itemId) {
    if (gameOver) return;

    const oldInventory = state.inventory.length;
    state = logic.pickItem(state, itemId);

    if (state.inventory.length === oldInventory) {
      // Item not found in current room.
      setStatus('You cannot pick that up here.');
      return;
    }

    // Advance the ghost after picking up an item.
    state = logic.advanceGhost(state);

    // Check game over.
    const result = logic.checkGameOver(state);
    if (result.over) {
      gameOver = true;
      setStatus(result.message);
      render();
      return;
    }

    const item = findItemById(itemId);
    setStatus('You picked up: ' + (item ? item.name : itemId));

    render();
  }

  // ---------------------------------------------------------------------------
  // Input handling.
  // ---------------------------------------------------------------------------

  /**
   * Maps key codes to game actions.
   * @param {KeyboardEvent} event
   */
  function handleKeydown(event) {
    if (gameOver) return;

    const key = event.key.toLowerCase();

    // Movement keys.
    if (key === 'w' || key === 'arrowup') {
      event.preventDefault();
      handleMove('north');
    } else if (key === 's' || key === 'arrowdown') {
      event.preventDefault();
      handleMove('south');
    } else if (key === 'a' || key === 'arrowleft') {
      event.preventDefault();
      handleMove('west');
    } else if (key === 'd' || key === 'arrowright') {
      event.preventDefault();
      handleMove('east');
    }
    // Item pickup: press 'e' to pick up the first item in the current room.
    else if (key === 'e') {
      event.preventDefault();
      const currentRoom = state.map.get(state.playerRoomId);
      if (currentRoom && currentRoom.items.length > 0) {
        handlePickItem(currentRoom.items[0].id);
      } else {
        setStatus('There is nothing to pick up here.');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Start the game.
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', handleKeydown);
  init();

})();
~~~~
