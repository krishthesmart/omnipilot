/**
 * Pure game logic for Haunted Mansion.
 *
 * The module defines the data structures for the game map, rooms, items,
 * and the overall game state. It also provides functions to manipulate the
 * state: moving the player, picking up items, advancing the ghost AI, and
 * checking win/lose conditions.
 *
 * All functions are pure – they never touch the DOM or external resources.
 * They return a new `GameState` object (or a result object) without mutating
 * the arguments.
 *
 * @module logic
 */

/**
 * @typedef {Object} Item
 * @property {string} id          Unique identifier.
 * @property {string} name        Human‑readable name.
 * @property {string} description Short description shown to the player.
 */

/**
 * @typedef {Object} Room
 * @property {string} id          Unique identifier.
 * @property {string} description Text describing the room.
 * @property {Object.<string,string>} exits  Mapping from direction
 *                                            ('north','south',…) to the id of the adjacent room.
 * @property {Item[]} items      Items currently lying in the room.
 * @property {boolean} isExit    Whether this room is the winning exit.
 */

/**
 * @typedef {Object} GameState
 * @property {Map<string,Room>} map   All rooms indexed by id.
 * @property {string} playerRoomId   Current room of the player.
 * @property {string} ghostRoomId    Current room of the ghost.
 * @property {string[]} inventory    List of collected item ids.
 * @property {number} turn           Number of turns elapsed (optional, for UI).
 */

/**
 * Helper: deep‑clone a room (shallow copy of items array).
 * @param {Room} room
 * @returns {Room}
 */
function cloneRoom(room) {
  return {
    id: room.id,
    description: room.description,
    exits: { ...room.exits },
    items: room.items.map(item => ({ ...item })), // clone items
    isExit: !!room.isExit,
  };
}

/**
 * Helper: clone the whole map, optionally replacing a single room.
 * @param {Map<string,Room>} map
 * @param {Room} [updatedRoom]
 * @returns {Map<string,Room>}
 */
function cloneMap(map, updatedRoom) {
  const newMap = new Map();
  for (const [id, room] of map.entries()) {
    newMap.set(id, id === (updatedRoom && updatedRoom.id) ? updatedRoom : cloneRoom(room));
  }
  return newMap;
}

/**
 * Creates the static game map.
 *
 * The layout is deliberately simple for the demo:
 *
 *   foyer  --north--> library --east--> study
 *      |                     |
 *   west|                 south|
 *      v                     v
 *   kitchen  <--east--  hallway
 *
 * The `study` is the exit. The player must collect the `key` from the
 * `library` to win.
 *
 * @returns {Map<string,Room>}
 */
function createGameMap() {
  /** @type {Room[]} */
  const rooms = [
    {
      id: 'foyer',
      description: 'A dimly lit foyer. Dust hangs in the air.',
      exits: { north: 'library', west: 'kitchen' },
      items: [],
      isExit: false,
    },
    {
      id: 'library',
      description: 'Shelves of ancient books. Something glints on a table.',
      exits: { south: 'foyer', east: 'study' },
      items: [
        { id: 'key', name: 'Rusty Key', description: 'An old key that looks like it might open a door.' },
      ],
      isExit: false,
    },
    {
      id: 'study',
      description: 'A quiet study with a heavy oak door leading outside.',
      exits: { west: 'library' },
      items: [],
      isExit: true,
    },
    {
      id: 'kitchen',
      description: 'A cold kitchen. The smell of rot is overwhelming.',
      exits: { east: 'foyer', north: 'hallway' },
      items: [],
      isExit: false,
    },
    {
      id: 'hallway',
      description: 'A narrow hallway connecting the kitchen to the rest of the house.',
      exits: { south: 'kitchen', east: 'foyer' },
      items: [],
      isExit: false,
    },
  ];

  const map = new Map();
  for (const room of rooms) {
    map.set(room.id, cloneRoom(room));
  }
  return map;
}

/**
 * Moves the player in the given direction if possible.
 *
 * @param {GameState} state
 * @param {string} direction One of 'north','south','east','west'.
 * @returns {GameState} New state (unchanged if move is illegal).
 */
