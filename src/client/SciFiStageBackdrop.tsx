import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { GameEventType, Phase } from "../game/types";

const BASE_URL = import.meta.env?.BASE_URL ?? "/";
const ASSET_ROOT = `${BASE_URL}assets/ModularSciFiMegaKit`;
const TEXTURE_FILE_PATTERN = /^T_.*\.png$/i;

type StageTone = "setup" | "day" | "night" | "vote" | "summary" | "danger";

interface SciFiStageBackdropProps {
  eventType?: GameEventType;
  phase?: Phase;
  secret?: boolean;
}

interface ToneConfig {
  accent: string;
  secondary: string;
  fill: string;
  alienOpacity: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
}

const toneConfig: Record<StageTone, ToneConfig> = {
  setup: {
    accent: "#35d082",
    secondary: "#5eead4",
    fill: "#062a25",
    alienOpacity: 0.34,
    cameraX: 0.06,
    cameraY: 1.62,
    cameraZ: 7.45
  },
  day: {
    accent: "#35d082",
    secondary: "#67e8f9",
    fill: "#08253a",
    alienOpacity: 0.36,
    cameraX: 0.24,
    cameraY: 1.68,
    cameraZ: 7.25
  },
  night: {
    accent: "#fb7185",
    secondary: "#a78bfa",
    fill: "#210e1a",
    alienOpacity: 0.54,
    cameraX: -0.18,
    cameraY: 1.6,
    cameraZ: 7.1
  },
  vote: {
    accent: "#f59e0b",
    secondary: "#fb7185",
    fill: "#24180a",
    alienOpacity: 0.42,
    cameraX: 0.36,
    cameraY: 1.68,
    cameraZ: 7.2
  },
  summary: {
    accent: "#86efac",
    secondary: "#38bdf8",
    fill: "#082f49",
    alienOpacity: 0.38,
    cameraX: 0,
    cameraY: 1.66,
    cameraZ: 7.42
  },
  danger: {
    accent: "#ef4444",
    secondary: "#f97316",
    fill: "#260c0c",
    alienOpacity: 0.66,
    cameraX: -0.34,
    cameraY: 1.55,
    cameraZ: 7.0
  }
};

function stageToneForEvent(phase: Phase | undefined, eventType: GameEventType | undefined, secret: boolean | undefined): StageTone {
  if (secret || phase === "werewolf_discussion" || phase === "night" || phase === "guard_action" || phase === "seer_action" || phase === "witch_action") {
    return eventType === "death" ? "danger" : "night";
  }
  if (eventType === "death" || eventType === "warning") {
    return "danger";
  }
  if (eventType === "vote_cast" || eventType === "vote_result" || phase === "voting") {
    return "vote";
  }
  if (eventType === "round_summary" || eventType === "game_ended" || phase === "ended") {
    return "summary";
  }
  if (!phase || phase === "setup") {
    return "setup";
  }
  return "day";
}

function assetPath(folder: "Aliens" | "Columns" | "Platforms" | "Props" | "Walls", name: string): string {
  return `${ASSET_ROOT}/glTF/${folder}/${name}.gltf`;
}

function fileNameFromUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  return withoutQuery.substring(withoutQuery.lastIndexOf("/") + 1);
}

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh).isMesh === true;
}

function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && "isTexture" in value) {
      (value as THREE.Texture).dispose();
    }
  }
  material.dispose();
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!isMesh(object)) {
      return;
    }
    object.geometry.dispose();
    for (const material of materialList(object.material)) {
      disposeMaterial(material);
    }
  });
}

