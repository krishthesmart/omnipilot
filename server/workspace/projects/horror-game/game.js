/**
 * Core game logic for the horror demo.
 * Manages player state, monster behaviour, collision, and the update loop.
 * Works both in browser (global) and Node (CommonJS).
 */
(function (global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    global.Game = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  // ---- Tunable constants -------------------------------------------------
  const MAX_HEALTH = 100;
  const DAMAGE_PER_HIT = 15;
  const HIT_COOLDOWN = 0.8; // seconds of invulnerability after a hit
  const MONSTER_SPEED = 1.6; // units / second
  const MONSTER_RADIUS = 0.6; // collision radius
  const PLAYER_RADIUS = 0.4; // collision radius
  const CUBE_SIZE = 1.0; // half-extent of the rotating cube
  const CUBE_ROTATION_SPEED = 0.8; // radians / second
  const FLOOR_SIZE = 20; // half-extent of the floor plane
  const BOUND = 8; // how far the player/monster can roam from the origin
  const MIN_DELTA = 0.0001; // guard against non-positive time steps

  // ---- Small vector helpers (kept local to avoid extra dependencies) -----
  function dist2D(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function normalize(x, y) {
    const len = Math.sqrt(x * x + y * y);
    if (len === 0) return { x: 0, y: 0 };
    return { x: x / len, y: y / len };
  }

  /**
   * The Game class.
   * Holds all mutable state for the demo and exposes an update() method that
   * advances the simulation by a given time step.
   */
  class Game {
    /**
     * @param {WebGLRenderingContext} gl - WebGL context (used for sizing /
     *   future rendering hooks). May be null in headless / test environments.
     */
    constructor(gl) {
      this.gl = gl || null;

      // Player state
      this.player = {
        x: 0,
        y: 0,
        z: 0,
        health: MAX_HEALTH,
        maxHealth: MAX_HEALTH,
        invulnTimer: 0,
      };

      // Monster state
      this.monster = {
        x: 6,
        y: 0,
        z: 6,
        speed: MONSTER_SPEED,
        radius: MONSTER_RADIUS,
        // A little wander offset so the monster does not move in a straight line
        wanderAngle: 0,
      };

      // Rotating cube (the "object" in the scene)
      this.cube = {
        rotation: 0,
        size: CUBE_SIZE,
        rotationSpeed: CUBE_ROTATION_SPEED,
      };

      // Flickering light state
      this.light = {
        intensity: 1.0,
        flickerTimer: 0,
        flickerInterval: 0.12, // how often the light changes
        minIntensity: 0.2,
        maxIntensity: 1.0,
      };

      // Bookkeeping
      this.elapsed = 0;
      this.running = false;
      this.gameOver = false;
      this.lastHitTime = -Infinity;

      // Optional callback so the UI layer can react to damage / game over
      this.onDamage = null;
      this.onGameOver = null;
    }

    /**
     * Begin the game (resets state and marks it as running).
     * @returns {Game} this, for chaining.
     */
    start() {
      this.reset();
      this.running = true;
      return this;
    }

    /**
     * Reset all state to its initial values.
     * @returns {Game} this.
     */
    reset() {
      this.player.x = 0;
      this.player.y = 0;
      this.player.z = 0;
      this.player.health = MAX_HEALTH;
      this.player.invulnTimer = 0;

      this.monster.x = 6;
      this.monster.y = 0;
      this.monster.z = 6;
      this.monster.wanderAngle = 0;

      this.cube.rotation = 0;
      this.light.intensity = 1.0;
      this.light.flickerTimer = 0;

      this.elapsed = 0;
      this.gameOver = false;
      this.lastHitTime = -Infinity;
      return this;
    }

    /**
     * Advance the simulation by deltaTime seconds.
     * @param {number} deltaTime - Time step in seconds.
     */
    update(deltaTime) {
      if (this.gameOver) return;
      if (typeof deltaTime !== "number" || !isFinite(deltaTime) || deltaTime <= 0) {
        deltaTime = MIN_DELTA;
      }
      // Cap very large steps (e.g. after a tab was backgrounded) to keep
      // the simulation stable.
      if (deltaTime > 0.25) deltaTime = 0.25;

      this.elapsed += deltaTime;

      this._updateCube(deltaTime);
      this._updateLight(deltaTime);
      this._updateMonster(deltaTime);
      this._updatePlayer(deltaTime);
      this._checkCollision();
    }

    /**
     * Apply damage to the player.
     * @param {number} amount - Health points to subtract.
     */
    takeDamage(amount) {
      if (this.gameOver) return;
      if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return;

      this.player.health -= amount;
      if (this.player.health < 0) this.player.health = 0;

      // Brief invulnerability window so a single overlap does not drain all
      // health in one frame.
      this.player.invulnTimer = HIT_COOLDOWN;
      this.lastHitTime = this.elapsed;

      if (typeof this.onDamage === "function") {
        this.onDamage(this.player.health, this.player.maxHealth);
      }

      if (this.player.health <= 0) {
        this.gameOver = true;
        this.running = false;
        if (typeof this.onGameOver === "function") {
          this.onGameOver();
        }
      }
    }

    /**
     * @returns {boolean} True if the player has lost all health.
     */
    isGameOver() {
      return this.gameOver;
    }

    // ---- Internal update helpers -----------------------------------------

    _updateCube(deltaTime) {
      this.cube.rotation += this.cube.rotationSpeed * deltaTime;
    }

    _updateLight(deltaTime) {
      this.light.flickerTimer += deltaTime;
      if (this.light.flickerTimer >= this.light.flickerInterval) {
        this.light.flickerTimer = 0;
        // Randomly pick a new intensity; occasionally drop to near-zero for
        // a dramatic "flicker out" effect.
        const roll = Math.random();
        if (roll < 0.15) {
          this.light.intensity = this.light.minIntensity;
        } else {
          this.light.intensity =
            this.light.minIntensity +
            Math.random() * (this.light.maxIntensity - this.light.minIntensity);
        }
      }
    }

    _updateMonster(deltaTime) {
      const m = this.monster;
      const p = this.player;

      // Steer the monster toward the player with a small sinusoidal wander
      // so its path is not perfectly straight.
      const dx = p.x - m.x;
      const dz = p.z - m.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > 0.001) {
        const dirX = dx / dist;
        const dirZ = dz / dist;

        // Wander: rotate the direction vector by a small oscillating angle.
        m.wanderAngle += deltaTime * 1.5;
        const wander = Math.sin(m.wanderAngle) * 0.3; // up to ~17 degrees
        const cosW = Math.cos(wander);
        const sinW = Math.sin(wander);
        const wx = dirX * cosW - dirZ * sinW;
        const wz = dirX * sinW + dirZ * cosW;

        m.x += wx * m.speed * deltaTime;
        m.z += wz * m.speed * deltaTime;
      }

      // Keep the monster within the arena bounds.
      m.x = Math.max(-BOUND, Math.min(BOUND, m.x));
      m.z = Math.max(-BOUND, Math.min(BOUND, m.z));
    }

    _updatePlayer(deltaTime) {
      const p = this.player;

      // The player slowly drifts toward the centre (a "being pulled in" feel)
      // to keep the action near the camera.
      const pullStrength = 0.15;
      p.x += -p.x * pullStrength * deltaTime;
      p.z += -p.z * pullStrength * deltaTime;

      // Keep the player within bounds.
      p.x = Math.max(-BOUND, Math.min(BOUND, p.x));
      p.z = Math.max(-BOUND, Math.min(BOUND, p.z));

      // Tick down the invulnerability timer.
      if (p.invulnTimer > 0) {
        p.invulnTimer -= deltaTime;
        if (p.invulnTimer < 0) p.invulnTimer = 0;
      }
    }

    _checkCollision() {
      const p = this.player;
      const m = this.monster;

      // Skip collision while the player is invulnerable.
      if (p.invulnTimer > 0) return;

      const dx = p.x - m.x;
      const dz = p.z - m.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const collisionDist = p.radius + m.radius;

      if (dist <= collisionDist) {
        this.takeDamage(DAMAGE_PER_HIT);
      }
    }
  }

  // Expose constants for tests / UI.
  Game.MAX_HEALTH = MAX_HEALTH;
  Game.DAMAGE_PER_HIT = DAMAGE_PER_HIT;
  Game.HIT_COOLDOWN = HIT_COOLDOWN;

  return Game;
});