function movePlayer(state, direction) {
  const currentRoom = state.map.get(state.playerRoomId);
  if (!currentRoom) return state; // safety

  const targetRoomId = currentRoom.exits[direction];
  if (!targetRoomId) {
    // Illegal move – return unchanged state.
    return state;
  }

  // Return a new state with updated player position and incremented turn.
  return {
    ...state,
    playerRoomId: targetRoomId,
    turn: (state.turn ?? 0) + 1,
  };
}

/**
 * Picks up an item from the current room.
 *
 * @param {GameState} state
 * @param {string} itemId Identifier of the item to pick up.
 * @returns {GameState} New state (unchanged if item not present).
 */
function pickItem(state, itemId) {
  const currentRoom = state.map.get(state.playerRoomId);
  if (!currentRoom) return state;

  const itemIndex = currentRoom.items.findIndex(it => it.id === itemId);
  if (itemIndex === -1) {
    // Item not in this room.
    return state;
  }

  const item = currentRoom.items[itemIndex];

  // Remove the item from the room.
  const newItems = currentRoom.items.slice();
  newItems.splice(itemIndex, 1);
  const updatedRoom = { ...currentRoom, items: newItems };

  // Clone map with the updated room.
  const newMap = cloneMap(state.map, updatedRoom);

  // Add item to inventory.
  const newInventory = [...state.inventory, item.id];

  return {
    ...state,
    map: newMap,
    inventory: newInventory,
    turn: (state.turn ?? 0) + 1,
  };
}

/**
 * Finds the shortest path (as an array of room ids) from `startId` to `targetId`
 * using BFS. Returns an empty array if no path exists.
 *
 * @param {string} startId
 * @param {string} targetId
 * @param {Map<string,Room>} map
 * @returns {string[]} Array of room ids, inclusive of start and target.
 */
function bfsPath(startId, targetId, map) {
  if (startId === targetId) return [startId];

  const queue = [{ id: startId, path: [startId] }];
  const visited = new Set([startId]);

  while (queue.length) {
    const { id, path } = queue.shift();
    const room = map.get(id);
    if (!room) continue;

    for (const neighborId of Object.values(room.exits)) {
      if (visited.has(neighborId)) continue;
      if (neighborId === targetId) {
        return [...path, neighborId];
      }
      visited.add(neighborId);
      queue.push({ id: neighborId, path: [...path, neighborId] });
    }
  }
  return []; // no path
}

/**
 * Advances the ghost one step towards the player using the shortest path.
 *
 * @param {GameState} state
 * @returns {GameState} New state with updated ghost position.
 */
function advanceGhost(state) {
  const path = bfsPath(state.ghostRoomId, state.playerRoomId, state.map);
  // Path includes ghostRoomId as first element; the next step is path[1].
  if (path.length < 2) {
    // Ghost is already in the same room or no path – stay put.
    return state;
  }
  const nextRoomId = path[1];
  return {
    ...state,
    ghostRoomId: nextRoomId,
    turn: (state.turn ?? 0) + 1,
  };
}

/**
 * Checks whether the game is over.
 *
 * @param {GameState} state
 * @returns {{over: boolean, win: boolean, message: string}}
 */
function checkGameOver(state) {
  // Lose condition: ghost catches player.
  if (state.ghostRoomId === state.playerRoomId) {
    return {
      over: true,
      win: false,
      message: 'The ghost has caught you. Your scream echoes through the mansion.',
    };
  }

  // Win condition: player is in an exit room *and* possesses the key.
  const playerRoom = state.map.get(state.playerRoomId);
  if (playerRoom && playerRoom.isExit) {
    const hasKey = state.inventory.includes('key');
    if (hasKey) {
      return {
        over: true,
        win: true,
        message: 'You unlock the door with the rusty key and escape the haunted mansion!',
      };
    }
    return {
      over: true,
      win: false,
      message: 'The exit is locked. You need a key to leave.',
    };
  }

  // Game continues.
  return { over: false, win: false, message: '' };
}

module.exports = {
  createGameMap,
  movePlayer,
  pickItem,
  advanceGhost,
  checkGameOver,
  // Exported for testing convenience.
  bfsPath,
};