function prepareModel(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!isMesh(object)) {
      return;
    }
    object.castShadow = false;
    object.receiveShadow = true;
    for (const material of materialList(object.material)) {
      if (material instanceof THREE.MeshStandardMaterial) {
        const materialName = material.name.toLowerCase();
        material.roughness = Math.max(material.roughness, 0.64);
        material.metalness = Math.min(Math.max(material.metalness, 0.34), 0.88);

        if (materialName.includes("glass")) {
          material.transparent = true;
          material.opacity = 0.34;
          material.depthWrite = false;
          material.color.lerp(new THREE.Color("#92fff0"), 0.38);
          material.roughness = 0.22;
          material.metalness = 0;
        }

        if (materialName.includes("lightfade")) {
          material.transparent = true;
          material.opacity = 0.74;
          material.depthWrite = false;
          material.color.set("#8eff68");
          material.emissive.set("#45ff6d");
          material.emissiveIntensity = 0.9;
        }

        if (materialName === "m_light" || materialName.includes("_light")) {
          material.color.set("#f4fffb");
          material.emissive.set("#dfffee");
          material.emissiveIntensity = Math.max(material.emissiveIntensity, 2.1);
        }
      }
    }
  });
}

function visibleBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();

  root.traverse((object) => {
    if (!isMesh(object) || !object.geometry) {
      return;
    }
    object.geometry.computeBoundingBox();
    const meshBox = object.geometry.boundingBox?.clone();
    if (!meshBox) {
      return;
    }
    meshBox.applyMatrix4(object.matrixWorld);
    box.union(meshBox);
  });

  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
}

function normalizeVisibleHeight(root: THREE.Object3D, targetHeight: number): void {
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);

  const box = visibleBounds(root);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0) {
    root.scale.multiplyScalar(targetHeight / size.y);
  }

  root.updateMatrixWorld(true);
  const scaled = visibleBounds(root);
  root.position.y += -scaled.min.y;
  root.updateMatrixWorld(true);
}

function settleOnFloor(root: THREE.Object3D, floorY = 0): void {
  root.updateMatrixWorld(true);
  const box = visibleBounds(root);
  if (!box.isEmpty()) {
    root.position.y += floorY - box.min.y;
  }
  root.updateMatrixWorld(true);
}

function createGlowBar(width: number, height: number, depth: number, color: string, opacity = 0.9): THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
}

function createMetalPanel(
  width: number,
  height: number,
  depth: number,
  color = "#182228",
  metalness = 0.7,
  roughness = 0.54
): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  return new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      emissive: new THREE.Color(color).multiplyScalar(0.06)
    })
  );
}

function createGlassPane(width: number, height: number, color: string, opacity = 0.16): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
}

function createLiquidSpill(width: number, depth: number, color: string, opacity = 0.24): THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> {
  const spill = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  spill.rotation.x = -Math.PI / 2;
  spill.scale.set(width, depth, 1);
  return spill;
}

function createContainmentGlass(height: number, radius: number, color: string): THREE.Mesh<THREE.CylinderGeometry, THREE.MeshPhysicalMaterial> {
  const material = new THREE.MeshPhysicalMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0.2,
    metalness: 0,
    roughness: 0.14,
    transparent: true,
    opacity: 0.28,
    transmission: 0.46,
    thickness: 0.4,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  return new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.92, height, 40, 1, true), material);
}

function clonePrepared(root: THREE.Object3D): THREE.Object3D {
  const clone = root.clone(true);
  clone.traverse((object) => {
    if (!isMesh(object)) {
      return;
    }
    object.material = Array.isArray(object.material) ? object.material.map((material) => material.clone()) : object.material.clone();
  });
  prepareModel(clone);
  return clone;
}

async function loadPrepared(loader: GLTFLoader, path: string): Promise<GLTF> {
  const gltf = await loader.loadAsync(path);
  prepareModel(gltf.scene);
  return gltf;
}

