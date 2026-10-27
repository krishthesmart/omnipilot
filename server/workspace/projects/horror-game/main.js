/**
 * Entry point for the horror demo.
 *
 * Responsibilities:
 *   - Acquire a WebGL context on the page's canvas.
 *   - Compile and link the vertex / fragment shaders.
 *   - Build the geometry (a rotating cube and a floor plane).
 *   - Create the Game instance and wire up UI callbacks.
 *   - Drive the requestAnimationFrame render loop.
 *
 * This file is browser-only; it is loaded via a <script> tag after
 * utils.js and game.js.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // GLSL sources
  // ------------------------------------------------------------------

  const VERTEX_SHADER_SOURCE = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;

    uniform mat4 uModel;
    uniform mat4 uView;
    uniform mat4 uProjection;
    uniform mat3 uNormalMatrix;

    varying vec3 vNormal;
    varying vec3 vWorldPos;

    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      vWorldPos = worldPos.xyz;
      vNormal = uNormalMatrix * aNormal;
      gl_Position = uProjection * uView * worldPos;
    }
  `;

  const FRAGMENT_SHADER_SOURCE = `
    precision mediump float;

    varying vec3 vNormal;
    varying vec3 vWorldPos;

    uniform vec3 uLightPos;
    uniform float uLightIntensity;
    uniform vec3 uColor;
    uniform float uFogDensity;
    uniform vec3 uFogColor;
    uniform vec3 uCameraPos;

    void main() {
      // --- Simple directional + point light ---
      vec3 normal = normalize(vNormal);
      vec3 lightDir = normalize(uLightPos - vWorldPos);
      float diff = max(dot(normal, lightDir), 0.0);

      // Ambient so the scene is never fully black
      float ambient = 0.08;

      // Point-light attenuation
      float dist = length(uLightPos - vWorldPos);
      float attenuation = 1.0 / (1.0 + 0.05 * dist + 0.02 * dist * dist);

      vec3 lighting = (ambient + diff * uLightIntensity * attenuation) * uColor;

      // --- Exponential fog for atmosphere ---
      float camDist = length(uCameraPos - vWorldPos);
      float fogFactor = 1.0 - exp(-uFogDensity * camDist);
      fogFactor = clamp(fogFactor, 0.0, 1.0);

      vec3 finalColor = mix(lighting, uFogColor, fogFactor);

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  // ------------------------------------------------------------------
  // Minimal 4x4 matrix helpers (column-major, WebGL convention)
  // ------------------------------------------------------------------

  function mat4Identity() {
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
  }

  function mat4Perspective(fovY, aspect, near, far) {
    const f = 1.0 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ];
  }

  function mat4LookAt(eye, center, up) {
    const ex = eye[0], ey = eye[1], ez = eye[2];
    const cx = center[0], cy = center[1], cz = center[2];
    const ux = up[0], uy = up[1], uz = up[2];

    // z = normalize(eye - center)
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let len = Math.sqrt(zx * zx + zy * zy + zz * zz);
    zx /= len; zy /= len; zz /= len;

    // x = normalize(cross(up, z))
    let xx = uy * zz - uz * zy;
    let xy = uz * zx - ux * zz;
    let xz = ux * zy - uy * zx;
    len = Math.sqrt(xx * xx + xy * xy + xz * xz);
    xx /= len; xy /= len; xz /= len;

    // y = cross(z, x)
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    return [
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * ex + xy * ey + xz * ez),
      -(yx * ex + yy * ey + yz * ez),
      -(zx * ex + zy * ey + zz * ez),
      1,
    ];
  }

  function mat4Multiply(a, b) {
    const out = new Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[i * 4 + j] =
          a[0 * 4 + j] * b[i * 4 + 0] +
          a[1 * 4 + j] * b[i * 4 + 1] +
          a[2 * 4 + j] * b[i * 4 + 2] +
          a[3 * 4 + j] * b[i * 4 + 3];
      }
    }
    return out;
  }

  function mat4Translate(x, y, z) {
    const m = mat4Identity();
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
  }

  function mat4Scale(sx, sy, sz) {
    const m = mat4Identity();
    m[0] = sx;
    m[5] = sy;
    m[10] = sz;
    return m;
  }

  function mat4RotateY(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m = mat4Identity();
    m[0] = c;  m[2] = -s;
    m[8] = s;  m[10] = c;
    return m;
  }

  function mat4RotateX(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m = mat4Identity();
    m[5] = c;  m[6] = s;
    m[9] = -s; m[10] = c;
    return m;
  }

  /**
   * Extract the upper-left 3x3 of a model matrix, normalised per column,
   * suitable for transforming normals.
   */
  function mat3NormalFromMat4(m) {
    // Inverse-transpose of the upper 3x3. For rigid transforms (rotation +
    // uniform scale) this is just the upper 3x3 normalised.
    const out = new Array(9);
    out[0] = m[0]; out[1] = m[1]; out[2] = m[2];
    out[3] = m[4]; out[4] = m[5]; out[5] = m[6];
    out[6] = m[8]; out[7] = m[9]; out[8] = m[10];
    return out;
  }

  // ------------------------------------------------------------------
  // Geometry builders
  // ------------------------------------------------------------------

  /**
   * Build a unit cube (half-extent = 1) with interleaved position + normal.
   * Returns { positions: Float32Array, normals: Float32Array, count: number }.
   */
  function buildCube() {
    const positions = [];
    const normals = [];

    // Each face: 4 vertices, 2 triangles (6 indices). We use non-indexed
    // triangles for simplicity.
    const faces = [
      // +X
      { n: [1, 0, 0], v: [[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]] },
      // -X
      { n: [-1,0, 0], v: [[-1,-1,1],[-1,1,1],[-1,1,-1],[-1,-1,-1]] },
      // +Y
      { n: [0, 1, 0], v: [[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]] },
      // -Y
      { n: [0,-1, 0], v: [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]] },
      // +Z
      { n: [0, 0, 1], v: [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]] },
      // -Z
      { n: [0, 0,-1], v: [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]] },
    ];

    for (const face of faces) {
      const base = positions.length / 3;
      // Two triangles: (0,1,2) and (0,2,3)
      const order = [0, 1, 2, 0, 2, 3];
      for (const idx of order) {
        const v = face.v[idx];
        positions.push(v[0], v[1], v[2]);
        normals.push(face.n[0], face.n[1], face.n[2]);
      }
    }

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      count: positions.length / 3,
    };
  }

  /**
   * Build a flat floor plane at y=0 spanning [-size, size] in x and z.
   */
  function buildFloor(size) {
    const positions = [
      -size, 0, -size,
       size, 0, -size,
       size, 0,  size,
      -size, 0, -size,
      -size, 0,  size,
       size, 0,  size,
    ];
    const normals = [
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
    ];
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      count: 6,
    };
  }

  // ------------------------------------------------------------------
  // Module state
  // ------------------------------------------------------------------

  let gl = null;
  let program = null;
  let game = null;

  // Buffers
  let cubeVBO = null;
  let cubeNBO = null;
  let cubeCount = 0;
  let floorVBO = null;
  let floorNBO = null;
  let floorCount = 0;

  // Uniform locations
  let uModel, uView, uProjection, uNormalMatrix;
  let uLightPos, uLightIntensity, uColor, uFogDensity, uFogColor, uCameraPos;

  // Attribute locations
  let aPosition, aNormal;

  // Camera
  const CAMERA_HEIGHT = 3.5;
  const CAMERA_DISTANCE = 6.0;
  const FOV = Math.PI / 3; // 60 degrees
  const NEAR = 0.1;
  const FAR = 100.0;

  // UI elements
  let healthBarFill = null;
  let healthBarText = null;
  let flashEl = null;
  let gameOverEl = null;

  let lastTimestamp = 0;
  let rafId = 0;

  // ------------------------------------------------------------------
  // Initialisation
  // ------------------------------------------------------------------

  function init() {
    const canvas = document.getElementById("glCanvas");
    if (!canvas) {
      console.error("main.js: <canvas id=\"glCanvas\"> not found.");
      return;
    }

    // --- WebGL context ---
    gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) {
      console.error("main.js: WebGL is not supported in this browser.");
      return;
    }

    // Resize canvas to fill the viewport
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    window.addEventListener("resize", resize);

    // --- Shaders & program ---
    program = utils.createProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);
    gl.useProgram(program);

    // Attribute locations
    aPosition = gl.getAttribLocation(program, "aPosition");
    aNormal = gl.getAttribLocation(program, "aNormal");

    // Uniform locations
    uModel = gl.getUniformLocation(program, "uModel");
    uView = gl.getUniformLocation(program, "uView");
    uProjection = gl.getUniformLocation(program, "uProjection");
    uNormalMatrix = gl.getUniformLocation(program, "uNormalMatrix");
    uLightPos = gl.getUniformLocation(program, "uLightPos");
    uLightIntensity = gl.getUniformLocation(program, "uLightIntensity");
    uColor = gl.getUniformLocation(program, "uColor");
    uFogDensity = gl.getUniformLocation(program, "uFogDensity");
    uFogColor = gl.getUniformLocation(program, "uFogColor");
    uCameraPos = gl.getUniformLocation(program, "uCameraPos");

    // --- Geometry ---
    const cube = buildCube();
    cubeVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeVBO);
    gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW);

    cubeNBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeNBO);
    gl.bufferData(gl.ARRAY_BUFFER, cube.normals, gl.STATIC_DRAW);
    cubeCount = cube.count;

    const floor = buildFloor(20);
    floorVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, floorVBO);
    gl.bufferData(gl.ARRAY_BUFFER, floor.positions, gl.STATIC_DRAW);

    floorNBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, floorNBO);
    gl.bufferData(gl.ARRAY_BUFFER, floor.normals, gl.STATIC_DRAW);
    floorCount = floor.count;

    // --- Game instance ---
    game = new Game(gl);

    // Wire up UI callbacks
    game.onDamage = function (health, maxHealth) {
      updateHealthBar(health, maxHealth);
      triggerFlash();
    };

    game.onGameOver = function () {
      showGameOver();
    };

    // --- UI elements ---
    healthBarFill = document.getElementById("healthBarFill");
    healthBarText = document.getElementById("healthBarText");
    flashEl = document.getElementById("flash");
    gameOverEl = document.getElementById("gameOver");

    // --- GL state ---
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0.02, 0.02, 0.04, 1.0); // very dark blue-black

    // --- Start ---
    game.start();
    lastTimestamp = 0;
    rafId = requestAnimationFrame(renderLoop);
  }

  // ------------------------------------------------------------------
  // Render loop
  // ------------------------------------------------------------------

  function renderLoop(timestamp) {
    if (!gl || !game) return;

    // Compute delta time in seconds
    if (lastTimestamp === 0) lastTimestamp = timestamp;
    let deltaTime = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    // Guard against huge deltas (tab was hidden)
    if (deltaTime > 0.25) deltaTime = 0.25;
    if (deltaTime < 0) deltaTime = 0;

    // --- Update game logic ---
    game.update(deltaTime);

    // --- Render ---
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Camera: orbit slowly around the scene, looking at the player
    const camAngle = game.elapsed * 0.15; // slow orbit
    const camX = Math.sin(camAngle) * CAMERA_DISTANCE;
    const camZ = Math.cos(camAngle) * CAMERA_DISTANCE;
    const camY = CAMERA_HEIGHT;

    const eye = [camX, camY, camZ];
    const center = [game.player.x, 0.5, game.player.z];
    const up = [0, 1, 0];

    const aspect = gl.canvas.width / gl.canvas.height;
    const projection = mat4Perspective(FOV, aspect, NEAR, FAR);
    const view = mat4LookAt(eye, center, up);

    // Light follows the player slightly above
    const lightPos = [game.player.x, 4.0, game.player.z];
    const lightIntensity = game.light.intensity;

    // Set shared uniforms
    gl.uniformMatrix4fv(uProjection, false, projection);
    gl.uniformMatrix4fv(uView, false, view);
    gl.uniform3fv(uLightPos, lightPos);
    gl.uniform1f(uLightIntensity, lightIntensity);
    gl.uniform1f(uFogDensity, 0.06);
    gl.uniform3fv(uFogColor, [0.02, 0.02, 0.04]);
    gl.uniform3fv(uCameraPos, eye);

    // --- Draw floor ---
    drawMesh(floorVBO, floorNBO, floorCount, mat4Identity(), [0.15, 0.12, 0.1]);

    // --- Draw rotating cube (the "object") ---
    const cubeModel = mat4Multiply(
      mat4Translate(0, 1.5, 0),
      mat4Multiply(
        mat4RotateY(game.cube.rotation),
        mat4RotateX(game.cube.rotation * 0.7)
      )
    );
    drawMesh(cubeVBO, cubeNBO, cubeCount, cubeModel, [0.6, 0.1, 0.1]);

    // --- Draw monster (a small dark sphere approximated by a scaled cube) ---
    const monsterModel = mat4Multiply(
      mat4Translate(game.monster.x, 0.5, game.monster.z),
      mat4Scale(0.5, 0.5, 0.5)
    );
    drawMesh(cubeVBO, cubeNBO, cubeCount, monsterModel, [0.05, 0.05, 0.05]);

    // --- Continue loop ---
    if (!game.isGameOver()) {
      rafId = requestAnimationFrame(renderLoop);
    }
  }

  /**
   * Draw a mesh with the given VBO/NBO, model matrix, and colour.
   */
  function drawMesh(vbo, nbo, count, modelMatrix, color) {
    gl.uniformMatrix4fv(uModel, false, modelMatrix);
    gl.uniformMatrix3fv(uNormalMatrix, false, mat3NormalFromMat4(modelMatrix));
    gl.uniform3fv(uColor, color);

    // Position attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

    // Normal attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, count);
  }

  // ------------------------------------------------------------------
  // UI helpers
  // ------------------------------------------------------------------

  function updateHealthBar(health, maxHealth) {
    if (healthBarFill) {
      const pct = Math.max(0, (health / maxHealth) * 100);
      healthBarFill.style.width = pct + "%";
      // Shift colour from green to red as health drops
      const hue = (health / maxHealth) * 120; // 120=green, 0=red
      healthBarFill.style.backgroundColor = "hsl(" + hue + ", 80%, 45%)";
    }
    if (healthBarText) {
      healthBarText.textContent = Math.ceil(health) + " / " + maxHealth;
    }
  }

  function triggerFlash() {
    if (!flashEl) return;
    flashEl.classList.remove("flash");
    // Force reflow so the animation restarts
    void flashEl.offsetWidth;
    flashEl.classList.add("flash");
  }

  function showGameOver() {
    if (gameOverEl) {
      gameOverEl.style.display = "flex";
    }
  }

  // ------------------------------------------------------------------
  // Expose for testing / debugging
  // ------------------------------------------------------------------

  window.init = init;
  window.renderLoop = renderLoop;

  // Auto-init when the DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
