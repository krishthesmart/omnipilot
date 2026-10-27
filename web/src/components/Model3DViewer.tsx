import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { Download, Layers, RotateCw, Grid3x3 } from "lucide-react";
import type { Model3D, Model3DPart } from "../types";

// ModelPilot's interactive viewer: orbit/zoom, click a part (or pick it in the list) to read what
// it does, Explode to pull the parts apart, wireframe, auto-rotate, and STL/GLB export.

const MATERIAL: Record<Model3DPart["material"], { roughness: number; metalness: number; opacity?: number; emissive?: boolean }> = {
  plastic: { roughness: 0.45, metalness: 0.05 },
  metal: { roughness: 0.25, metalness: 0.9 },
  glass: { roughness: 0.05, metalness: 0, opacity: 0.35 },
  rubber: { roughness: 0.95, metalness: 0 },
  wood: { roughness: 0.8, metalness: 0 },
  matte: { roughness: 1, metalness: 0 },
  emissive: { roughness: 0.4, metalness: 0, emissive: true },
};

function geometry(p: Model3DPart): THREE.BufferGeometry {
  const s = p.size;
  switch (p.shape) {
    case "box":
      return new THREE.BoxGeometry(s[0], s[1], s[2]);
    case "sphere":
      return new THREE.SphereGeometry(s[0], 32, 20);
    case "cylinder":
      return new THREE.CylinderGeometry(s[0], s[2] ?? s[0], s[1], 32);
    case "cone":
      return new THREE.ConeGeometry(s[0], s[1], 32);
    case "torus":
      return new THREE.TorusGeometry(s[0], s[1], 16, 48);
    case "capsule":
      return new THREE.CapsuleGeometry(s[0], s[1], 8, 16);
  }
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Model3DViewer({ model }: { model: Model3D }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const meshes = useRef(new Map<string, THREE.Mesh>());
  const groupRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);
  const [wire, setWire] = useState(false);
  const [spin, setSpin] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Model centre and size, for the exploded view and the camera.
  const { center, size } = useMemo(() => {
    const box = new THREE.Box3();
    for (const p of model.parts) box.expandByPoint(new THREE.Vector3(...p.position));
    const c = box.getCenter(new THREE.Vector3());
    const sz = box.getSize(new THREE.Vector3());
    return { center: c, size: Math.max(sz.x, sz.y, sz.z, 0.1) };
  }, [model]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      setError("3D isn't available in this browser (WebGL is off).");
      return;
    }
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(dark ? "#14171c" : "#f3f5f8");
    const width = mount.clientWidth || 600;
    const height = Math.round(Math.min(480, width * 0.7));
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(45, width / height, size / 1000, size * 100);
    camera.position.set(center.x + size * 1.4, center.y + size * 0.9, center.z + size * 1.6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.2;
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x222233 : 0x99a0aa, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(size * 2, size * 4, size * 3);
    sun.castShadow = true;
    scene.add(sun);
    if (!model.separate) {
      const floor = new THREE.Mesh(new THREE.CircleGeometry(size * 1.6, 64), new THREE.ShadowMaterial({ opacity: 0.18 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);
      const grid = new THREE.GridHelper(size * 3, 30, dark ? 0x334 : 0xccd, dark ? 0x223 : 0xdde);
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.35;
      scene.add(grid);
    }

    const group = new THREE.Group();
    group.name = model.title;
    meshes.current.clear();
    for (const p of model.parts) {
      const m = MATERIAL[p.material] ?? MATERIAL.plastic;
      const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: m.roughness, metalness: m.metalness, transparent: m.opacity !== undefined, opacity: m.opacity ?? 1, emissive: m.emissive ? new THREE.Color(p.color) : undefined, emissiveIntensity: m.emissive ? 0.8 : 0 });
      const mesh = new THREE.Mesh(geometry(p), mat);
      mesh.name = p.name;
      mesh.position.set(...p.position);
      mesh.rotation.set(...(p.rotation.map((d) => (d * Math.PI) / 180) as [number, number, number]));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { id: p.id, home: mesh.position.clone() };
      meshes.current.set(p.id, mesh);
      group.add(mesh);
    }
    scene.add(group);
    groupRef.current = group;

    // Frame the whole model (real extents, with room to explode it) in view.
    const fit = new THREE.Box3().setFromObject(group);
    const fitSize = fit.getSize(new THREE.Vector3());
    const fitCenter = fit.getCenter(new THREE.Vector3());
    const span = Math.max(fitSize.x, fitSize.y, fitSize.z, 0.1);
    const distance = (span * 1.25) / Math.tan(((camera.fov / 2) * Math.PI) / 180);
    camera.near = span / 1000;
    camera.far = span * 200;
    camera.position.copy(fitCenter).add(new THREE.Vector3(0.75, 0.5, 0.95).normalize().multiplyScalar(distance));
    camera.updateProjectionMatrix();
    controls.target.copy(fitCenter);
    controls.maxDistance = distance * 4;

    // Click to select a part.
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag, not a click
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(pointer, camera);
      const hit = ray.intersectObjects(group.children)[0];
      setSelected(hit ? (hit.object.userData.id as string) : null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    controls.addEventListener("start", () => setSpin(false));

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    const onResize = () => {
      const w = mount.clientWidth || width;
      const h = Math.round(Math.min(480, w * 0.7));
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [model, center, size]);

  // Exploded view: each part moves away from the centre.
  useEffect(() => {
    for (const mesh of meshes.current.values()) {
      const home = mesh.userData.home as THREE.Vector3;
      const dir = home.clone().sub(center);
      mesh.position.copy(home.clone().add(dir.multiplyScalar(explode * 1.2)));
    }
  }, [explode, center]);

  // Highlight the selected part; fade the rest a little.
  useEffect(() => {
    for (const [id, mesh] of meshes.current) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const base = MATERIAL[model.parts.find((p) => p.id === id)?.material ?? "plastic"];
      mat.wireframe = wire;
      mat.emissive = id === selected ? new THREE.Color("#3b82f6") : base.emissive ? new THREE.Color(mat.color) : new THREE.Color("#000000");
      mat.emissiveIntensity = id === selected ? 0.55 : base.emissive ? 0.8 : 0;
      mat.transparent = selected !== null ? id !== selected || base.opacity !== undefined : base.opacity !== undefined;
      mat.opacity = selected !== null && id !== selected ? 0.35 : (base.opacity ?? 1);
      mat.needsUpdate = true;
    }
  }, [selected, wire, model]);

  useEffect(() => {
    if (controlsRef.current) controlsRef.current.autoRotate = spin;
  }, [spin]);

  const part = model.parts.find((p) => p.id === selected);
  const groups = useMemo(() => {
    const g = new Map<string, Model3DPart[]>();
    for (const p of model.parts) g.set(p.group, [...(g.get(p.group) ?? []), p]);
    return [...g];
  }, [model]);
  const fileName = model.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";

  function exportStl() {
    if (!groupRef.current) return;
    download(`${fileName}.stl`, new STLExporter().parse(groupRef.current, { binary: true }) as DataView<ArrayBuffer>, "model/stl");
  }
  function exportGlb() {
    if (!groupRef.current) return;
    new GLTFExporter().parse(groupRef.current, (out) => download(`${fileName}.glb`, out as ArrayBuffer, "model/gltf-binary"), () => setError("Couldn't export GLB."), { binary: true });
  }

  if (error) return <div className="model3d-error">{error}</div>;
  return (
    <div className="model3d">
      <div className="model3d-stage" ref={mountRef} aria-label={`Interactive 3D model: ${model.title}`} />
      <div className="model3d-toolbar">
        <label className="model3d-explode">
          <Layers size={14} /> Explode
          <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
        </label>
        <button className={wire ? "on" : ""} onClick={() => setWire(!wire)} title="Wireframe">
          <Grid3x3 size={14} /> Wireframe
        </button>
        <button className={spin ? "on" : ""} onClick={() => setSpin(!spin)} title="Auto-rotate">
          <RotateCw size={14} /> Spin
        </button>
        <button onClick={exportStl} title="Download for 3D printing">
          <Download size={14} /> STL
        </button>
        <button onClick={exportGlb} title="Download for 3D apps">
          <Download size={14} /> GLB
        </button>
      </div>
      <div className="model3d-info">
        {part ? (
          <div className="model3d-part">
            <strong>{part.name}</strong> <span className="model3d-group">{part.group}</span>
            <p>{part.description || "No description."}</p>
          </div>
        ) : (
          <p className="model3d-hint">Click a part, or choose one below, to see what it does.</p>
        )}
        <details className="model3d-list">
          <summary>
            All {model.parts.length} parts ({model.units})
          </summary>
          {groups.map(([g, parts]) => (
            <div key={g} className="model3d-list-group">
              <span>{g}</span>
              {parts.map((p) => (
                <button key={p.id} className={p.id === selected ? "on" : ""} onClick={() => setSelected(p.id === selected ? null : p.id)}>
                  <i style={{ background: p.color }} /> {p.name}
                </button>
              ))}
            </div>
          ))}
        </details>
      </div>
    </div>
  );
}