export function SciFiStageBackdrop({ eventType, phase, secret }: SciFiStageBackdropProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toneRef = useRef<StageTone>(stageToneForEvent(phase, eventType, secret));

  const tone = stageToneForEvent(phase, eventType, secret);
  toneRef.current = tone;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const rootElement = container;

    let disposed = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2("#051017", 0.056);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 90);
    camera.position.set(0.06, 1.62, 7.45);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.domElement.className = "scifi-stage-canvas";
    renderer.domElement.setAttribute("aria-hidden", "true");
    rootElement.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight("#b8fff2", 0.42);
    const hemiLight = new THREE.HemisphereLight("#8bfff1", "#031117", 1.06);
    const keyLight = new THREE.DirectionalLight("#ffffff", 2.35);
    keyLight.position.set(-2.6, 4.8, 4.2);
    const accentLight = new THREE.PointLight("#35d082", 6.2, 17, 1.45);
    accentLight.position.set(2.6, 1.2, 0.1);
    const rearLight = new THREE.PointLight("#70ff76", 5.4, 18, 1.65);
    rearLight.position.set(0, 2.05, -5.3);
    scene.add(ambientLight, hemiLight, keyLight, accentLight, rearLight);

    const stageGroup = new THREE.Group();
    const hologramGroup = new THREE.Group();
    scene.add(stageGroup, hologramGroup);

    const hologramMaterial = new THREE.MeshBasicMaterial({
      color: toneConfig.setup.accent,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const ringGeometry = new THREE.TorusGeometry(0.92, 0.012, 8, 90);
    const ringA = new THREE.Mesh(ringGeometry, hologramMaterial);
    const ringB = new THREE.Mesh(ringGeometry, hologramMaterial);
    ringA.position.set(0.22, 0.075, -1.32);
    ringB.position.copy(ringA.position);
    ringB.scale.setScalar(1.34);
    ringA.rotation.x = Math.PI / 2;
    ringB.rotation.x = Math.PI / 2;
    hologramGroup.add(ringA, ringB);

    const target = new THREE.Vector3(0, 1.2, -1.95);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const name = fileNameFromUrl(url);
      if (TEXTURE_FILE_PATTERN.test(name)) {
        return `${ASSET_ROOT}/Textures/${name}`;
      }
      return url;
    });
    const loader = new GLTFLoader(manager);
    const pulseMaterials: Array<THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial> = [];
    const tankLights: THREE.PointLight[] = [];
    const animatedPods: Array<{ object: THREE.Object3D; baseY: number; baseZ: number }> = [];
    const accentColor = new THREE.Color(toneConfig.setup.accent);

    function addModel(source: GLTF, position: THREE.Vector3, rotation = new THREE.Euler(), scale = 1): THREE.Object3D {
      const object = clonePrepared(source.scene);
      object.position.copy(position);
      object.rotation.copy(rotation);
      object.scale.multiplyScalar(scale);
      settleOnFloor(object, position.y);
      stageGroup.add(object);
      return object;
    }

    function addFloatingModel(source: GLTF, position: THREE.Vector3, rotation = new THREE.Euler(), scale = 1): THREE.Object3D {
      const object = clonePrepared(source.scene);
      object.position.copy(position);
      object.rotation.copy(rotation);
      object.scale.multiplyScalar(scale);
      stageGroup.add(object);
      return object;
    }

    function addNormalizedModel(source: GLTF, position: THREE.Vector3, targetHeight: number, rotation = new THREE.Euler()): THREE.Object3D {
      const object = clonePrepared(source.scene);
      normalizeVisibleHeight(object, targetHeight);
      object.position.copy(position);
      object.rotation.copy(rotation);
      settleOnFloor(object, position.y);
      stageGroup.add(object);
      return object;
    }

    function addGlow(mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>, position: THREE.Vector3, rotation = new THREE.Euler()): void {
      mesh.position.copy(position);
      mesh.rotation.copy(rotation);
      pulseMaterials.push(mesh.material);
      stageGroup.add(mesh);
    }

    function addPanel(mesh: THREE.Mesh, position: THREE.Vector3, rotation = new THREE.Euler()): void {
      mesh.position.copy(position);
      mesh.rotation.copy(rotation);
      stageGroup.add(mesh);
    }

    function addPane(mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>, position: THREE.Vector3, rotation = new THREE.Euler()): void {
      mesh.position.copy(position);
      mesh.rotation.copy(rotation);
      stageGroup.add(mesh);
    }

    function addLiquid(mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>, position: THREE.Vector3, rotationY = 0): void {
      mesh.position.copy(position);
      mesh.rotation.z = rotationY;
      stageGroup.add(mesh);
    }

    function createSpecimenPod(
      holder: GLTF,
      position: THREE.Vector3,
      rotationY: number,
      tiltZ: number,
      height: number,
      radius: number,
      color = "#70ff76"
    ): THREE.Group {
      const pod = new THREE.Group();
      const shell = clonePrepared(holder.scene);
      normalizeVisibleHeight(shell, height);
      pod.add(shell);

      const glass = createContainmentGlass(height * 0.66, radius, color);
      glass.position.y = height * 0.5;
      pulseMaterials.push(glass.material);
      pod.add(glass);

      const liquid = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.92, radius * 0.84, height * 0.5, 40, 1, false),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.13,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      liquid.position.y = height * 0.42;
      pod.add(liquid);

      const baseGlow = new THREE.Mesh(
        new THREE.TorusGeometry(radius * 1.08, 0.015, 8, 64),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.74,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      baseGlow.position.y = height * 0.16;
      baseGlow.rotation.x = Math.PI / 2;
      pulseMaterials.push(baseGlow.material);
      pod.add(baseGlow);

      for (const y of [height * 0.34, height * 0.58]) {
        const scanRing = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 0.9, 0.006, 6, 48),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.46,
            blending: THREE.AdditiveBlending,
            depthWrite: false
          })
        );
        scanRing.position.y = y;
        scanRing.rotation.x = Math.PI / 2;
        pulseMaterials.push(scanRing.material);
        pod.add(scanRing);
      }

      const fillLight = new THREE.PointLight(color, 2.6, 3.2, 1.4);
      fillLight.position.set(0, height * 0.52, 0);
      tankLights.push(fillLight);
      pod.add(fillLight);

      pod.position.copy(position);
      pod.rotation.set(0, rotationY, tiltZ);
      settleOnFloor(pod, position.y);
      animatedPods.push({ object: pod, baseY: rotationY, baseZ: tiltZ });
      stageGroup.add(pod);
      return pod;
    }

    async function buildScene() {
      const [
        floor,
        centerPlate,
        wallWindow,
        wallFlat,
        wallBand,
        topCables,
        topWindow,
        supportColumn,
        largeColumn,
        holder,
        lightWide,
        lightCorner,
        cable,
        cableLong,
        pipeHolder,
        ventWide,
        fan
      ] = await Promise.all([
        loadPrepared(loader, assetPath("Platforms", "Platform_DarkPlates")),
        loadPrepared(loader, assetPath("Platforms", "Platform_CenterPlate")),
        loadPrepared(loader, assetPath("Walls", "WallAstra_Straight_Window")),
        loadPrepared(loader, assetPath("Walls", "WallAstra_Straight_Flat")),
        loadPrepared(loader, assetPath("Walls", "WallBand_Straight")),
        loadPrepared(loader, assetPath("Walls", "TopCables_Straight_Hanging")),
        loadPrepared(loader, assetPath("Walls", "TopWindow_Straight")),
        loadPrepared(loader, assetPath("Columns", "Column_Astra")),
        loadPrepared(loader, assetPath("Columns", "Column_Large_Straight")),
        loadPrepared(loader, assetPath("Props", "Prop_Barrel_Large")),
        loadPrepared(loader, assetPath("Props", "Prop_Light_Wide")),
        loadPrepared(loader, assetPath("Props", "Prop_Light_Corner")),
        loadPrepared(loader, assetPath("Props", "Prop_Cable_1")),
        loadPrepared(loader, assetPath("Props", "Prop_Cable_3")),
        loadPrepared(loader, assetPath("Props", "Prop_PipeHolder")),
        loadPrepared(loader, assetPath("Props", "Prop_Vent_Wide")),
        loadPrepared(loader, assetPath("Props", "Prop_Fan_Small"))
      ]);

      if (disposed) {
        return;
      }

      for (const x of [-4, 0, 4]) {
        for (const z of [-6, -2, 2, 6]) {
          addModel(floor, new THREE.Vector3(x, 0, z));
        }
      }

      addModel(centerPlate, new THREE.Vector3(0.22, 0.015, -1.32), new THREE.Euler(0, 0, 0), 1.08);
      addPanel(createMetalPanel(2.05, 0.045, 9.5, "#101a1f", 0.78, 0.58), new THREE.Vector3(0, 0.035, -0.55));
      addPanel(createMetalPanel(0.08, 0.055, 9.7, "#2a3638", 0.82, 0.48), new THREE.Vector3(-1.18, 0.07, -0.55));
      addPanel(createMetalPanel(0.08, 0.055, 9.7, "#2a3638", 0.82, 0.48), new THREE.Vector3(1.18, 0.07, -0.55));
      addLiquid(createLiquidSpill(0.9, 0.24, "#78ff5f", 0.18), new THREE.Vector3(-0.64, 0.088, 1.28), 0.25);
      addLiquid(createLiquidSpill(0.55, 0.16, "#78ff5f", 0.15), new THREE.Vector3(0.72, 0.09, 0.48), -0.5);
      addLiquid(createLiquidSpill(0.42, 0.12, "#78ff5f", 0.13), new THREE.Vector3(1.45, 0.09, 2.08), 0.18);

      for (const x of [-4, 0, 4]) {
        addModel(wallWindow, new THREE.Vector3(x, 0, -6.35), new THREE.Euler(0, Math.PI / 2, 0));
        addFloatingModel(topWindow, new THREE.Vector3(x, 2.75, -6.32), new THREE.Euler(0, Math.PI / 2, 0), 1);
      }

      addPane(createGlassPane(5.7, 2.15, "#70ff76", 0.13), new THREE.Vector3(0, 1.55, -5.92));
      addPanel(createMetalPanel(6.1, 0.12, 0.16, "#10191f", 0.84, 0.46), new THREE.Vector3(0, 2.66, -5.88));
      addPanel(createMetalPanel(6.1, 0.12, 0.16, "#10191f", 0.84, 0.46), new THREE.Vector3(0, 0.47, -5.88));
      addPanel(createMetalPanel(0.12, 2.2, 0.16, "#10191f", 0.84, 0.46), new THREE.Vector3(-2.93, 1.55, -5.88));
      addPanel(createMetalPanel(0.12, 2.2, 0.16, "#10191f", 0.84, 0.46), new THREE.Vector3(2.93, 1.55, -5.88));
      addGlow(createGlowBar(4.4, 0.025, 0.05, "#a3ff9b", 0.48), new THREE.Vector3(0, 2.54, -5.82));
      addGlow(createGlowBar(3.4, 0.025, 0.05, "#a3ff9b", 0.36), new THREE.Vector3(0, 0.58, -5.82));

      for (const z of [-5.6, -1.8, 2, 5.8]) {
        addModel(wallFlat, new THREE.Vector3(-6.05, 0, z), new THREE.Euler(0, Math.PI, 0));
        addModel(wallFlat, new THREE.Vector3(6.05, 0, z));
        addFloatingModel(wallBand, new THREE.Vector3(-6.08, 1.42, z), new THREE.Euler(0, Math.PI, 0), 0.96);
        addFloatingModel(wallBand, new THREE.Vector3(6.08, 1.42, z), new THREE.Euler(0, 0, 0), 0.96);
      }

      for (const z of [-5.4, -2.2, 1]) {
        addFloatingModel(topCables, new THREE.Vector3(-2.1, 3.1, z), new THREE.Euler(0, Math.PI / 2, 0), 0.9);
        addFloatingModel(topCables, new THREE.Vector3(2.1, 3.1, z), new THREE.Euler(0, -Math.PI / 2, 0), 0.9);
      }

      for (const x of [-2.35, 2.35]) {
        addPanel(createMetalPanel(0.16, 0.13, 10.4, "#0b1217", 0.86, 0.48), new THREE.Vector3(x, 3.08, -1.05));
      }

      for (const z of [-5.55, -3.55, -1.55, 0.45, 2.45]) {
        addPanel(createMetalPanel(5.65, 0.11, 0.16, "#141d22", 0.82, 0.48), new THREE.Vector3(0, 3.1, z));
        addPanel(createMetalPanel(1.55, 0.08, 0.64, "#0e171c", 0.78, 0.52), new THREE.Vector3(-1.2, 3.18, z + 0.34));
        addPanel(createMetalPanel(1.55, 0.08, 0.64, "#0e171c", 0.78, 0.52), new THREE.Vector3(1.2, 3.18, z + 0.34));
      }

      for (const z of [-5.4, -2.2, 1.1, 4.2]) {
        addNormalizedModel(supportColumn, new THREE.Vector3(-4.85, 0, z), 3.25, new THREE.Euler(0, Math.PI, 0));
        addNormalizedModel(supportColumn, new THREE.Vector3(4.85, 0, z), 3.25);
      }

      for (const side of [-1, 1] as const) {
        const inwardTilt = side < 0 ? -0.34 : 0.34;
        addPanel(
          createMetalPanel(0.42, 3.45, 0.42, "#c8d8d5", 0.34, 0.42),
          new THREE.Vector3(side * 4.95, 1.54, -0.55),
          new THREE.Euler(0, 0, inwardTilt)
        );
        addPanel(
          createMetalPanel(0.22, 3.05, 0.2, "#19242a", 0.74, 0.44),
          new THREE.Vector3(side * 4.62, 1.55, -0.58),
          new THREE.Euler(0, 0, inwardTilt)
        );
        addPanel(
          createMetalPanel(2.05, 0.18, 0.58, "#151f24", 0.78, 0.48),
          new THREE.Vector3(side * 4.65, 2.72, -1.02),
          new THREE.Euler(0, side * 0.12, 0)
        );
      }

      for (const x of [-1.65, 1.65]) {
        addNormalizedModel(largeColumn, new THREE.Vector3(x, 0, -5.75), 3.6, new THREE.Euler(0, x < 0 ? Math.PI : 0, 0));
      }

      createSpecimenPod(holder, new THREE.Vector3(-2.85, 0, -1.65), 0.58, 0, 2.2, 0.5);
      createSpecimenPod(holder, new THREE.Vector3(2.85, 0, -2.1), -0.58, 0, 2.22, 0.5);

      addModel(pipeHolder, new THREE.Vector3(-5.15, 0, 3.6), new THREE.Euler(0, Math.PI * 0.78, 0), 0.9);
      addModel(pipeHolder, new THREE.Vector3(5.15, 0, 3.6), new THREE.Euler(0, -Math.PI * 0.78, 0), 0.9);
      addModel(ventWide, new THREE.Vector3(-2.6, 0, 5.55), new THREE.Euler(0, 0.3, 0), 0.82);
      addModel(ventWide, new THREE.Vector3(2.6, 0, 5.55), new THREE.Euler(0, -0.3, 0), 0.82);
      addFloatingModel(fan, new THREE.Vector3(0, 2.98, -4.2), new THREE.Euler(Math.PI / 2, 0, 0), 0.74);

      for (const x of [-2.2, 2.1]) {
        addModel(cable, new THREE.Vector3(x, 0.035, 3.55), new THREE.Euler(0, x < 0 ? 0.55 : -0.35, 0));
        addModel(cableLong, new THREE.Vector3(x * 0.82, 0.04, 1.95), new THREE.Euler(0, x < 0 ? -0.18 : 0.22, 0), 0.95);
      }

      for (const z of [-5.3, -2.15, 1.1]) {
        addFloatingModel(lightWide, new THREE.Vector3(0, 2.95, z), new THREE.Euler(0, Math.PI / 2, 0), 0.95);
        addGlow(createGlowBar(2.5, 0.035, 0.08, "#f4fffb", 0.78), new THREE.Vector3(0, 2.78, z + 0.08));
      }

      for (const [x, rotY] of [[-5.65, Math.PI], [5.65, 0]] as const) {
        for (const z of [-3.9, 0.2]) {
          addFloatingModel(lightCorner, new THREE.Vector3(x, 2.25, z), new THREE.Euler(0, rotY, 0), 0.82);
        }
      }

      for (const x of [-2.45, 2.45]) {
        addGlow(createGlowBar(0.08, 0.026, 9.7, "#72ff63", 0.64), new THREE.Vector3(x, 0.07, -0.85));
      }

      for (const z of [-5.45, -1.85, 1.75]) {
        addGlow(createGlowBar(3.2, 0.024, 0.06, "#ecfffb", 0.66), new THREE.Vector3(0, 3.04, z));
      }

      rootElement.dataset.stageReady = "true";
    }

    buildScene().catch(() => {
      if (!disposed) {
        rootElement.dataset.stageReady = "false";
      }
    });

    const resize = () => {
      const width = rootElement.clientWidth;
      const height = rootElement.clientHeight;
      if (width <= 0 || height <= 0) {
        return;
      }
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(rootElement);
    resize();

    const timer = new THREE.Timer();
    timer.connect(document);
    renderer.setAnimationLoop((timestamp) => {
      timer.update(timestamp);
      const dt = Math.min(timer.getDelta(), 0.05);
      const elapsed = timer.getElapsed();
      const config = toneConfig[toneRef.current];

      scene.fog?.color.set(config.fill);
      ambientLight.color.set(config.secondary);
      hemiLight.color.set(config.secondary);
      keyLight.color.set(config.accent);
      accentLight.color.set(config.accent);
      rearLight.color.set(config.accent);
      hologramMaterial.color.set(config.accent);
      accentColor.set(config.accent);

      const pulse = 0.78 + Math.sin(elapsed * 1.7) * 0.12;
      accentLight.intensity = 4.8 + pulse * 1.8;
      rearLight.intensity = 3.4 + pulse * 1.2;
      for (const [index, material] of pulseMaterials.entries()) {
        material.color.copy(accentColor);
        material.opacity = material instanceof THREE.MeshPhysicalMaterial ? 0.18 + pulse * 0.1 : 0.54 + pulse * 0.22;
        if (material instanceof THREE.MeshPhysicalMaterial) {
          material.emissive.copy(accentColor);
          material.emissiveIntensity = 0.12 + pulse * 0.12;
        }
        if (index % 3 === 0) {
          material.opacity *= 0.84;
        }
      }
      for (const light of tankLights) {
        light.color.copy(accentColor);
        light.intensity = 2 + pulse * 1.15;
      }

      if (!reducedMotion) {
        stageGroup.rotation.y = Math.sin(elapsed * 0.12) * 0.025;
        ringA.rotation.z += dt * 0.18;
        ringB.rotation.z -= dt * 0.11;
        for (const [index, pod] of animatedPods.entries()) {
          pod.object.rotation.y = pod.baseY + Math.sin(elapsed * 0.28 + index) * 0.012;
          pod.object.rotation.z = pod.baseZ;
        }
      }

      camera.position.x += (config.cameraX + Math.sin(elapsed * 0.1) * 0.16 - camera.position.x) * 0.025;
      camera.position.y += (config.cameraY - camera.position.y) * 0.025;
      camera.position.z += (config.cameraZ - camera.position.z) * 0.025;
      camera.lookAt(target);
      renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      timer.dispose();
      if (renderer.domElement.parentNode === rootElement) {
        rootElement.removeChild(renderer.domElement);
      }
      disposeObject(scene);
      ringGeometry.dispose();
      hologramMaterial.dispose();
      renderer.dispose();
    };
  }, []);

  return <div className="chapel-backdrop scifi-stage-backdrop" data-stage-tone={tone} ref={containerRef} aria-hidden="true" />;
}
